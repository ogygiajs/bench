import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BenchCase } from '../bench.ts';
import type { FunctionRecord, Sample } from '../coverage/recorder.ts';
import { revive } from '../coverage/portable.ts';
import { code } from '../md.ts';
import { build_case_report } from '../report.ts';
import type { CaseReport } from '../report.ts';
import { MIN_R2, fit_growth, fit_noisy, growth_label, is_superlinear } from './fit.ts';
import type { GrowthClass } from './fit.ts';
import {
	TOP_FUNCTIONS,
	count_ladder,
	count_probe,
	points_odds,
	ran_in,
	round3,
	top_lines,
	where_steps,
	with_probe
} from './index.ts';
import type { GrowthPoint } from './index.ts';

export { top_lines } from './index.ts';
import { close_call, odds_superlinear, odds_words, path_from } from './odds.ts';
import type { GrowthOdds, OddsOptions } from './odds.ts';
import { Measurer, load_cases } from './measure.ts';
import type { LoadOptions } from './measure.ts';
import { arg_sizes, scale_input, size_kind } from './scale.ts';

/*
 * Growth from recorded calls: no hand-written `scale` needed. The input recorder
 * (coverage/recorder.ts) keeps, for every function a test run (or a bench run, `heisenbench
 * record`) called, samples of its inputs over the sizes it saw (one per half octave of input size)
 * with each argument's size. Each sample is replayed on the counting build, and the function's
 * inclusive steps are read against the size of each argument in turn, as noisy points
 * (fit.ts fit_noisy): two inputs of one size can cost very different steps. The argument whose size
 * explains the steps best (the highest r2) is the one growth is over.
 *
 * Where the recorded sizes span too little (under MIN_SPAN, or fewer than MIN_SIZES distinct) or no
 * argument's size explains the steps, the largest recorded input is grown instead: each argument
 * in turn scaled by the generic scaler at 1x, 4x, 16x (scale_input; under the step cap, with the
 * doubling ladder of growth/index.ts below a size that passes it), counted exactly and fitted like
 * a bench case (fit_growth). An argument whose scaled copy is not valid input (the call throws, or
 * its steps fall) says nothing.
 *
 * A function GROWS (a finding) when its own inclusive steps are superlinear, or when a function
 * its calls spend at least MIN_SHARE of their steps in at the largest size is: the part that grows
 * fastest is the part that takes over at sizes the tests never reached. Superlinear means the odds
 * of quadratic or worse (odds.ts) are at least SUPERLINEAR_ODDS (`--superlinear-odds`), with
 * enough work at the largest size to matter (MIN_STEPS) and, on noisy points, the spread kept with
 * any one call left out and the most work at the largest size.
 *
 * Scaled points get active sizing: when the odds of the curve, or of a part that could make it a
 * finding, are a close call, one more factor between the two largest (8x) is counted and the odds
 * are read again with it (`probe`; the class and `factors` stay those of 1x / 4x / 16x).
 */

export const RECORDED_GROWTH_SCHEMA = 'heisenbench-recorded-growth/1';

/** Distinct sizes a recorded curve needs. */
export const MIN_SIZES = 4;
/** Largest over smallest recorded size a curve needs (else the input is scaled). */
export const MIN_SPAN = 4;
/** Share of the steps at the largest size a function needs to make its caller a finding. */
export const MIN_SHARE = 0.05;
/** Steps at the largest size a growing curve needs: below it, no size the tests reached matters. */
export const MIN_STEPS = 1000;
/** Scale factors of a scaled curve. */
export const SCALED_SIZES = [1, 4, 16];
/** Steps one replay may take. */
export const RECORDED_CAP = 5e8;

export interface RecordedPoint {
	/** The size the curve is over (the argument's, or the scaled input's). */
	size: number;
	/** Inclusive steps of the function. */
	steps: number;
}

