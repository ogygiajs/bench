import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BenchCase } from '../bench.ts';
import type { Sample } from '../coverage/recorder.ts';
import { revive } from '../coverage/portable.ts';
import { fit_growth, fit_noisy } from '../growth/fit.ts';
import { count_ladder } from '../growth/index.ts';
import type { GrowthPoint } from '../growth/index.ts';
import { Measurer } from '../growth/measure.ts';
import { handle, top_lines } from '../growth/recorded.ts';
import { arg_sizes, scale_input, size_kind } from '../growth/scale.ts';
import { register_heisenbench } from '../loader/register.ts';
import { build_case_report } from '../report.ts';
import type { CaseReport } from '../report.ts';
import { StepCapError } from '../runtime/index.ts';
import { first_difference, show } from './equal.ts';
import type {
	Cost,
	CurveFit,
	GrowthRow,
	InputKind,
	ProveChildResult,
	ProveGrowth,
	ProveJob,
	Side
} from './types.ts';
import { input_key, reductions, variants_of } from './variants.ts';

/*
 * The proving child's work (child.ts runs it). The original module and the candidate module are
 * both loaded on the counting build: the candidate from its source, at a path next to the
 * original that no file is at, so its imports resolve as the original's do and its functions are
 * counted under their own module id. Each input is a fresh copy for each side; a side runs once,
 * in the deterministic window, under a step cap. Its result, its error and its arguments after
 * the call are compared (equal.ts), and its steps, allocations and bytes are read from the count.
 */

interface Input {
	kind: InputKind;
	label: string;
	args: unknown[];
	this_value: unknown;
}

interface Ran {
	side: Side;
	out: unknown;
	after: { self: unknown; args: unknown[] };
	report: CaseReport | null;
}

/** A candidate may take this many times the original's steps on an input before it is stopped. */
const CANDIDATE_CAP_FACTOR = 20;
const CANDIDATE_CAP_FLOOR = 1e6;
/** How many of the largest recorded inputs are grown. */
const GROWN_BASES = 3;

function sum(xs: readonly number[]): number {
	let s = 0;
	for (const x of xs) s += x;
	return s;
}

function error_of(e: unknown): { name: string; message: string } {
	const err = e as { name?: unknown; message?: unknown } | null;
	return { name: String(err?.name ?? 'Error'), message: String(err?.message ?? e) };
}

function size_of(input: { args: unknown[] }): number {
	return sum(arg_sizes(input.args).sizes);
}

/** Load the candidate's source for its path: counted like any module, never read from disk. */
function serve_candidate(
	core: ReturnType<typeof register_heisenbench>,
	file: string,
	source: string
): string {
	const url = pathToFileURL(file).href;
	const format = /\.[cm]?tsx?$/.test(file) ? null : 'module';
	registerHooks({
		resolve(specifier, context, next) {
			if (specifier === url) return { url, format: 'module', shortCircuit: true };
			return next(specifier, context);
		},
		load(u, context, next) {
			if (u !== url) return next(u, context);
			const code = core.instrument(u, source, format);
			return { format: 'module', source: code ?? source, shortCircuit: true };
		}
	});
	return url;
}

class Runner {
	m: Measurer;
	module: string;
	constructor(root: string, module: string) {
		this.m = new Measurer(root);
		this.module = module;
	}

	/** One call of `fn` on a fresh copy of `input`, counted under `cap`. */
	async run(
		fn: Function,
		input: { args: unknown[]; this_value: unknown },
		cap: number
	): Promise<Ran> {
		const ctx = {
			self: revive(structuredClone(input.this_value)),
			args: revive(structuredClone(input.args)) as unknown[],
			out: undefined as unknown
		};
		const c: BenchCase = {
			name: 'prove',
			file: this.module,
			fn: (x) => {
				const k = x as typeof ctx;
				const r: unknown = Reflect.apply(fn, k.self, k.args);
				if (
					r !== null &&
					typeof r === 'object' &&
					typeof (r as Promise<unknown>).then === 'function'
				) {
					return Promise.resolve(r).then((v) => {
						k.out = v;
					});
				}
				k.out = r;
				return undefined;
			}
		};
		const after = { self: ctx.self, args: ctx.args };
		try {
			const snap = await this.m.once(c, ctx, 'record', cap);
			if (snap.steps > cap)
				return {
					side: { cost: null, threw: null, capped: true },
					out: undefined,
					after,
					report: null
				};
			const report = build_case_report(this.m.rt, snap, {
				name: 'prove',
				file: this.module,
				stable: true,
				timers: 0,
				runaway: false,
				error: null
			});
			const cost: Cost = {
				steps: report.totals.steps,
				allocations: report.totals.allocations,
				bytes: report.totals.bytes
			};
			return { side: { cost, threw: null, capped: false }, out: ctx.out, after, report };
		} catch (e) {
			if (e instanceof StepCapError)
				return {
					side: { cost: null, threw: null, capped: true },
					out: undefined,
					after,
					report: null
				};
			return {
				side: { cost: null, threw: error_of(e), capped: false },
				out: undefined,
				after,
				report: null
			};
		}
	}
}

