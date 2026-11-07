import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { own_file } from '../own.ts';
import { LEAST_UPPER_BOUND, TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import type { SourceMapInput } from '@jridgewell/trace-mapping';
import { instrument } from '../transform/instrument.ts';
import { load_prices } from '../prices.ts';
import type { FunctionMeta } from '../meta.ts';
import { ProcessError, run_process } from '../proc.ts';
import { fn_key, parse_v8_log } from './log.ts';
import type { LogFacts, LogFunction } from './log.ts';
import type { ChildConfig, ChildModule, ChildResult } from './child.ts';
import { merge_runs, same_runs, unstable_entries } from './stability.ts';
import { ENGINE_SCHEMA, IC_RANK, TIER_RANK, is_optimized } from './types.ts';
import type {
	EngineCase,
	EngineDeopt,
	EngineFunction,
	EngineReport,
	EngineSite,
	IcState,
	Tier
} from './types.ts';
import { is_cold } from './diff.ts';

const CHILD = own_file('engine/child');

/**
 * Flags of the health child. Single-threaded, no concurrent recompilation and no bytecode flushing:
 * V8 tiers code up at the same points on every run.
 *
 * The garbage collector is the other half. A collection kills maps and closure contexts that
 * optimized code points at and changes the representation of strings that inline caches see, so
 * what V8 reports depends on when one runs; on V8's own schedule that follows the clock
 * (incremental marking paces itself by elapsed time, the heap limit and the young generation's
 * size by measured speeds), so it moves from run to run. A large initial old space keeps full
 * collections out of a normal protocol altogether, and a young generation of one fixed size
 * makes young collections follow allocation alone. If a case allocates past the old space
 * anyway, the collection is atomic (no incremental marking) and moves nothing (no compaction),
 * so maps keep the addresses the inline-cache log names them by.
 */
export const HEALTH_FLAGS = [
	'--no-warnings',
	'--allow-natives-syntax',
	'--no-concurrent-recompilation',
	'--single-threaded',
	'--predictable',
	'--no-flush-bytecode',
	'--initial-old-space-size=1024',
	'--min-semi-space-size=16',
	'--max-semi-space-size=16',
	'--no-incremental-marking',
	'--no-compact',
	'--random-seed=1',
	'--hash-seed=1',
	'--log-code',
	'--log-ic',
	'--log-deopt',
	'--log-function-events',
	'--no-logfile-per-isolate'
];

export interface HealthOptions {
	files: string[];
	root?: string;
	/** Only cases whose name contains this. */
	filter?: string;
	/** Runs before the fixed point (default 20). */
	warmup?: number;
	/** Runs after the forced optimization (default 3). */
	runs?: number;
	/** Run every case twice and compare (default true). */
	check?: boolean;
	/**
	 * Extra runs of a case whose first two runs differ (default 2), so every function and site that
	 * varies shows up and is marked unstable.
	 */
	retries?: number;
	/** Time limit of one child run (default 10 minutes): past it, the case fails. */
	timeout_ms?: number;
	deps?: boolean | string[];
	svelte?: 'server' | 'client';
	log?: (line: string) => void;
}

interface Child {
	result: ChildResult;
	log: string;
}

const CHILD_TIMEOUT_MS = 10 * 60 * 1000;

async function spawn_child(
	dir: string,
	config: Omit<ChildConfig, 'out'>,
	tag: string,
	timeout_ms: number
): Promise<Child> {
	const out = join(dir, `${tag}.json`);
	const logfile = join(dir, `${tag}.log`);
	const config_file = join(dir, `${tag}.config.json`);
	writeFileSync(config_file, JSON.stringify({ ...config, out }));
	try {
		await run_process(
			process.execPath,
			[...HEALTH_FLAGS, `--logfile=${logfile}`, CHILD, config_file],
			{ cwd: config.root, timeout_ms, max_buffer: 1 << 26 }
		);
	} catch (e) {
		if (e instanceof ProcessError && e.timed_out)
			throw new Error(`heisenbench health: the child ${e.message} (killed)`);
		const err = e as { stderr?: string; message: string };
		throw new Error(`heisenbench health: the child failed: ${(err.stderr || err.message).trim()}`);
	}
	const result = JSON.parse(readFileSync(out, 'utf8')) as ChildResult;
	const log = config.case ? readFileSync(logfile, 'latin1') : '';
	return { result, log };
}

// ------------------------------------------------------------------ decoding

const IC_KIND: Record<string, string> = {
	LoadIC: 'property read',
	StoreIC: 'property write',
	KeyedLoadIC: 'keyed read',
	KeyedStoreIC: 'keyed write',
	KeyedHasIC: 'keyed in',
	LoadGlobalIC: 'global read',
	StoreGlobalIC: 'global write',
	StoreInArrayLiteralIC: 'array literal write',
	DefineNamedOwnIC: 'property define',
	DefineKeyedOwnIC: 'keyed define'
};

const KEYED = new Set([
	'KeyedLoadIC',
	'KeyedStoreIC',
	'KeyedHasIC',
	'StoreInArrayLiteralIC',
	'DefineKeyedOwnIC'
]);

const STATES: Record<string, IcState> = {
	X: 'no feedback',
	'0': 'uninitialized',
	'1': 'monomorphic',
	'^': 'monomorphic',
	P: 'polymorphic',
	N: 'megamorphic',
	G: 'generic'
};

/** `symbol("Symbol.iterator" hash 19d909b0)` -> `[Symbol.iterator]`; names stay as they are. */
function key_label(key: string): string {
	if (!key.startsWith('symbol(')) return key;
	const open = key.indexOf('"');
	const close = open === -1 ? -1 : key.indexOf('"', open + 1);
	return close === -1 ? '[symbol]' : `[${key.slice(open + 1, close)}]`;
}

interface FnTable {
	metas: FunctionMeta[];
	/** Generated start offset of each meta function. */
	starts: number[];
	/** Meta indexes sorted by start. */
	order: number[];
	lines: number[];
	map: TraceMap | null;
}

function line_starts(code: string): number[] {
	const starts = [0];
	for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) starts.push(i + 1);
	return starts;
}