/** A function the recorded calls spend steps in, with its curve over the same points. */
export interface RecordedPart {
	id: string;
	/** Self steps at each point. */
	steps: number[];
	class: GrowthClass;
	power: number;
	/** Its share of the steps at the largest point. */
	share: number;
	superlinear: boolean;
	/**
	 * Odds of each shape. Scaled: read only for a part that could make a finding (MIN_STEPS and
	 * MIN_SHARE at the largest point); absent on the others, which are never superlinear.
	 */
	odds?: GrowthOdds | null;
	/** Its self steps at the probe size, when one was counted. */
	probe_steps?: number;
	/** Its lines with the most steps at the largest point (`module:line`). */
	lines?: string[];
}

/** The lines of function `id` with the most steps in `report`. */
function part_lines(report: CaseReport, id: string): string[] {
	const f = report.functions.find((x) => x.id === id);
	if (!f) return [];
	return [...f.lines]
		.filter((l) => l.steps > 0)
		.sort((a, b) => b.steps - a.steps || a.line - b.line)
		.slice(0, 3)
		.map((l) => `${f.module}:${l.line}`);
}

export interface RecordedGrowth {
	id: string;
	/** Calls the recorded runs made (sampled or not). */
	calls: number;
	/** Smallest and largest summed input size over the sized calls. */
	call_sizes: { sized: number; min: number; max: number } | null;
	/** `recorded`: the samples as recorded; `scaled`: the largest sample, one argument grown. */
	source: 'recorded' | 'scaled';
	/** The argument the curve is over (null: their summed size). */
	argument: number | null;
	/** What its size counts (`string length`). */
	kind: string;
	/** Scale factors, for a scaled curve. */
	factors?: number[];
	points: RecordedPoint[];
	class: GrowthClass | null;
	/** steps ~ size^power (noisy points: the log-log slope; scaled: the best `a + b * n^p`). */
	power: number;
	/** Noisy points: how much of log(steps) the power explains. */
	r2?: number;
	/** The curve decides a class. */
	confident: boolean;
	/** Odds of each shape (null: too few points, or steps that fall). */
	odds?: GrowthOdds | null;
	/** Scaled: the one more factor active sizing counted for the odds (not in `factors`). */
	probe?: { factor: number; size: number; steps: number };
	/** Scaled: the factor the odds were read from, when the code took another path below it. */
	odds_from?: number;
	/** Its own steps grow quadratically or worse (see the rule above). */
	superlinear: boolean;
	/** A finding: it, or a large part of its work, grows superlinearly. */
	grows: boolean;
	/** Why the curve does not decide, when it does not. */
	reason?: string;
	/** A scaled run went past the step cap at this factor. */
	capped_at?: number;
	/** The functions with the most self steps at the largest point, each with its curve. */
	parts?: RecordedPart[];
	/** The lines with the most self steps at the largest point. */
	lines?: Array<{ at: string; steps: number; share: number }>;
	/** What the recorded sizes of each argument said (argument null: their sum). */
	recorded?: Array<{
		argument: number | null;
		class: GrowthClass | null;
		power: number;
		r2: number;
		reason: string | null;
		/** Odds of each shape over that argument's sizes (absent in older reports). */
		odds?: GrowthOdds | null;
		/** Steps of the call at the largest of that argument's sizes. */
		top_steps?: number;
	}>;
}

export interface RecordedGrowthReport {
	schema: typeof RECORDED_GROWTH_SCHEMA;
	functions: RecordedGrowth[];
	/** Recorded functions not grown, by reason (`not replayable`, `too few samples`...). */
	skipped: Record<string, number>;
	/** Counted steps spent replaying. */
	steps_spent: number;
}

export interface RecordedGrowthOptions extends Omit<LoadOptions, 'files' | 'filter'> {
	records: readonly FunctionRecord[];
	/** Only functions of these modules (a PR: the modules it changed). */
	modules?: ReadonlySet<string>;
	/** Steps one replay may take (default RECORDED_CAP). */
	cap?: number;
	/** Counted steps all replays may spend together; past it no input is scaled (default none). */
	budget_steps?: number;
	/** Prior and bar of the growth odds. */
	odds?: OddsOptions;
	log?: (line: string) => void;
}