/** Where the two runs' behavior first differs, or null. A run past its cap decides nothing. */
function behavior_difference(o: Ran, c: Ran): string | null {
	if (o.side.capped || c.side.capped) return null;
	const ot = o.side.threw;
	const ct = c.side.threw;
	if (ot && ct) {
		if (ot.name !== ct.name || ot.message !== ct.message)
			return `threw: ${ot.name}: ${ot.message} vs ${ct.name}: ${ct.message}`;
	} else if (ot) {
		return `the original threw ${ot.name}: ${ot.message}; the candidate returned ${show(c.out, 1)}`;
	} else if (ct) {
		return `the original returned ${show(o.out, 1)}; the candidate threw ${ct.name}: ${ct.message}`;
	} else {
		const d = first_difference(o.out, c.out, 'out');
		if (d) return d;
	}
	return (
		first_difference(o.after.args, c.after.args, 'args after the call') ??
		first_difference(o.after.self, c.after.self, 'this after the call')
	);
}

function candidate_cap(o: Side, cap: number): number {
	return o.cost ? Math.min(cap, o.cost.steps * CANDIDATE_CAP_FACTOR + CANDIDATE_CAP_FLOOR) : cap;
}

function curve(ks: number[], sizes: number[], steps: number[], capped_at: number | null): CurveFit {
	const fit = fit_growth(ks, steps);
	const n = steps.length;
	const exponent =
		n >= 2 && steps[n - 2] > 0 && sizes[n - 1] > sizes[n - 2]
			? Math.log(steps[n - 1] / steps[n - 2]) / Math.log(sizes[n - 1] / sizes[n - 2])
			: 0;
	return {
		class: fit.class,
		power: Math.round(fit.power * 1000) / 1000,
		exponent: Math.round(exponent * 1000) / 1000,
		capped_at
	};
}

