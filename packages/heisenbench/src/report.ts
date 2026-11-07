import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_SLOTS, BUILTIN_UNIT_SHIFT, EDGE_KEY_SHIFT } from './runtime/index.ts';
import type { Runtime, Snapshot } from './runtime/index.ts';
import { OP_KINDS, op_price_vector } from './prices.ts';
import { BUILTIN_TERMS, DYNAMIC_PRICE, add_unit, add_units, op_units } from './units.ts';
import type { Units } from './units.ts';
import type { CaseMeasure } from './measure/types.ts';
import type { EngineReport } from './engine/types.ts';
import type { GrowthReport } from './growth/index.ts';
import type { RecordedGrowthReport } from './growth/recorded.ts';
import type { SearchReport } from './search/index.ts';
import type { AuditReport } from './audit/fit.ts';
import type { ContractReport } from './contracts/index.ts';
import { OWN_DIR, package_url } from './own.ts';
import type { CacheSummary } from './cache/index.ts';

/*
 * The report (JSON, versioned). One entry per bench case; inside, every function the case ran.
 *
 * Identity: a function is `module > path` (`router/match.ts > Router > match`); a block is its
 * function id plus the block index (`router/match.ts > Router > match > block 4`). Lines are
 * original source lines (TS, .svelte), and are what the PR vs base diff maps through git.
 *
 * self_steps     = sum(block count * block price) + dynamic costs (spread, strings, rest)
 *                  + priced built-in calls made by the function
 * inclusive_steps = every step run while the function was on the shadow stack (once if recursive)
 * allocations    = allocation sites executed (a site runs once per run of its block)
 * bytes          = estimated V8 bytes of those allocations (layout.ts)
 */

export const REPORT_SCHEMA = 'heisenbench-report/1';

export interface BlockReport {
	/** Stable identity: `module > function path > block index`. */
	id: string;
	/** Block index inside the function. */
	index: number;
	line: number;
	count: number;
	price: number;
	steps: number;
	/** Op units of one run of the block (price = ops priced); see units.ts. */
	ops?: Units;
}

export interface SiteReport {
	kind: string;
	line: number;
	count: number;
	bytes: number;
}

export interface BuiltinReport {
	name: string;
	/** The call's line (0 in reports from before every charge had a site). */
	line: number;
	calls: number;
	steps: number;
	/** This site's size units (a recount prices them again: two sites on one line stay apart). */
	units?: Units;
	/** Estimated bytes of the results the calls made (layout.ts), and how many calls made one. */
	bytes?: number;
	allocations?: number;
}

export interface LineReport {
	line: number;
	steps: number;
	allocations: number;
	bytes: number;
	/** What the line did, unpriced (units.ts). */
	units?: Units;
}

export interface FunctionReport {
	/** `module > path`. */
	id: string;
	module: string;
	path: string;
	kind: string;
	line: number;
	end_line: number;
	calls: number;
	self_steps: number;
	inclusive_steps: number;
	allocations: number;
	bytes: number;
	/** Block prices in order: the body's shape, for rename matching. */
	shape: number[];
	blocks: BlockReport[];
	sites: SiteReport[];
	builtins: BuiltinReport[];
	lines: LineReport[];
	/** What the function did itself, unpriced: self_steps = these units priced (units.ts). */
	units?: Units;
}

export interface EdgeReport {
	from: string;
	to: string;
	count: number;
}

export interface CaseReport {
	name: string;
	file: string;
	/** Both measured runs produced exactly the same counts. */
	stable: boolean;
	timers: number;
	runaway_timers: boolean;
	error: string | null;
	/** Where `error` was thrown: frames of the code under test (error_frames). */
	error_stack?: string[];
	totals: { steps: number; allocations: number; bytes: number; calls: number };
	functions: FunctionReport[];
	edges: EdgeReport[];
	/** The plain-build layers and the time estimate (measure/), when they ran. */
	measure?: CaseMeasure;
	/** Not counted again: its key was unchanged, so the counts came from the cache (cache/). */
	reused?: boolean;
}