function module_of(id: string): string {
	return id.slice(0, id.indexOf(' > '));
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** The callable of a top-level function (its export, or the `__heisenbench` hidden export). */
export function handle(mod: Record<string, unknown>, path: string): Function | null {
	if (!IDENT.test(path)) return null;
	const own = mod[path];
	if (typeof own === 'function') return own;
	const hidden = mod.__heisenbench as Record<string, unknown> | undefined;
	const h = hidden?.[path];
	return typeof h === 'function' ? h : null;
}

function sum(xs: readonly number[]): number {
	let s = 0;
	for (const x of xs) s += x;
	return s;
}

interface Counted {
	sizes: number[];
	steps: number;
	report: CaseReport;
}

type Base = Pick<RecordedGrowth, 'id' | 'calls' | 'call_sizes' | 'recorded'>;

/** Counts one call of `fn` (fresh copies of its inputs each run) and its report. */
async function count_call(
	m: Measurer,
	id: string,
	fn: Function,
	make: () => { self: unknown; args: unknown[] },
	cap: number
): Promise<{ steps: number; report: CaseReport }> {
	const c: BenchCase = {
		name: id,
		file: module_of(id),
		fn: (ctx) => {
			const x = ctx as { self: unknown; args: unknown[] };
			return Reflect.apply(fn, x.self, x.args);
		}
	};
	// One run per input: a curve is many inputs, each exact; a bench case's two-run stability check
	// (Measurer.steps) would triple the cost of every point and decide nothing a curve reads.
	const snap = await m.once(c, make(), 'record', cap);
	const report = build_case_report(m.rt, snap, {
		name: id,
		file: c.file,
		stable: true,
		timers: 0,
		runaway: false,
		error: null
	});
	const f = report.functions.find((x) => x.id === id);
	return { steps: f?.inclusive_steps ?? snap.steps, report };
}

/** Self steps per function over `reports`, the functions with the most at the last one. */
function part_rows(reports: readonly CaseReport[]): Array<[string, number[]]> {
	const rows = new Map<string, number[]>();
	reports.forEach((r, i) => {
		for (const f of r.functions) {
			if (f.self_steps === 0) continue;
			let row = rows.get(f.id);
			if (!row) rows.set(f.id, (row = reports.map(() => 0)));
			row[i] += f.self_steps;
		}
	});
	const last = reports.length - 1;
	return [...rows]
		.sort((a, b) => b[1][last] - a[1][last] || (a[0] < b[0] ? -1 : 1))
		.slice(0, TOP_FUNCTIONS);
}

function total_at_last(reports: readonly CaseReport[]): number {
	let t = 0;
	for (const f of reports[reports.length - 1].functions) t += f.self_steps;
	return t;
}

/** Whether a curve over these sizes can say anything, or why not. */
function spread(xs: number[]): string | null {
	if (new Set(xs).size < MIN_SIZES) return 'too few sizes';
	const lo = Math.min(...xs);
	if (!(lo > 0) || Math.max(...xs) / lo < MIN_SPAN) return 'sizes span too little';
	return null;
}

/**
 * A superlinear curve of noisy points must keep its spread with any one call left out, as it
 * keeps its power (fit_noisy): one trivial call at the smallest size, or one odd call at the
 * largest, never makes the span a finding stands on.
 */
function steep(xs: number[], ys: number[], fit: ReturnType<typeof fit_noisy>): boolean {
	if (!fit.superlinear) return false;
	const sorted = [...xs].sort((a, b) => a - b);
	if (spread(sorted.slice(1)) !== null || spread(sorted.slice(0, -1)) !== null) return false;
	// what grows has its most work at the largest size, and enough of it to matter
	const top = Math.max(...xs);
	const at_top = Math.max(...ys.filter((_, i) => xs[i] === top));
	return at_top >= Math.max(...ys) && at_top >= MIN_STEPS;
}

/**
 * Exact points of one input scaled: the odds say quadratic or worse (a curve flat up to a size and
 * rising from there, or one whose code took another path at a size, reads its odds from there:
 * odds.ts), with enough work at the largest size to matter.
 */
function steep_exact(
	ys: number[],
	odds: GrowthOdds | null | undefined,
	opts: OddsOptions
): boolean {
	return ys[ys.length - 1] >= MIN_STEPS && odds_superlinear(odds, opts);
}

/** A row over `points` with the probe's value put in size order. */
function with_steps(
	points: readonly GrowthPoint[],
	row: readonly number[],
	probe: GrowthPoint,
	value: number
): number[] {
	let at = 0;
	while (at < points.length && points[at].k < probe.k) at++;
	const out = [...row];
	out.splice(at, 0, value);
	return out;
}

/** The steps of function `id` in a report (0 when it did not run). */
function self_steps(report: CaseReport, id: string): number {
	let s = 0;
	for (const f of report.functions) if (f.id === id) s += f.self_steps;
	return s;
}

function grows(g: RecordedGrowth): boolean {
	if (!g.confident) return false;
	return g.superlinear || (g.parts ?? []).some((p) => p.superlinear && p.share >= MIN_SHARE);
}

/** Grow one recorded function from its samples, else by scaling its largest one. */
async function grow_recorded(
	m: Measurer,
	r: FunctionRecord,
	fn: Function,
	cap: number,
	budget: { left: number; spent: number },
	odds: OddsOptions
): Promise<RecordedGrowth> {
	const base: Base = { id: r.id, calls: r.calls, call_sizes: r.sizes ?? null };
	const samples = r.samples.filter((s) => !s.threw);
	const fresh = (s: Sample) => () => ({
		self: revive(structuredClone(s.this_value)),
		args: revive(structuredClone(s.args)) as unknown[]
	});
	const counted: Counted[] = [];
	for (const s of samples) {
		try {
			const c = await count_call(m, r.id, fn, fresh(s), cap);
			budget.spent += c.steps;
			counted.push({ sizes: s.sizes ?? arg_sizes(s.args).sizes, ...c });
		} catch {
			// a sample that throws here (state the run had and this process does not) says nothing
		}
	}
	const args = Math.max(0, ...counted.map((c) => c.sizes.length));
	const candidates: Array<{
		argument: number | null;
		points: Array<RecordedPoint & { report: CaseReport }>;
		fit: ReturnType<typeof fit_noisy> | null;
		reason: string | null;
	}> = [];
	for (let i = -1; i < args; i++) {
		const points = counted
			.map((c) => ({
				size: i === -1 ? sum(c.sizes) : (c.sizes[i] ?? 0),
				steps: c.steps,
				report: c.report
			}))
			.sort((a, b) => a.size - b.size || a.steps - b.steps);
		if (points.length === 0) continue;
		const xs = points.map((p) => p.size);
		let reason = spread(xs);
		let fit = null;
		if (reason === null) {
			fit = fit_noisy(
				xs,
				points.map((p) => p.steps),
				odds
			);
			// a flat curve explains nothing and needs not to: its power says it
			if (fit.r2 < MIN_R2 && Math.abs(fit.power) >= 0.5) reason = 'noisy';
		}
		candidates.push({ argument: i === -1 ? null : i, points, fit, reason });
	}
	base.recorded = candidates.map((c) => ({
		argument: c.argument,
		class: c.fit?.class ?? null,
		power: c.fit?.power ?? 0,
		r2: c.fit?.r2 ?? 0,
		reason: c.reason,
		odds: c.fit?.odds ?? null,
		top_steps: c.points[c.points.length - 1].steps
	}));
	// the argument whose size explains the steps best; their sum only when no argument decides
	const deciding = candidates
		.filter((c) => c.reason === null && c.argument !== null)
		.sort((a, b) => b.fit!.r2 - a.fit!.r2 || a.argument! - b.argument!);
	const pick = deciding[0] ?? candidates.find((c) => c.argument === null && c.reason === null);
	const largest = samples
		.map((s) => ({ s, size: sum(s.sizes ?? arg_sizes(s.args).sizes) }))
		.reduce<{ s: Sample; size: number } | null>((a, b) => (a && a.size >= b.size ? a : b), null);
	if (pick) {
		const fit = pick.fit!;
		const xs = pick.points.map((p) => p.size);
		const reports = pick.points.map((p) => p.report);
		const total = total_at_last(reports);
		const g: RecordedGrowth = {
			...base,
			source: 'recorded',
			argument: pick.argument,
			kind: pick.argument === null || !largest ? 'size' : size_kind(largest.s.args[pick.argument]),
			points: pick.points.map(({ size, steps }) => ({ size, steps })),
			class: fit.class,
			power: fit.power,
			r2: fit.r2,
			confident: true,
			odds: fit.odds,
			superlinear: steep(
				xs,
				pick.points.map((p) => p.steps),
				fit
			),
			grows: false,
			parts: part_rows(reports).map(([id, steps]) => {
				// the calls that ran it: a call that took another path says nothing about its size
				const ran = steps.map((s, i) => [xs[i], s] as const).filter(([, s]) => s > 0);
				const f = fit_noisy(
					ran.map(([x]) => x),
					ran.map(([, s]) => s),
					odds
				);
				return {
					id,
					steps,
					class: f.class,
					power: f.power,
					odds: f.odds,
					share: total > 0 ? round3(steps[steps.length - 1] / total) : 0,
					superlinear:
						steep(
							ran.map(([x]) => x),
							ran.map(([, s]) => s),
							f
						) && ran.length >= Math.ceil(steps.length / 2),
					lines: part_lines(reports[reports.length - 1], id)
				};
			}),
			lines: top_lines(reports[reports.length - 1])
		};
		g.grows = grows(g);
		return g;
	}
	const why =
		counted.length === 0
			? 'no sample replays'
			: (candidates.find((c) => c.argument === null)?.reason ?? 'no argument decides');
	if (!largest || budget.left <= budget.spent) {
		return undecided(
			base,
			'recorded',
			budget.left <= budget.spent ? `${why}; the replay budget is spent` : why
		);
	}
	return grow_scaled(m, base, largest.s, fn, cap, budget, why, odds);
}

function undecided(base: Base, source: RecordedGrowth['source'], reason: string): RecordedGrowth {
	return {
		...base,
		source,
		argument: null,
		kind: 'size',
		points: [],
		class: null,
		power: 0,
		confident: false,
		superlinear: false,
		grows: false,
		reason
	};
}

/** Each argument of the largest sample scaled at SCALED_SIZES; the steepest valid curve. */
async function grow_scaled(
	m: Measurer,
	base: Base,
	s: Sample,
	fn: Function,
	cap: number,
	budget: { left: number; spent: number },
	why: string,
	odds: OddsOptions
): Promise<RecordedGrowth> {
	const sizes = s.sizes ?? arg_sizes(s.args).sizes;
	const tried: RecordedGrowth[] = [];
	for (let i = 0; i < s.args.length; i++) {
		if (!(sizes[i] > 1) || budget.left <= budget.spent) continue;
		const kind = size_kind(s.args[i]);
		if (kind === 'size') continue;
		const count = async (k: number): Promise<GrowthPoint> => {
			const make = () => {
				const args = revive(structuredClone(s.args)) as unknown[];
				args[i] = scale_input(args[i], k);
				return { self: revive(structuredClone(s.this_value)), args };
			};
			const c = await count_call(m, base.id, fn, make, cap);
			budget.spent += c.steps;
			return {
				k,
				input_size: arg_sizes([make().args[i]]).sizes[0],
				steps: c.steps,
				stable: true,
				report: c.report
			};
		};
		let ladder: Awaited<ReturnType<typeof count_ladder>>;
		try {
			ladder = await count_ladder(SCALED_SIZES, count);
		} catch {
			continue; // the scaled input is not valid input for it
		}
		const { points, capped_at } = ladder;
		if (points.length < 3) continue;
		const fit = fit_growth(
			points.map((p) => p.k),
			points.map((p) => p.steps)
		);
		const valid = fit.class !== 'shrinks' && fit.class !== 'irregular';
		const reports = points.map((p) => p.report);
		const total = total_at_last(reports);
		const top = where_steps(points).top ?? [];
		const shares = top.map((f) => (total > 0 ? round3(f.steps[f.steps.length - 1] / total) : 0));
		// the odds of the curve and of each part that could make it a finding, over `pts`
		const read = (pts: readonly GrowthPoint[], probe: GrowthPoint | null) => {
			const from = path_from(pts.map((p) => ran_in(p.report)));
			const at = (row: number[], id: string) =>
				probe ? with_steps(points, row, probe, self_steps(probe.report, id)) : row;
			return {
				from,
				own: points_odds(
					pts,
					pts.map((p) => p.steps),
					from,
					odds
				),
				parts: top.map((f, j) =>
					f.steps[f.steps.length - 1] >= MIN_STEPS && shares[j] >= MIN_SHARE
						? points_odds(pts, at(f.steps, f.id), from, odds)
						: undefined
				)
			};
		};
		let probe: GrowthPoint | null = null;
		let read_at = read(points, null);
		// a close call, or too few sizes left after another path
		const open = (o: GrowthOdds | null | undefined) =>
			close_call(o) || (o === null && read_at.from > 0);
		if (valid && budget.left > budget.spent && (open(read_at.own) || read_at.parts.some(open))) {
			try {
				probe = await count_probe(points, count);
			} catch {
				probe = null; // the probe size is not valid input for it
			}
			if (probe) read_at = read(with_probe(points, probe), probe);
		}
		const all = with_probe(points, probe);
		const g: RecordedGrowth = {
			...base,
			source: 'scaled',
			argument: i,
			kind,
			factors: points.map((p) => p.k),
			points: points.map((p) => ({ size: p.input_size, steps: p.steps })),
			class: fit.class,
			power: fit.power,
			confident: valid,
			odds: read_at.own,
			superlinear:
				valid &&
				steep_exact(
					points.map((p) => p.steps),
					read_at.own,
					odds
				),
			grows: false,
			parts: top.map((f, j) => {
				const part: RecordedPart = {
					id: f.id,
					steps: f.steps,
					class: f.class,
					power:
						f.power ??
						fit_growth(
							points.map((p) => p.k),
							f.steps
						).power,
					share: shares[j],
					superlinear: valid && steep_exact(f.steps, read_at.parts[j], odds),
					lines: part_lines(reports[reports.length - 1], f.id)
				};
				if (read_at.parts[j] !== undefined) part.odds = read_at.parts[j];
				if (probe) part.probe_steps = self_steps(probe.report, f.id);
				return part;
			}),
			lines: top_lines(reports[reports.length - 1])
		};
		if (probe) g.probe = { factor: probe.k, size: probe.input_size, steps: probe.steps };
		if (read_at.from > 0) g.odds_from = all[read_at.from].k;
		if (!valid) g.reason = `${why}; ${growth_label(fit.class)}`;
		if (capped_at !== null) g.capped_at = capped_at;
		g.grows = grows(g);
		tried.push(g);
	}
	const rank = (g: RecordedGrowth) => (g.grows ? 2 : g.confident ? 1 : 0);
	tried.sort(
		(a, b) => rank(b) - rank(a) || b.power - a.power || (a.argument ?? 0) - (b.argument ?? 0)
	);
	return tried[0] ?? undecided(base, 'scaled', `${why}; no argument scales into valid input`);
}

/** Grow every recorded function that has samples and a handle. */
export async function run_recorded_growth(o: RecordedGrowthOptions): Promise<RecordedGrowthReport> {
	const log = o.log ?? (() => {});
	const root = o.root ?? process.cwd();
	await load_cases({ files: [], root, deps: o.deps, svelte: o.svelte, log });
	const m = new Measurer(root);
	const cap = o.cap ?? RECORDED_CAP;
	const budget = { left: o.budget_steps ?? Infinity, spent: 0 };
	const report: RecordedGrowthReport = {
		schema: RECORDED_GROWTH_SCHEMA,
		functions: [],
		skipped: {},
		steps_spent: 0
	};
	const skip = (why: string): void => {
		report.skipped[why] = (report.skipped[why] ?? 0) + 1;
	};
	const records = [...o.records]
		.filter((r) => !o.modules || o.modules.has(module_of(r.id)))
		.sort((a, b) => (a.id < b.id ? -1 : 1));
	const modules = new Map<string, Record<string, unknown> | null>();
	for (const r of records) {
		if (r.samples.filter((s) => !s.threw).length < 2) {
			skip(
				r.samples.length === 0
					? r.uncloneable > 0
						? 'not cloneable'
						: 'no samples'
					: 'too few samples'
			);
			continue;
		}
		const mod_id = module_of(r.id);
		if (!modules.has(mod_id)) {
			try {
				modules.set(
					mod_id,
					(await import(pathToFileURL(join(root, mod_id)).href)) as Record<string, unknown>
				);
			} catch (e) {
				log(`recorded growth: ${mod_id} does not load: ${(e as Error).message.split('\n')[0]}`);
				modules.set(mod_id, null);
			}
		}
		const mod = modules.get(mod_id);
		const fn = mod ? handle(mod, r.id.slice(mod_id.length + 3)) : null;
		if (!fn) {
			skip(mod ? 'not replayable' : 'module does not load');
			continue;
		}
		const g = await grow_recorded(m, r, fn, cap, budget, o.odds ?? {});
		report.functions.push(g);
		log(recorded_line(g));
	}
	report.steps_spent = budget.spent;
	return report;
}

function n(x: number): string {
	return Math.round(x).toLocaleString('en-US');
}

/** `n^1.95` with the class's words. */
function shape(cls: GrowthClass | null, power: number): string {
	if (cls === 'exponential') return 'exponentially';
	if (cls === null) return 'unknown';
	if (!is_superlinear(cls)) return growth_label(cls, power);
	return `n^${power.toFixed(2)} (${growth_label(cls, power)})`;
}

function argument_words(g: RecordedGrowth): string {
	return g.argument === null ? `its input (${g.kind})` : `argument ${g.argument} (${g.kind})`;
}

/** Where the curve comes from, in words. */
function seen_words(g: RecordedGrowth): string {
	const seen = g.call_sizes
		? `seen in ${n(g.calls)} recorded calls, sizes ${n(g.call_sizes.min)}..${n(g.call_sizes.max)}`
		: `seen in ${n(g.calls)} recorded calls`;
	const sizes = g.points.map((p) => p.size);
	if (g.source === 'recorded')
		return `${seen}; ${g.points.length} replayed, sizes ${n(sizes[0])}..${n(sizes[sizes.length - 1])}`;
	const probe = g.probe ? `, and ${g.probe.factor}x for the odds` : '';
	const from =
		g.odds_from !== undefined
			? `, odds from ${g.odds_from}x (the code took another path below)`
			: '';
	return `${seen}; the largest scaled ${g.factors!.map((k) => `${k}x`).join(' / ')} (sizes ${n(sizes[0])}..${n(sizes[sizes.length - 1])})${g.capped_at !== undefined ? `, exceeded the cap at ${g.capped_at}x` : ''}${probe}${from}`;
}

/** `, odds quadratic 97%, n log n 3%`, or '' without odds. */
function odds_tail(o: GrowthOdds | null | undefined): string {
	const w = odds_words(o);
	return w ? `, odds ${w}` : '';
}

/** The superlinear parts that make `g` a finding (itself first when it is superlinear). */
export function causes(g: RecordedGrowth): RecordedPart[] {
	return (g.parts ?? []).filter((p) => p.superlinear && p.share >= MIN_SHARE);
}

/** One result in words. */
export function recorded_text(g: RecordedGrowth, md = false): string {
	const c = md ? code : (s: string) => s;
	const own = `${c(g.id)} grows ${shape(g.class, g.power)} in ${argument_words(g)}${odds_tail(g.odds)}`;
	const parts = causes(g).filter((p) => p.id !== g.id);
	const inside =
		parts.length > 0
			? `; its steps in ${parts
					.map(
						(p) =>
							`${c(p.id)} grow ${shape(p.class, p.power)} (${Math.round(p.share * 100)}% at the largest size${odds_tail(p.odds)})`
					)
					.join(', ')}`
			: '';
	return `${own}${inside}; ${seen_words(g)}`;
}

export function recorded_line(g: RecordedGrowth): string {
	if (!g.confident) return `skip     ${g.id}  ${g.reason ?? 'undecided'}`;
	const lines = [`${g.grows ? 'GROWS   ' : 'ok      '} ${recorded_text(g)}`];
	if (g.grows) {
		for (const p of g.parts ?? [])
			lines.push(
				`           ${p.id}  ${shape(p.class, p.power)}, ${Math.round(p.share * 100)}% at the largest (${p.steps.map((s) => Math.round(s)).join(' / ')} self steps${odds_tail(p.odds)})`
			);
		for (const l of g.lines ?? [])
			lines.push(`           ${l.at}  ${Math.round(l.share * 100)}% (${n(l.steps)} steps)`);
	}
	return lines.join('\n');
}

export interface RecordedCause {
	/** The function whose own steps grow (a recorded function itself, or a part of its calls). */
	cause: string;
	class: GrowthClass | null;
	power: number;
	/** Its odds, from the finding with the steepest power. */
	odds?: GrowthOdds | null;
	/** The recorded functions it makes grow. */
	findings: RecordedGrowth[];
}

/**
 * The findings grouped by cause: every superlinear part (or the function itself, when none of its
 * parts is), most recorded functions first. One quadratic parser under twenty entry points is one
 * line, not twenty.
 */
export function recorded_findings(r: RecordedGrowthReport): RecordedCause[] {
	const groups = new Map<string, RecordedCause>();
	const add = (
		id: string,
		cls: GrowthClass | null,
		power: number,
		odds: GrowthOdds | null | undefined,
		g: RecordedGrowth
	) => {
		let grp = groups.get(id);
		if (!grp) groups.set(id, (grp = { cause: id, class: cls, power, odds, findings: [] }));
		if (power > grp.power) {
			grp.class = cls;
			grp.power = power;
			grp.odds = odds;
		}
		grp.findings.push(g);
	};
	for (const g of r.functions) {
		if (!g.grows) continue;
		const parts = causes(g);
		if (parts.length === 0) add(g.id, g.class, g.power, g.odds, g);
		for (const p of parts) add(p.id, p.class, p.power, p.odds, g);
	}
	return [...groups.values()].sort(
		(a, b) => b.findings.length - a.findings.length || (a.cause < b.cause ? -1 : 1)
	);
}

/** The markdown section: only what grows quadratically or worse, grouped by cause. */
export function render_recorded_growth(r: RecordedGrowthReport, max = 15): string {
	const lines = ['#### Growth from recorded calls', ''];
	const groups = recorded_findings(r);
	const decided = r.functions.filter((g) => g.confident).length;
	const of = `${decided} of ${r.functions.length} recorded functions decided`;
	if (groups.length === 0) {
		lines.push(`Nothing grows quadratically or worse with its input (${of}).`, '');
		return lines.join('\n');
	}
	const entry = new Set(groups.flatMap((g) => g.findings.map((f) => f.id))).size;
	lines.push(
		`${groups.length === 1 ? 'One function grows' : `${groups.length} functions grow`} quadratically or worse, under ${entry === 1 ? 'one recorded function' : `${entry} recorded functions`}, on the inputs the recorded runs passed them (${of}):`,
		''
	);
	for (const grp of groups.slice(0, max)) {
		lines.push(
			`- ${code(grp.cause)} grows ${shape(grp.class, grp.power)}${odds_tail(grp.odds)}, under ${grp.findings.length === 1 ? 'one recorded function' : `${grp.findings.length} recorded functions`}:`
		);
		for (const g of grp.findings.slice(0, 3)) {
			const share = g.parts?.find((p) => p.id === grp.cause)?.share;
			lines.push(
				`  - ${code(g.id)}: ${shape(g.class, g.power)} in ${argument_words(g)}${share !== undefined && g.id !== grp.cause ? `, ${Math.round(share * 100)}% of its steps at the largest size` : ''}; ${seen_words(g)}`
			);
		}
		if (grp.findings.length > 3) lines.push(`  - and ${grp.findings.length - 3} more`);
		const at = grp.findings[0].parts?.find((p) => p.id === grp.cause)?.lines ?? [];
		if (at.length > 0) lines.push(`  - its lines with the most steps: ${at.map(code).join(', ')}`);
	}
	if (groups.length > max) lines.push(`- and ${groups.length - max} more in the report`);
	lines.push('');
	return lines.join('\n');
}