function line_of(starts: number[], offset: number): number {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo + 1;
}

function fn_table(m: ChildModule): FnTable {
	const p = load_prices();
	const r = instrument(m.code, {
		id: m.id,
		filename: m.path.endsWith('.svelte') ? m.path + '.js' : m.path,
		lang: 'js',
		prices: p.prices,
		prices_hash: p.hash,
		module_specifier: 'heisenbench:health',
		expose: false
	});
	const lines = line_starts(m.code);
	const metas = r.meta.functions;
	const starts = metas.map((f) => (lines[f.line - 1] ?? 0) + f.col);
	const order = metas.map((_, i) => i).sort((a, b) => starts[a] - starts[b] || a - b);
	return {
		metas,
		starts,
		order,
		lines,
		map: m.map ? new TraceMap(m.map as SourceMapInput) : null
	};
}

/** Innermost function containing a generated offset (latest start whose lines still cover it). */
function meta_at(t: FnTable, offset: number): number {
	const line = line_of(t.lines, offset);
	let best = -1;
	for (const i of t.order) {
		if (t.starts[i] > offset) break;
		if (t.metas[i].end_line >= line || t.metas[i].kind === 'top') best = i;
	}
	return best;
}

/** Generated 1-based line/col -> original 1-based line/col. */
function original(t: FnTable, line: number, col: number): [number, number] {
	if (!t.map) return [line, col];
	const column = Math.max(0, col - 1);
	let o = originalPositionFor(t.map, { line, column });
	if (o.line == null) o = originalPositionFor(t.map, { line, column, bias: LEAST_UPPER_BOUND });
	// compiler-made code (Svelte's helpers) maps nowhere: 0, and the caller picks a fallback
	return o.line == null ? [0, 0] : [o.line, (o.column ?? 0) + 1];
}

interface FnAcc {
	meta: FunctionMeta;
	module: number;
	tier: Tier;
	forced: boolean;
	on_path: boolean;
	deopts: Map<string, EngineDeopt>;
	/** Some code of it was optimized (Maglev or TurboFan) at some point. */
	had_optimized: boolean;
}