export interface Report {
	schema: typeof REPORT_SCHEMA;
	/** `recounted_from`: counted with other prices and recounted from its units (recount.ts). */
	prices: { version: number; hash: string; recounted_from?: { version: number; hash: string } };
	node: string;
	/** Where it was counted: what a comparison between two reports must agree on (env_mismatch). */
	env?: Environment;
	/** `prefix`: the run root relative to the git top level (module ids are relative to the root). */
	git: { sha: string | null; prefix: string };
	cases: CaseReport[];
	/**
	 * The built-in size terms its units keep (prices.ts SIZE_TERMS, `parts`...). Absent: a report
	 * from before they were kept, which cannot be recounted with a price that uses one (recount.ts).
	 */
	unit_terms?: string[];
	/** Bench files that did not load (a syntax error, a throw at the top): none of their cases ran. */
	load_errors?: LoadError[];
	/** `heisenbench health`: what V8 did with the uninstrumented code (spec 5). */
	engine?: EngineReport;
	/** `heisenbench growth`: steps over scaled inputs and their curve class (spec 9). */
	growth?: GrowthReport;
	/** `heisenbench growth --recorded`: steps over the sizes of recorded test calls (growth/recorded.ts). */
	recorded_growth?: RecordedGrowthReport;
	/** `heisenbench search`: the slowest input of each case's size found (spec 9). */
	search?: SearchReport;
	/** `heisenbench audit`: the prices checked against time at every growth size (audit/fit.ts). */
	audit?: AuditReport;
	/** `heisenbench contracts`: each complexity contract held against the growth measured (contracts/). */
	contracts?: ContractReport;
	/** `--cache`: how many cases were reused, counted and checked (cache/). */
	cache?: CacheSummary;
}

export interface LoadError {
	file: string;
	error: string;
	/** Where it was thrown (error_frames), when the bench file's own code threw. */
	stack?: string[];
}

export interface Environment {
	node: string;
	v8: string;
	platform: string;
	arch: string;
	/** The steps -> ns weights the estimates came from (null: none). */
	weights: { version: number; hash: string } | null;
}

const WEIGHTS = package_url('weights.json');

/** The environment of this process. */
export function environment(): Environment {
	let weights: Environment['weights'] = null;
	if (existsSync(WEIGHTS)) {
		const w = JSON.parse(readFileSync(WEIGHTS, 'utf8')) as { version: number; ns: unknown };
		const hash = createHash('sha256').update(JSON.stringify(w.ns)).digest('hex').slice(0, 16);
		weights = { version: w.version, hash };
	}
	return {
		node: process.version,
		v8: process.versions.v8,
		platform: process.platform,
		arch: process.arch,
		weights
	};
}

/**
 * How two reports' environments differ, in words (empty when they agree, or when either report
 * predates the stamp). Prices are not listed: a price change is recounted (recount.ts).
 */
export function env_mismatch(a: Report, b: Report): string[] {
	const out: string[] = [];
	const ea = a.env;
	const eb = b.env;
	if (a.node !== b.node) out.push(`Node ${a.node} vs ${b.node}`);
	if (!ea || !eb) return out;
	if (ea.v8 !== eb.v8 && a.node === b.node) out.push(`V8 ${ea.v8} vs ${eb.v8}`);
	if (ea.platform !== eb.platform || ea.arch !== eb.arch)
		out.push(`${ea.platform}-${ea.arch} vs ${eb.platform}-${eb.arch}`);
	const wa = ea.weights ? `v${ea.weights.version} (${ea.weights.hash.slice(0, 8)})` : 'none';
	const wb = eb.weights ? `v${eb.weights.version} (${eb.weights.hash.slice(0, 8)})` : 'none';
	if (wa !== wb) out.push(`weights ${wa} vs ${wb}`);
	return out;
}

/** An error as one line for a report or a log (the first line of its message). */
export function one_line(e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);
	const first = msg.split('\n').find((l) => l.trim() !== '') ?? msg;
	return first.trim().slice(0, 500);
}

/** Stack frames an error keeps: enough to find the line, few enough for a report. */
export const STACK_FRAMES = 8;

/**
 * Where an error was thrown, as frames of the code under test: `helper (src/lib.ts:7:13)`, paths
 * relative to `root`, the fresh-copy query dropped. Heisenbench's own frames and Node's are left
 * out. Instrumenting keeps every line of the source, so the line is the source's (the column can
 * be further right; a module compiled by TypeScript has its compiled line).
 */