export async function run_prove(job: ProveJob): Promise<ProveChildResult> {
	const core = register_heisenbench({ root: job.root, deps: job.deps });
	const errors: string[] = [];
	const result: ProveChildResult = {
		inputs: [],
		growth: null,
		recorded_curve: null,
		blame: { original: [], candidate: [], size: 0 },
		minimal: null,
		errors
	};
	const cand_url = job.candidate
		? serve_candidate(core, job.candidate.file, job.candidate.source)
		: null;
	const orig_mod = (await import(pathToFileURL(join(job.root, job.module)).href)) as Record<
		string,
		unknown
	>;
	const orig = handle(orig_mod, job.path);
	if (!orig) throw new Error(`heisenbench: ${job.module} has no top-level function ${job.path}`);
	let cand: Function | null = null;
	if (cand_url) {
		const mod = (await import(cand_url)) as Record<string, unknown>;
		cand = handle(mod, job.path);
		if (!cand)
			throw new Error(`heisenbench: the candidate module has no top-level function ${job.path}`);
	}
	const r = new Runner(job.root, job.module);
	const seen = new Set<string>();
	const recorded: Input[] = [];
	for (const s of job.samples) {
		const key = input_key(s);
		if (key !== null) {
			if (seen.has(key)) continue;
			seen.add(key);
		}
		recorded.push({
			kind: 'recorded',
			label: `recorded #${recorded.length + 1}`,
			args: s.args,
			this_value: s.this_value
		});
	}
	let largest: { report: CaseReport; cand: CaseReport | null; size: number } | null = null;
	const keep_largest = (size: number, o: Ran, c: Ran | null): void => {
		if (o.report && (!largest || size >= largest.size))
			largest = { report: o.report, cand: c?.report ?? null, size };
	};
	const differing: Array<{ input: Input; size: number; difference: string }> = [];
	const pair = async (input: Input): Promise<void> => {
		const size = size_of(input);
		const o = await r.run(orig, input, job.cap);
		let c: Ran | null = null;
		let difference: string | null = null;
		if (cand) {
			c = await r.run(cand, input, candidate_cap(o.side, job.cap));
			difference = behavior_difference(o, c);
			if (difference) differing.push({ input, size, difference });
		}
		keep_largest(size, o, c);
		result.inputs.push({
			kind: input.kind,
			label: input.label,
			size,
			original: o.side,
			candidate: c?.side ?? null,
			difference
		});
	};
	for (const input of recorded) await pair(input);
	// grown: the largest few recorded inputs, one argument at a time, at every factor. Inputs of one
	// function grow differently (a bench case's page repeated k times may be linear where a test's
	// is quadratic): the steepest curve of the original is the one the candidate must answer
	const sized = recorded.map((i) => ({ i, size: size_of(i) })).sort((a, b) => b.size - a.size);
	const bases: Input[] = [];
	for (const s of sized) {
		if (bases.length >= GROWN_BASES) break;
		if (!bases.some((b) => size_of(b) === s.size)) bases.push(s.i);
	}
	const curves: ProveGrowth[] = [];
	for (const b of bases) curves.push(...(await grow(job, r, orig, cand, b, pair_grown)));
	curves.sort((a, b) => b.original.power - a.original.power || a.argument - b.argument);
	result.growth = curves[0] ?? null;
	async function pair_grown(input: Input, o: Ran, c: Ran | null): Promise<void> {
		const size = size_of(input);
		let difference: string | null = null;
		if (c) {
			difference = behavior_difference(o, c);
			if (difference) differing.push({ input, size, difference });
		}
		keep_largest(size, o, c);
		result.inputs.push({
			kind: 'grown',
			label: input.label,
			size,
			original: o.side,
			candidate: c?.side ?? null,
			difference
		});
	}
	// edge cases of every recorded input's shape
	if (cand) {
		for (let n = 0; n < recorded.length; n++) {
			for (const v of variants_of(
				recorded[n],
				job.variants,
				job.seed + n,
				seen,
				job.edge === 'all'
			))
				await pair({
					kind: 'edge',
					label: `${recorded[n].label}, ${v.label}`,
					args: v.args,
					this_value: v.this_value
				});
		}
	}
	const both = result.inputs.filter(
		(i) => i.kind === 'recorded' && i.original.cost && i.candidate?.cost
	);
	const xs = both.map((i) => i.size);
	if (new Set(xs).size >= 4 && Math.min(...xs) > 0 && Math.max(...xs) / Math.min(...xs) >= 4) {
		const fo = fit_noisy(
			xs,
			both.map((i) => i.original.cost!.steps)
		);
		const fc = fit_noisy(
			xs,
			both.map((i) => i.candidate!.cost!.steps)
		);
		result.recorded_curve = {
			original: { power: fo.power, r2: fo.r2 },
			candidate: cand ? { power: fc.power, r2: fc.r2 } : null,
			sizes: [Math.min(...xs), Math.max(...xs)]
		};
	} else if (!cand) {
		const only = result.inputs.filter((i) => i.kind === 'recorded' && i.original.cost);
		const ys = only.map((i) => i.size);
		if (new Set(ys).size >= 4 && Math.min(...ys) > 0 && Math.max(...ys) / Math.min(...ys) >= 4) {
			const fo = fit_noisy(
				ys,
				only.map((i) => i.original.cost!.steps)
			);
			result.recorded_curve = {
				original: { power: fo.power, r2: fo.r2 },
				candidate: null,
				sizes: [Math.min(...ys), Math.max(...ys)]
			};
		}
	}
	const at: { report: CaseReport; cand: CaseReport | null; size: number } | null = largest;
	if (at) {
		result.blame = {
			original: top_lines(at.report),
			candidate: at.cand ? top_lines(at.cand) : [],
			size: at.size
		};
	}
	if (cand && differing.length > 0) result.minimal = await shrink(job, r, orig, cand, differing);
	return result;
}