/** Tier from the log alone: the last non-OSR code, unless a later deopt took it away. */
function logged_tier(f: LogFunction, facts: LogFacts): Tier {
	let last: LogFunction['codes'][number] | null = null;
	for (const c of f.codes) if (!c.osr) last = c;
	if (!last) return 'not compiled';
	if (last.tier === 'maglev' || last.tier === 'turbofan') {
		const address = last.address;
		if (facts.deopts.some((d) => d.address === address)) return 'deoptimized';
	}
	return last.tier;
}

/**
 * Why a function is not optimized (EngineFunction.not_optimized): it lost optimized code; it was
 * forced to optimize and V8 did not; or it simply never ran hot enough (cold).
 */
export function why_not_optimized(
	tier: Tier,
	had_optimized: boolean,
	forced: boolean,
	deopts: readonly EngineDeopt[]
): 'cold' | 'refused' | 'deoptimized' {
	if (tier === 'deoptimized' || had_optimized) return 'deoptimized';
	if (forced) return 'refused';
	if (deopts.some((d) => !is_cold(d.reason))) return 'deoptimized';
	return 'cold';
}

function had_optimized(f: LogFunction): boolean {
	return f.codes.some((c) => c.tier === 'maglev' || c.tier === 'turbofan');
}

/** Decode one child run into the case report. */
export function analyze(child: Child, name: string, file: string): EngineCase {
	const { result } = child;
	const kase: EngineCase = {
		name,
		file,
		stable: true,
		error: result.error,
		functions: [],
		sites: []
	};
	const modules = result.modules;
	const facts = parse_v8_log(
		child.log,
		modules.map((m) => ({ url: m.url, path: m.path, code: m.code }))
	);
	const tables = modules.map(fn_table);
	const reach = new Map<string, Tier>();
	for (const r of result.reachable) {
		const mi = facts.scripts.get(r.script_id);
		if (mi !== undefined) reach.set(fn_key(mi, r.position), r.tier);
	}

	const accs = new Map<string, FnAcc>();
	const acc_of = (module: number, offset: number): FnAcc | null => {
		const t = tables[module];
		const mi = offset === 0 ? t.metas.findIndex((f) => f.kind === 'top') : meta_at(t, offset);
		if (mi < 0) return null;
		const key = `${module}:${mi}`;
		let a = accs.get(key);
		if (!a) {
			a = {
				meta: t.metas[mi],
				module,
				tier: 'not compiled',
				forced: false,
				on_path: false,
				deopts: new Map(),
				had_optimized: false
			};
			accs.set(key, a);
		}
		return a;
	};

	// V8 function -> heisenbench function, with its tier
	const owner = new Map<string, FnAcc>();
	for (const [key, f] of facts.functions) {
		const a = acc_of(f.module, f.offset);
		if (!a) continue;
		owner.set(key, a);
		const forced_tier = reach.get(key);
		let tier: Tier;
		if (forced_tier !== undefined) {
			// forced to optimize: not optimized now, after having been, means it was thrown out
			a.forced = true;
			tier = !is_optimized(forced_tier) && had_optimized(f) ? 'deoptimized' : forced_tier;
		} else {
			tier = logged_tier(f, facts);
		}
		if (a.tier === 'not compiled' || tier === 'deoptimized' || TIER_RANK[tier] > TIER_RANK[a.tier])
			a.tier = tier;
		if (had_optimized(f)) a.had_optimized = true;
		if (f.in_window || is_optimized(tier)) a.on_path = true;
	}

	for (const d of facts.deopts) {
		let a: FnAcc | null = null;
		let line = 0;
		if (d.at) {
			const t = tables[d.at.module];
			const off = (t.lines[d.at.line - 1] ?? 0) + d.at.col - 1;
			a = acc_of(d.at.module, off);
			line = original(t, d.at.line, d.at.col)[0];
		}
		if (!a && d.module >= 0) a = owner.get(fn_key(d.module, d.fn)) ?? null;
		if (!a) continue;
		const k = `${d.reason}\n${d.kind}\n${line}`;
		const e = a.deopts.get(k);
		if (e) e.count++;
		else a.deopts.set(k, { reason: d.reason, kind: d.kind, line, count: 1 });
	}

	const fn_id = (a: FnAcc): string => `${modules[a.module].id} > ${a.meta.path}`;
	const fn_line = (a: FnAcc): number => {
		const t = tables[a.module];
		const at = original(t, a.meta.line, a.meta.col + 1)[0];
		if (at !== 0) return at;
		// a compiler-made function start: the first line of its body that maps to the source
		for (let l = a.meta.line + 1; l <= a.meta.end_line; l++) {
			const o = original(t, l, 1)[0];
			if (o !== 0) return o;
		}
		return 0;
	};

	// sites: worst state per inline cache of an on-path function
	interface SiteAcc {
		fn: FnAcc;
		type: string;
		line: number;
		col: number;
		key: string;
		state: IcState;
		maps: Set<string>;
		/** The keys a keyed site saw (the log's key field: a property name or an index). */
		keys: Set<string>;
	}
	const sites = new Map<string, SiteAcc>();
	for (const ic of facts.ics) {
		const a = owner.get(fn_key(ic.module, ic.fn));
		if (!a || !a.on_path) continue;
		const state = STATES[ic.state];
		if (state === undefined) continue;
		const k = `${ic.module}:${ic.fn}:${ic.type}:${ic.line}:${ic.col}`;
		let s = sites.get(k);
		if (!s) {
			let [line, col] = original(tables[ic.module], ic.line, ic.col);
			if (line === 0) [line, col] = [fn_line(a), 0];
			s = {
				fn: a,
				type: ic.type,
				line,
				col,
				key: KEYED.has(ic.type) ? '[]' : key_label(ic.key),
				state,
				maps: new Set(),
				keys: new Set()
			};
			sites.set(k, s);
		}
		if (IC_RANK[state] > IC_RANK[s.state] || (state === 'megamorphic' && s.state === 'generic'))
			s.state = state;
		if (ic.map && ic.map !== '0x0' && ic.map !== '0') s.maps.add(ic.map);
		if (KEYED.has(ic.type) && ic.key !== '') s.keys.add(ic.key);
	}

	const deopted = new Set(facts.deopts.map((d) => d.address));
	const inlined = new Set<FnAcc>();
	for (const r of facts.inlined) {
		if (deopted.has(r.address)) continue;
		for (const k of r.fns) {
			const a = owner.get(k);
			if (a) inlined.add(a);
		}
	}

	for (const a of accs.values()) {
		if (!a.on_path || a.meta.kind === 'top') continue;
		const optimized = is_optimized(a.tier) || inlined.has(a);
		const deopts = [...a.deopts.values()].sort(
			(x, y) => x.line - y.line || (x.reason < y.reason ? -1 : x.reason > y.reason ? 1 : 0)
		);
		const fn: EngineFunction = {
			id: fn_id(a),
			module: modules[a.module].id,
			path: a.meta.path,
			line: fn_line(a),
			tier: a.tier,
			inlined: inlined.has(a),
			optimized,
			forced: a.forced,
			deopts
		};
		if (!optimized) fn.not_optimized = why_not_optimized(a.tier, a.had_optimized, a.forced, deopts);
		kase.functions.push(fn);
	}
	kase.functions.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

	const by_fn = new Map<FnAcc, SiteAcc[]>();
	for (const s of sites.values()) {
		if (IC_RANK[s.state] === 0) continue;
		const list = by_fn.get(s.fn) ?? [];
		list.push(s);
		by_fn.set(s.fn, list);
	}
	for (const [a, list] of by_fn) {
		list.sort((x, y) => x.line - y.line || x.col - y.col);
		const seen = new Map<string, number>();
		for (const s of list) {
			const kind = IC_KIND[s.type] ?? s.type;
			const label = `${kind} ${s.key}`;
			const n = seen.get(label) ?? 0;
			seen.set(label, n + 1);
			const site: EngineSite = {
				id: `${fn_id(a)} > ${label} #${n}`,
				function: fn_id(a),
				module: modules[a.module].id,
				line: s.line,
				col: s.col,
				kind,
				key: s.key,
				state: s.state,
				maps: s.maps.size
			};
			if (KEYED.has(s.type)) site.keys = s.keys.size;
			if (IC_RANK[s.state] >= IC_RANK.megamorphic) {
				// V8 keeps one property name per keyed cache: a second name makes it megamorphic on a
				// single shape. More shapes than a polymorphic cache holds (4) is the other cause.
				site.cause = KEYED.has(s.type) && s.keys.size > 1 && s.maps.size <= 4 ? 'keys' : 'shapes';
			}
			kase.sites.push(site);
		}
	}
	kase.sites.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
	return kase;
}