export function error_frames(e: unknown, root: string, max = STACK_FRAMES): string[] {
	const stack = e instanceof Error && typeof e.stack === 'string' ? e.stack : '';
	const out: string[] = [];
	for (const line of stack.split('\n')) {
		const m = /^\s+at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
		if (!m) continue;
		let file = m[2];
		if (file.startsWith('async ')) file = file.slice(6);
		if (!file.startsWith('file:') && !isAbsolute(file)) continue;
		try {
			file = file.startsWith('file:') ? fileURLToPath(file) : file;
		} catch {
			continue;
		}
		if (file.startsWith(OWN_DIR)) continue;
		const rel = relative(root, file).split(sep).join('/');
		const where = `${rel}:${m[3]}:${m[4]}`;
		out.push(m[1] ? `${m[1]} (${where})` : where);
		if (out.length === max) break;
	}
	return out;
}

export const ROOT_ID = '<root>';

function round(n: number): number {
	return Math.round(n * 1e6) / 1e6;
}

function rounded(u: Units): Units {
	const out: Units = {};
	for (const k of Object.keys(u).sort()) out[k] = round(u[k]);
	return out;
}

/** Built-in size units of a snapshot table, per site (or fid): `bi.<key>.<term>` units. */
function builtin_units(rt: Runtime, t: Record<string, number>): Map<number, Units> {
	const out = new Map<number, Units>();
	for (const key of Object.keys(t)) {
		const k = Number(key);
		const term = k % BUILTIN_SLOTS;
		const unit_key = (k - term) / BUILTIN_SLOTS;
		const owner = Math.floor(unit_key / BUILTIN_UNIT_SHIFT);
		const name = rt.bkeys[unit_key % BUILTIN_UNIT_SHIFT];
		if (name === undefined) continue;
		let u = out.get(owner);
		if (!u) out.set(owner, (u = {}));
		add_unit(u, `bi.${name}.${BUILTIN_TERMS[term]}`, t[key]);
	}
	return out;
}

/** Function ids of every fid the runtime knows. */
export function function_ids(rt: Runtime): string[] {
	const ids: string[] = [];
	for (const m of rt.modules) {
		for (const f of m.meta.functions) ids.push(`${m.meta.id} > ${f.path}`);
	}
	return ids;
}

