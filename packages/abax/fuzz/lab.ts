import { mkdirSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register_abax } from '../src/loader/register.ts';
import { get_runtime } from '../src/runtime/index.ts';
import type { ModuleRecord, Runtime, Snapshot } from '../src/runtime/index.ts';
import { Builtins } from '../src/runtime/builtins.ts';
import { Determinism } from '../src/runtime/determinism.ts';
import { build_case_report } from '../src/report.ts';
import type { CaseReport } from '../src/report.ts';
import { instrument } from '../src/transform/instrument.ts';
import type { InstrumentResult } from '../src/transform/instrument.ts';
import { module_id, module_specifier, strip_types } from '../src/transform/index.ts';
import { load_prices } from '../src/prices.ts';
import { show, show_error } from './show.ts';
import { probe } from './probe.ts';
import type { Anchor, Probed } from './probe.ts';
import { index_ast } from './ast.ts';
import type { AstIndex } from './ast.ts';

/*
 * One process's fuzzing bench: a temp root with the counting loader registered on it, V8's
 * precise block coverage on for the whole process, and the deterministic window of a real run
 * (frozen clock, seeded random, priced built-ins). A program is written three times:
 *
 *   p<N>.mjs / .ts         loaded through the counting loader (instrumented)
 *   p<N>.plain.mjs / .ts   loaded as it is (the loader excludes `.plain.`)
 *   p<N>.probe.mjs         the plain program with V8-visible counters (probe.ts), for coverage
 */

export interface Trace {
	/** `label=value` per log call, in order. */
	log: string[];
	/** main's result, or the error it threw. */
	end: string;
}

export interface Loaded {
	id: number;
	/** The code V8 runs for the plain program (TS stripped to whitespace: same offsets). */
	js: string;
	lang: 'js' | 'ts';
	inst_url: string;
	plain_url: string;
	probe_url: string;
	/** The transform's view, recomputed (same input, same output as the loader's). */
	inst: InstrumentResult;
	ast: AstIndex;
	probed: Probed;
	module_id: string;
}

export interface Counted {
	trace: Trace;
	snap: Snapshot;
	report: CaseReport;
	module: ModuleRecord;
}

export interface CoverageRange {
	start: number;
	end: number;
	count: number;
}

const real_set_immediate = setImmediate;
const tick = (): Promise<void> => new Promise((r) => real_set_immediate(r));

export class Lab {
	root: string;
	rt: Runtime;
	builtins: Builtins;
	det: Determinism;
	session: Session | null = null;
	n = 0;
	gen = 0;
	prices = load_prices();
	/** Hooks around the instrumented run (call-graph reference). */
	around: { before?: () => void; after?: () => void } = {};

	constructor(root: string) {
		this.root = root;
		mkdirSync(root, { recursive: true });
		register_abax({ root, exclude: ['.bench.', '.plain.', '.probe.'] });
		this.rt = get_runtime();
		this.builtins = new Builtins(this.rt);
		this.det = new Determinism();
		(globalThis as { __P?: boolean }).__P = true;
		(globalThis as { __U?: undefined }).__U = undefined;
		process.on('unhandledRejection', () => {});
	}

	/**
	 * Run harness code while instrumented code is on the stack without charging it: the priced
	 * built-ins see a built-in already running at this depth and pass through.
	 */
	quiet<T>(fn: () => T): T {
		const rt = this.rt;
		const bdepth = rt.bdepth;
		const site = rt.site;
		rt.bdepth = rt.depth;
		try {
			return fn();
		} finally {
			rt.bdepth = bdepth;
			rt.site = site;
		}
	}

	async start_coverage(): Promise<void> {
		const s = new Session();
		s.connect();
		await s.post('Profiler.enable');
		await s.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
		this.session = s;
	}

	/** Write a program's three files. */
	load(source: string, lang: 'js' | 'ts', name?: string): Loaded {
		const id = ++this.n;
		const base = name ?? `p${id}`;
		const ext = lang === 'ts' ? '.ts' : '.mjs';
		const js = lang === 'ts' ? strip_types(source) : source;
		const inst_file = join(this.root, base + ext);
		const plain_file = join(this.root, base + '.plain' + ext);
		const probe_file = join(this.root, base + '.probe.mjs');
		const inst = instrument(js, {
			id: module_id(inst_file, this.root),
			filename: inst_file,
			prices: this.prices.prices,
			prices_hash: this.prices.hash,
			module_specifier: module_specifier(inst_file),
			lang: 'js'
		});
		const ast = index_ast(js);
		const probed = probe(js, inst.origins, inst.meta.sites, ast.lines);
		writeFileSync(inst_file, source);
		writeFileSync(plain_file, source);
		writeFileSync(probe_file, probed.code);
		return {
			id,
			js,
			lang,
			inst_url: pathToFileURL(inst_file).href,
			plain_url: pathToFileURL(plain_file).href,
			probe_url: pathToFileURL(probe_file).href,
			inst,
			ast,
			probed,
			module_id: module_id(inst_file, this.root)
		};
	}