/**
 * Engine health of every case: one child per case, twice to check determinism. When the two
 * differ, `retries` more runs find everything that varies, and the merged case marks those
 * functions and sites unstable (stability.ts) instead of failing the whole case.
 */
export async function engine_health(opts: HealthOptions): Promise<EngineReport> {
	const root = resolve(opts.root ?? process.cwd());
	const log = opts.log ?? (() => {});
	const warmup = opts.warmup ?? 20;
	const runs = opts.runs ?? 3;
	const dir = mkdtempSync(join(tmpdir(), 'heisenbench-health-'));
	const base: Omit<ChildConfig, 'out'> = {
		root,
		files: opts.files.map((f) => resolve(f)),
		case: null,
		warmup,
		runs,
		deps: opts.deps ?? false,
		svelte: opts.svelte ?? 'server'
	};
	const report: EngineReport = {
		schema: ENGINE_SCHEMA,
		node: process.version,
		v8: process.versions.v8,
		flags: HEALTH_FLAGS.filter((f) => f !== '--no-warnings'),
		warmup,
		runs,
		cases: []
	};
	const timeout = opts.timeout_ms ?? CHILD_TIMEOUT_MS;
	const retries = opts.retries ?? 2;
	try {
		const listed = await spawn_child(dir, base, 'list', timeout);
		const seen = new Map<string, number>();
		let tag = 0;
		for (const c of listed.result.cases) {
			const index = seen.get(c.name) ?? 0;
			seen.set(c.name, index + 1);
			if (opts.filter && !c.name.includes(opts.filter)) continue;
			const config = { ...base, case: { name: c.name, index } };
			const once = async (): Promise<EngineCase> => {
				const child = await spawn_child(dir, config, `case${tag}`, timeout);
				rmSync(join(dir, `case${tag++}.log`), { force: true });
				return analyze(child, c.name, c.file);
			};
			let kase: EngineCase;
			try {
				const runs = [await once()];
				if (opts.check ?? true) {
					runs.push(await once());
					// they differ: more runs, so that every entry that varies is caught
					if (!same_runs(runs[0], runs[1]))
						for (let i = 0; i < retries; i++) runs.push(await once());
				}
				kase = merge_runs(runs);
			} catch (e) {
				kase = {
					name: c.name,
					file: c.file,
					stable: false,
					error: e instanceof Error ? e.message : String(e),
					functions: [],
					sites: []
				};
			}
			report.cases.push(kase);
			const optimized = kase.functions.filter((f) => f.optimized).length;
			const cold = kase.functions.filter((f) => f.not_optimized === 'cold').length;
			const lost = kase.functions.length - optimized - cold;
			const bad = kase.sites.filter((s) => IC_RANK[s.state] >= 2).length;
			const u = unstable_entries(kase);
			const shaky =
				u.functions + u.sites > 0
					? `; not repeatable in ${kase.repeats} runs: ${u.functions} function(s), ${u.sites} site(s) (marked unstable)`
					: '';
			log(
				`${kase.error ? 'FAILED  ' : kase.stable ? 'ok      ' : 'UNSTABLE'} ${c.name}  ${optimized}/${kase.functions.length} optimized, ${cold} cold, ${lost} refused or deoptimized, ${bad} poly/megamorphic site(s)${shaky}${kase.error ? ': ' + kase.error : ''}`
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	return report;
}