export function build_case_report(
	rt: Runtime,
	snap: Snapshot,
	info: {
		name: string;
		file: string;
		stable: boolean;
		timers: number;
		runaway: boolean;
		error: string | null;
	}
): CaseReport {
	const prices = op_price_vector(rt.prices);
	const ids = function_ids(rt);
	const functions: FunctionReport[] = [];
	let total_allocs = 0;
	let total_bytes = 0;
	let total_calls = 0;

	const site_units = builtin_units(rt, snap.bunits);

	for (let mi = 0; mi < rt.modules.length && mi < snap.modules.length; mi++) {
		const mod = rt.modules[mi];
		const meta = mod.meta;
		const { c, d } = snap.modules[mi];
		const per_fn = meta.functions.map((f, i) => ({
			meta: f,
			fid: mod.f + i,
			self: 0,
			allocations: 0,
			bytes: 0,
			ran: false,
			blocks: [] as BlockReport[],
			sites: [] as SiteReport[],
			builtins: [] as BuiltinReport[],
			lines: new Map<number, LineReport & { units: Units }>(),
			units: {} as Units
		}));
		const line_of = (fi: number, line: number): LineReport & { units: Units } => {
			const lines = per_fn[fi].lines;
			let l = lines.get(line);
			if (!l) {
				l = { line, steps: 0, allocations: 0, bytes: 0, units: {} };
				lines.set(line, l);
			}
			return l;
		};
		for (let bi = 0; bi < meta.blocks.length; bi++) {
			const b = meta.blocks[bi];
			const count = c[bi];
			const f = per_fn[b.fn];
			f.blocks.push({
				id: `${ids[f.fid]} > block ${b.index}`,
				index: b.index,
				line: b.line,
				count,
				price: b.price,
				steps: round(count * b.price),
				ops: op_units(b.ops)
			});
			if (count === 0) continue;
			f.ran = true;
			f.self += count * b.price;
			add_units(f.units, op_units(b.ops, count));
			for (let i = 0; i < b.line_ops.length; i += 3) {
				const steps = count * b.line_ops[i + 2] * prices[b.line_ops[i + 1]];
				const l = line_of(b.fn, b.line_ops[i]);
				if (steps !== 0) l.steps += steps;
				add_unit(l.units, OP_KINDS[b.line_ops[i + 1]], count * b.line_ops[i + 2]);
			}
		}
		for (let si = 0; si < meta.sites.length; si++) {
			const s = meta.sites[si];
			const count = c[s.block];
			const dyn_bytes = d[2 * si];
			// d holds size units; the site kind's dynamic price makes them steps
			const dyn_units = d[2 * si + 1];
			const dyn_price = DYNAMIC_PRICE[s.kind];
			const dyn_steps = dyn_price ? dyn_units * rt.prices.dynamic[dyn_price] : 0;
			if (count === 0 && dyn_units === 0) continue;
			const f = per_fn[s.fn];
			f.self += dyn_steps;
			const l = line_of(s.fn, s.line);
			l.steps += dyn_steps;
			if (dyn_price) {
				add_unit(f.units, `dyn.${dyn_price}`, dyn_units);
				add_unit(l.units, `dyn.${dyn_price}`, dyn_units);
			}
			if (!s.alloc) continue;
			const bytes = count * s.bytes + dyn_bytes;
			f.allocations += count;
			f.bytes += bytes;
			l.allocations += count;
			l.bytes += bytes;
			f.sites.push({ kind: s.kind, line: s.line, count, bytes: round(bytes) });
		}
		for (let k = 0; k < meta.bsites.length; k++) {
			const steps = snap.bsite_steps[mod.b + k] ?? 0;
			if (steps === 0) continue;
			const bs = meta.bsites[k];
			const f = per_fn[bs.fn];
			f.self += steps;
			const l = line_of(bs.fn, bs.line);
			l.steps += steps;
			const u = site_units.get(mod.b + k);
			if (u) {
				add_units(l.units, u);
				add_units(f.units, u);
			}
			// what the calls allocated for their results is the function's, on the line of the call
			const bytes = snap.bsite_bytes?.[mod.b + k] ?? 0;
			const allocations = snap.bsite_allocs?.[mod.b + k] ?? 0;
			f.allocations += allocations;
			f.bytes += bytes;
			l.allocations += allocations;
			l.bytes += bytes;
			f.builtins.push({
				name: bs.name,
				line: bs.line,
				calls: snap.bsite_calls[mod.b + k],
				steps: round(steps),
				bytes: round(bytes),
				allocations,
				...(u ? { units: rounded(u) } : {})
			});
		}
		for (const f of per_fn) {
			const calls = snap.calls[f.fid] ?? 0;
			if (!f.ran && calls === 0) continue;
			total_allocs += f.allocations;
			total_bytes += f.bytes;
			total_calls += calls;
			const lines = [...f.lines.values()]
				.filter((l) => l.steps !== 0 || l.allocations !== 0)
				.map((l) => ({
					line: l.line,
					steps: round(l.steps),
					allocations: l.allocations,
					bytes: round(l.bytes),
					units: rounded(l.units)
				}))
				.sort((a, b) => a.line - b.line);
			functions.push({
				id: ids[f.fid],
				module: meta.id,
				path: f.meta.path,
				kind: f.meta.kind,
				line: f.meta.line,
				end_line: f.meta.end_line,
				calls,
				self_steps: round(f.self),
				inclusive_steps: round(snap.incl[f.fid] ?? 0),
				allocations: f.allocations,
				bytes: round(f.bytes),
				shape: f.blocks.map((b) => b.price),
				blocks: f.blocks,
				sites: f.sites,
				builtins: f.builtins,
				lines,
				units: rounded(f.units)
			});
		}
	}

	const edges: EdgeReport[] = [];
	for (const key of Object.keys(snap.edges)) {
		const k = Number(key);
		const caller = Math.floor(k / EDGE_KEY_SHIFT) - 1;
		const callee = k % EDGE_KEY_SHIFT;
		edges.push({
			from: caller < 0 ? ROOT_ID : ids[caller],
			to: ids[callee],
			count: snap.edges[key]
		});
	}
	edges.sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1));
	functions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	return {
		name: info.name,
		file: info.file,
		stable: info.stable,
		timers: info.timers,
		runaway_timers: info.runaway,
		error: info.error,
		totals: {
			steps: round(snap.steps),
			allocations: total_allocs,
			bytes: round(total_bytes),
			calls: total_calls
		},
		functions,
		edges
	};
}