	/** Run `main` of a module in the measuring window; the trace of what it did. */
	async run(url: string, counted: boolean): Promise<Trace> {
		const log: string[] = [];
		const record = (label: unknown, value: unknown): void => {
			this.quiet(() => log.push(`${String(label)}=${show(value)}`));
		};
		// the module body runs on import: counted from the reset on, like V8 counts it
		if (counted) {
			this.rt.reset();
			this.around.before?.();
		}
		const mod = (await import(url)) as { main: (log: unknown) => Promise<unknown> };
		let end: string;
		this.det.open('record');
		this.builtins.install();
		try {
			const v = await mod.main(record);
			end = `return ${show(v)}`;
		} catch (e) {
			end = show_error(e);
		} finally {
			// work the program left behind (the siblings of a rejected Promise.all) settles in the
			// window, not in the next run
			for (let i = 0; i < 20; i++) await tick();
			if (counted) this.around.after?.();
			this.builtins.uninstall();
			this.det.close();
		}
		return { log, end };
	}

	async plain(l: Loaded): Promise<Trace> {
		return this.run(l.plain_url, false);
	}

	/** The instrumented program; `fresh` imports a new copy of the module (fresh module state). */
	async counted(l: Loaded, fresh = false): Promise<Counted> {
		const url = fresh ? `${l.inst_url}?abax_gen=f${++this.gen}` : l.inst_url;
		const trace = await this.run(url, true);
		const snap = this.rt.snapshot();
		const report = build_case_report(this.rt, snap, {
			name: 'fuzz',
			file: '',
			stable: true,
			timers: 0,
			runaway: false,
			error: null
		});
		const module = this.module_of(l);
		return { trace, snap, report, module };
	}

	module_of(l: Loaded): ModuleRecord {
		for (const m of this.rt.modules) if (m.meta.id === l.module_id) return m;
		throw new Error(`fuzz: module ${l.module_id} not registered`);
	}

	/** V8's block coverage of one run of the probed program. */
	/** `ranges`: every range; `fns`: each function's own range (its calls). */
	async coverage(
		l: Loaded
	): Promise<{ trace: Trace; ranges: CoverageRange[]; fns: CoverageRange[] }> {
		const s = this.session;
		if (!s) throw new Error('fuzz: coverage not started');
		await s.post('Profiler.takePreciseCoverage');
		const trace = await this.run(l.probe_url, false);
		const { result } = (await s.post('Profiler.takePreciseCoverage')) as unknown as {
			result: Array<{
				url: string;
				functions: Array<{
					ranges: Array<{ startOffset: number; endOffset: number; count: number }>;
				}>;
			}>;
		};
		const ranges: CoverageRange[] = [];
		const fns: CoverageRange[] = [];
		for (const script of result) {
			if (script.url !== l.probe_url) continue;
			for (const f of script.functions) {
				f.ranges.forEach((r, i) => {
					const range = { start: r.startOffset, end: r.endOffset, count: r.count };
					ranges.push(range);
					if (i === 0) fns.push(range);
				});
			}
		}
		return { trace, ranges, fns };
	}
}

/** V8's count at an offset: the innermost range that contains it. */
export function count_at(ranges: CoverageRange[], pos: number): number | null {
	let best: CoverageRange | null = null;
	for (const r of ranges) {
		if (r.start <= pos && pos < r.end && (!best || r.end - r.start <= best.end - best.start))
			best = r;
	}
	return best ? best.count : null;
}

function starting_at(ranges: CoverageRange[], pos: number): CoverageRange | null {
	let best: CoverageRange | null = null;
	for (const r of ranges)
		if (r.start === pos && (!best || r.end - r.start < best.end - best.start)) best = r;
	return best;
}

/** V8's count of a two-armed counter (probe.ts), or of one of V8's own ranges. */
export function count_of(ranges: CoverageRange[], a: Anchor): number | null {
	if (a.own !== undefined) {
		const own = starting_at(ranges, a.own);
		if (own) return own.count;
	}
	if (a.minus) {
		const all = count_of(ranges, { hit: a.hit, miss: a.miss });
		const off = count_of(ranges, a.minus);
		return all === null || off === null ? null : all - off;
	}
	if (a.guard && count_of(ranges, a.guard) === 0) return 0;
	if (a.miss < 0) return count_at(ranges, a.hit);
	const own = starting_at(ranges, a.hit);
	if (own) return own.count;
	// left out: the same count as its parent when the code was live, never run when it was not
	return starting_at(ranges, a.miss) ? count_at(ranges, a.hit) : 0;
}

export function same_trace(a: Trace, b: Trace): string | null {
	if (a.end !== b.end) return `end: ${a.end} vs ${b.end}`;
	const n = Math.max(a.log.length, b.log.length);
	for (let i = 0; i < n; i++) {
		if (a.log[i] !== b.log[i])
			return `log #${i}: ${a.log[i] ?? '<none>'} vs ${b.log[i] ?? '<none>'}`;
	}
	return null;
}