/** The largest recorded input grown at every factor, each argument in turn; the steepest on the original. */
async function grow(
	job: ProveJob,
	r: Runner,
	orig: Function,
	cand: Function | null,
	base: Input,
	record: (input: Input, o: Ran, c: Ran | null) => Promise<void>
): Promise<ProveGrowth[]> {
	const sizes = arg_sizes(base.args).sizes;
	const tried: ProveGrowth[] = [];
	for (let i = 0; i < base.args.length; i++) {
		const kind = size_kind(base.args[i]);
		if (!(sizes[i] > 1) || kind === 'size') continue;
		const make = (k: number): Input => {
			const args = structuredClone(base.args);
			args[i] = scale_input(args[i], k);
			return {
				kind: 'grown',
				label: `${base.label}, argument ${i} grown ${k}x`,
				args,
				this_value: base.this_value
			};
		};
		const runs = new Map<number, { input: Input; o: Ran }>();
		let ladder: Awaited<ReturnType<typeof count_ladder>>;
		try {
			ladder = await count_ladder(job.sizes, async (k): Promise<GrowthPoint> => {
				const input = make(k);
				const o = await r.run(orig, input, job.cap);
				if (o.side.capped) throw new StepCapError(job.cap, job.cap);
				if (!o.side.cost || !o.report) throw new Error(o.side.threw?.message ?? 'no count');
				runs.set(k, { input, o });
				return {
					k,
					input_size: size_of(input),
					steps: o.side.cost.steps,
					stable: true,
					report: o.report
				};
			});
		} catch {
			continue; // the grown input is not valid input for it
		}
		if (ladder.points.length < 2) continue;
		const rows: GrowthRow[] = [];
		const cand_steps: number[] = [];
		let cand_capped: number | null = null;
		for (const p of ladder.points) {
			const run = runs.get(p.k)!;
			let c: Ran | null = null;
			if (cand) {
				c = await r.run(cand, run.input, candidate_cap(run.o.side, job.cap));
				if (c.side.cost) cand_steps.push(c.side.cost.steps);
				else if (c.side.capped && cand_capped === null) cand_capped = p.k;
			}
			// the 1x input is the recorded one, already compared
			if (p.k !== 1) await record(run.input, run.o, c);
			rows.push({
				k: p.k,
				size: p.input_size,
				original: run.o.side.cost,
				candidate: c?.side.cost ?? null
			});
		}
		const ks = ladder.points.map((p) => p.k);
		const in_sizes = ladder.points.map((p) => p.input_size);
		const original = curve(
			ks,
			in_sizes,
			ladder.points.map((p) => p.steps),
			ladder.capped_at
		);
		if (original.class === 'shrinks' || original.class === 'irregular') continue;
		const candidate =
			cand && cand_steps.length === ks.length
				? curve(ks, in_sizes, cand_steps, null)
				: cand
					? { class: null, power: 0, exponent: 0, capped_at: cand_capped }
					: null;
		tried.push({ argument: i, kind, rows, original, candidate });
		if (tried.length >= 4) break;
	}
	return tried;
}

/** The smallest differing input, shrunk one reduction at a time while the sides still differ. */
async function shrink(
	job: ProveJob,
	r: Runner,
	orig: Function,
	cand: Function,
	differing: Array<{ input: Input; size: number; difference: string }>
): Promise<NonNullable<ProveChildResult['minimal']>> {
	const first = [...differing].sort((a, b) => a.size - b.size)[0];
	let current = first;
	let tries = 0;
	for (let changed = true; changed && tries < job.shrink;) {
		changed = false;
		const smaller = reductions(current.input, job.edge === 'all')
			.map((x) => ({ x, size: size_of(x) }))
			.filter((x) => x.size < current.size)
			.sort((a, b) => a.size - b.size);
		for (const { x, size } of smaller) {
			if (tries++ >= job.shrink) break;
			const o = await r.run(orig, x, job.cap);
			const c = await r.run(cand, x, candidate_cap(o.side, job.cap));
			const d = behavior_difference(o, c);
			if (d) {
				current = {
					input: { ...current.input, args: x.args, this_value: x.this_value },
					size,
					difference: d
				};
				changed = true;
				break;
			}
		}
	}
	return {
		label: first.input.label,
		input: show(
			current.input.this_value === undefined
				? current.input.args
				: { this: current.input.this_value, args: current.input.args },
			6
		),
		difference: current.difference,
		size: current.size,
		from_size: first.size
	};
}

export type { Sample };
