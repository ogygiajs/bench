import type { BenchCase } from '../bench.ts';
import { pair_cases } from '../cases.ts';
import { code } from '../md.ts';
import { GROWTH_RANK, fit_growth, growth_label, is_superlinear } from './fit.ts';
import type { GrowthClass } from './fit.ts';
import {
	SUPERLINEAR_ODDS,
	close_call,
	exact_odds,
	odds_superlinear,
	odds_words,
	path_from,
	pct,
	probe_size
} from './odds.ts';
import type { GrowthOdds, OddsOptions } from './odds.ts';
import { Measurer, load_cases } from './measure.ts';
import type { LoadOptions } from './measure.ts';
import { input_size, scale_input } from './scale.ts';
import { build_case_report } from '../report.ts';
import type { CaseReport } from '../report.ts';
import { StepCapError } from '../runtime/index.ts';
import { OWN_CODE, package_label } from '../identity.ts';
import { add_units } from '../units.ts';
import type { Units } from '../units.ts';
import { ContractBook } from '../contracts/declare.ts';

/*
 * Growth (spec 9): a case's input scaled to several sizes (1x / 10x / 100x by default), steps
 * counted exactly at each, and the curve class fitted. PR vs base, a class change (linear ->
 * quadratic) is a finding; the same class with more steps is not (that is the step diff's job).
 * A size whose run goes past the step cap (GROWTH_CAP) is not counted: the case "exceeded the cap
 * at" that size and is fitted on a doubling ladder of smaller sizes (count_ladder).
 *
 * Each case also has the odds of each shape (odds.ts). When the likeliest has under CLOSE_CALL, one
 * more size between the two largest is counted (`probe`: 30x between 10x and 100x), under the same
 * cap, and the odds are read again with it. The class stays fitted on the sizes asked, so a probe
 * never moves the class a PR is compared on. A change to quadratic or worse is a finding only with
 * at least SUPERLINEAR_ODDS of superlinear growth on the PR side (`unsure` below that).
 */

export const GROWTH_SCHEMA = 'heisenbench-growth/1';

export interface GrowthCase {
	name: string;
	file: string;
	/** Scale factors measured. */
	sizes: number[];
	/** Input size at each factor (chars + elements + entries + keys). */
	input_sizes: number[];
	steps: number[];
	/**
	 * What each size did, unpriced, summed over the case's functions (units.ts): the steps of each
	 * op kind, dynamic kind and built-in at each size, which the price audit compares with time.
	 */
	units?: Units[];
	/** Every size counted the same twice. */
	stable: boolean;
	/** `generic` (scale_input) or `case` (the case's own `scale`). */
	scaler: 'generic' | 'case';
	class: GrowthClass | null;
	exponent: number;
	/** The fitted power of a `polynomial` class (past quartic). */
	power?: number;
	/** The first size whose run went past the step cap (the sizes above it were not counted). */
	capped_at?: number;
	/**
	 * The first size whose run overflowed the call stack (deep recursion: the sizes above it were
	 * not counted, the class is fitted on the ones below). A finding of its own: the code
	 * recurses as deep as its input.
	 */
	overflowed_at?: number;
	/**
	 * The generic scaler grew the input but no size counted a step more or less: the work follows
	 * something the scaler does not grow (an object's keys, a number), or nothing. `constant`
	 * then says that the case's work did not move, not that the function is O(1).
	 */
	unmoved?: true;
	/**
	 * The fitted fixed part (`a` of `a + b f(k)`) as a share of the steps at the largest size, when
	 * it is half or more: the curve's class is that of the rest, and the exponent between the two
	 * largest sizes reads low (0.14 for a linear part under a 69% fixed one).
	 */
	fixed_share?: number;
	error: string | null;
	/**
	 * Where the steps are: the functions with the most self steps at the largest size (at most
	 * TOP_FUNCTIONS), each with its own curve. Absent in reports from before it was kept.
	 */
	top?: GrowthFunction[];
	/** Self steps per package at each size (`own code` for the project's), most at the largest first. */
	packages?: Array<{ package: string; steps: number[] }>;
	/** Odds of each shape (null: steps that fall, or too few sizes). Absent in older reports. */
	odds?: GrowthOdds | null;
	/** The one more size active sizing counted for the odds (not in `sizes`). */
	probe?: { size: number; input_size: number; steps: number };
	/** The size the odds were read from, when the code took another path below it (odds.ts path_from). */
	odds_from?: number;
	/**
	 * The functions with a complexity contract (contracts/) the case ran, each with its own curve
	 * inside the case. Absent when it ran none.
	 */
	contracts?: ContractCurve[];
}

/**
 * A contracted function inside a growth case: its steps per call at each size of the case, and
 * the shape they make. The size is the case's scale factor; the curve is per call, so a function
 * the case calls more often as it grows is measured on what one call costs.
 */
export interface ContractCurve {
	id: string;
	/** Inclusive steps per call at each size (0 where it did not run). */
	steps: number[];
	/** Calls at each size. */
	calls: number[];
	class: GrowthClass;
	exponent: number;
	power?: number;
	/** Odds of each shape (null: steps that fall, or too few sizes). */
	odds: GrowthOdds | null;
	/** The size the odds were read from, when the code took another path below it. */
	odds_from?: number;
	/** Steps per call at the probe size, when one was counted. */
	probe_steps?: number;
	/** The lines with the most steps under it (its own and those of what it calls) at the largest size. */
	lines: LineShare[];
}

export interface LineShare {
	/** `module:line` */
	at: string;
	steps: number;
	/** Its share of the steps of the lines counted. */
	share: number;
}

export interface GrowthFunction {
	id: string;
	steps: number[];
	class: GrowthClass;
	exponent: number;
	power?: number;
}

/** How many functions a growth case names as where its steps are. */
export const TOP_FUNCTIONS = 5;

export interface GrowthReport {
	schema: typeof GROWTH_SCHEMA;
	sizes: number[];
	cases: GrowthCase[];
}

export interface GrowthOptions extends LoadOptions {
	sizes?: number[];
	/** Steps one run may take (default GROWTH_CAP). */
	cap?: number;
	/** Only the cases that declare their own `scale` (default: every case, the rest scaled generically). */
	scaled?: boolean;
	/** Prior and bar of the growth odds. */
	odds?: OddsOptions;
	log?: (line: string) => void;
}

export const DEFAULT_SIZES = [1, 10, 100];

/**
 * Steps one run of a growth case may take. A run past it is stopped where it loops (the runtime's
 * step cap): the case is said to exceed the cap at that size, and is grown on smaller sizes instead.
 */
export const GROWTH_CAP = 1e10;

/** One counted size of a curve: its steps and its report (self steps per function). */
export interface GrowthPoint {
	k: number;
	input_size: number;
	steps: number;
	stable: boolean;
	report: CaseReport;
}

/** A run that overflowed the call stack (deep recursion on a grown input). */
export function is_stack_overflow(e: unknown): boolean {
	return e instanceof RangeError && /maximum call stack size exceeded/i.test(e.message);
}

/** Why a size was not counted: past the step cap, or past the call stack; null for another error. */
function stop_of(e: unknown, overflow: boolean): 'cap' | 'stack' | null {
	if (e instanceof StepCapError) return 'cap';
	if (overflow && is_stack_overflow(e)) return 'stack';
	return null;
}

/**
 * Count `count(k)` at every size of `sizes` (ascending), with the step cap. At the first size
 * that goes past the cap, or overflows the call stack, growing stops there and falls back to a
 * doubling ladder (1, 2, 4, 8 ...) of the sizes below it that were not counted yet, each under the
 * same cap, so a curve too steep for the sizes asked (an exponential at 10x), or a recursion too
 * deep at 100x, still gets the points it can afford. `capped_at` / `overflowed_at`: the size it
 * stopped at, and why. An overflow stops growing only with `overflow` (a growth case); otherwise
 * it is thrown like any error (a proof must not take a candidate that overflows for one that
 * stopped).
 */
export async function count_ladder(
	sizes: readonly number[],
	count: (k: number) => Promise<GrowthPoint>,
	overflow = false
): Promise<{ points: GrowthPoint[]; capped_at: number | null; overflowed_at: number | null }> {
	const points: GrowthPoint[] = [];
	let stop: { k: number; why: 'cap' | 'stack' } | null = null;
	for (const k of sizes) {
		try {
			points.push(await count(k));
		} catch (e) {
			const why = stop_of(e, overflow);
			if (why === null) throw e;
			stop = { k, why };
			break;
		}
	}
	if (stop !== null) {
		const done = new Set(points.map((p) => p.k));
		for (let k = 1; k < stop.k; k *= 2) {
			if (done.has(k)) continue;
			try {
				points.push(await count(k));
			} catch (e) {
				const why = stop_of(e, overflow);
				if (why === null) throw e;
				stop = { k, why };
				break;
			}
		}
		points.sort((a, b) => a.k - b.k);
		// a ladder size past the new stop is not measured; neither is any size above it
		const at = stop.k;
		points.splice(0, points.length, ...points.filter((p) => p.k < at));
	}
	return {
		points,
		capped_at: stop?.why === 'cap' ? stop.k : null,
		overflowed_at: stop?.why === 'stack' ? stop.k : null
	};
}

/** Self steps per function and per package at each point, and their curves. */
export function where_steps(points: readonly GrowthPoint[]): Pick<GrowthCase, 'top' | 'packages'> {
	const per_fn = new Map<string, number[]>();
	const per_pkg = new Map<string, number[]>();
	const add = (into: Map<string, number[]>, key: string, i: number, n: number): void => {
		let row = into.get(key);
		if (!row) into.set(key, (row = points.map(() => 0)));
		row[i] += n;
	};
	points.forEach((p, i) => {
		for (const f of p.report.functions) {
			if (f.self_steps === 0) continue;
			add(per_fn, f.id, i, f.self_steps);
			add(per_pkg, package_label(f.module) ?? OWN_CODE, i, f.self_steps);
		}
	});
	const ks = points.map((p) => p.k);
	const last = points.length - 1;
	const most = (a: [string, number[]], b: [string, number[]]): number =>
		b[1][last] - a[1][last] || (a[0] < b[0] ? -1 : 1);
	return {
		top: [...per_fn]
			.sort(most)
			.slice(0, TOP_FUNCTIONS)
			.map(([id, steps]) => {
				const f = fit_growth(ks, steps);
				const g: GrowthFunction = { id, steps, class: f.class, exponent: round3(f.exponent) };
				if (f.class === 'polynomial') g.power = f.power;
				return g;
			}),
		packages: [...per_pkg].sort(most).map(([p, steps]) => ({ package: p, steps }))
	};
}

/** Lines named per result. */
const TOP_LINES = 5;

/**
 * The lines with the most self steps in a report; with `only`, among those functions' lines
 * alone (the share is of their steps).
 */
export function top_lines(report: CaseReport, only?: ReadonlySet<string>): LineShare[] {
	// a line that holds a function and a callback is one line
	const by_at = new Map<string, number>();
	let total = 0;
	for (const f of report.functions) {
		if (only && !only.has(f.id)) continue;
		for (const l of f.lines) {
			if (l.steps <= 0) continue;
			const at = `${f.module}:${l.line}`;
			by_at.set(at, (by_at.get(at) ?? 0) + l.steps);
			total += l.steps;
		}
	}
	const all = [...by_at].map(([at, steps]) => ({ at, steps }));
	all.sort((a, b) => b.steps - a.steps || (a.at < b.at ? -1 : 1));
	return all
		.slice(0, TOP_LINES)
		.map((l) => ({ ...l, share: total > 0 ? round3(l.steps / total) : 0 }));
}

/** `id` and every function it reaches through the report's call edges. */
export function reached_from(report: CaseReport, id: string): Set<string> {
	const out = new Set([id]);
	const callees = new Map<string, string[]>();
	for (const e of report.edges) {
		let to = callees.get(e.from);
		if (!to) callees.set(e.from, (to = []));
		to.push(e.to);
	}
	const todo = [id];
	while (todo.length > 0) {
		for (const to of callees.get(todo.pop()!) ?? []) {
			if (out.has(to)) continue;
			out.add(to);
			todo.push(to);
		}
	}
	return out;
}

/** One function's steps per call in a report (0 when it did not run), and its calls. */
function per_call(report: CaseReport, id: string): { steps: number; calls: number } {
	const f = report.functions.find((x) => x.id === id);
	return f && f.calls > 0
		? { steps: f.inclusive_steps / f.calls, calls: f.calls }
		: { steps: 0, calls: 0 };
}

/**
 * The curves of the contracted functions `ids` over counted points (the odds read later, once the
 * probe is in).
 */
function contract_curves(points: readonly GrowthPoint[], ids: readonly string[]): ContractCurve[] {
	const ks = points.map((p) => p.k);
	const last = points[points.length - 1].report;
	return ids.map((id) => {
		const at = points.map((p) => per_call(p.report, id));
		const steps = at.map((x) => x.steps);
		const f = fit_growth(ks, steps);
		const curve: ContractCurve = {
			id,
			steps,
			calls: at.map((x) => x.calls),
			class: f.class,
			exponent: round3(f.exponent),
			odds: null,
			lines: top_lines(last, reached_from(last, id))
		};
		if (f.class === 'polynomial') curve.power = f.power;
		return curve;
	});
}

/** The functions with self steps in a report. */
export function ran_in(report: CaseReport): Set<string> {
	const out = new Set<string>();
	for (const f of report.functions) if (f.self_steps > 0) out.add(f.id);
	return out;
}

/** Counted points with the one more size of active sizing, in size order. */
export function with_probe(
	points: readonly GrowthPoint[],
	probe: GrowthPoint | null
): GrowthPoint[] {
	return probe ? [...points, probe].sort((a, b) => a.k - b.k) : [...points];
}

/**
 * The odds of a curve over counted points, read from where their last path starts (odds.ts
 * path_from); `steps` is the curve's value at each point (a case's steps, or one function's).
 */
export function points_odds(
	points: readonly GrowthPoint[],
	steps: readonly number[],
	from: number,
	opts: OddsOptions = {}
): GrowthOdds | null {
	// after another path, two sizes say only how much the steps rose, not along which curve
	if (from > 0 && points.length - from < 3) return null;
	return exact_odds(
		points.slice(from).map((p) => p.k),
		steps.slice(from),
		opts
	);
}

/**
 * Active sizing, for odds that are a close call: one more size between the two largest, counted
 * under the cap. The probe point, or null (no whole size between, or it went past the cap).
 */
export async function count_probe(
	points: readonly GrowthPoint[],
	count: (k: number) => Promise<GrowthPoint>
): Promise<GrowthPoint | null> {
	const k = probe_size(points.map((p) => p.k));
	if (k === null || points.some((p) => p.k === k)) return null;
	try {
		return await count(k);
	} catch (e) {
		if (!(e instanceof StepCapError)) throw e;
		return null;
	}
}

/**
 * Grow one case: the input at every size, counted. `contracted`: of the functions the case ran,
 * the ids with a complexity contract, whose own curves the case keeps (`contracts`).
 */
export async function grow_case(
	c: BenchCase,
	m: Measurer,
	sizes: number[] = DEFAULT_SIZES,
	cap = GROWTH_CAP,
	odds: OddsOptions = {},
	contracted: (ran: ReadonlySet<string>) => string[] = () => []
): Promise<GrowthCase> {
	const own = c.scale;
	const out: GrowthCase = {
		name: c.name,
		file: c.file,
		sizes,
		input_sizes: [],
		steps: [],
		units: [],
		stable: true,
		scaler: own ? 'case' : 'generic',
		class: null,
		exponent: 0,
		error: null
	};
	try {
		const count = async (k: number): Promise<GrowthPoint> => {
			const make = async (): Promise<unknown> => {
				const ctx = c.setup ? await c.setup() : undefined;
				return own ? own(ctx, k) : scale_input(ctx, k);
			};
			const size = input_size(await make());
			const r = await m.steps(c, make, cap);
			const report = build_case_report(m.rt, r.snap, {
				name: c.name,
				file: c.file,
				stable: r.stable,
				timers: 0,
				runaway: false,
				error: null
			});
			return { k, input_size: size, steps: r.steps, stable: r.stable, report };
		};
		const { points, capped_at, overflowed_at } = await count_ladder(sizes, count, true);
		out.sizes = points.map((p) => p.k);
		out.input_sizes = points.map((p) => p.input_size);
		out.steps = points.map((p) => p.steps);
		out.units = points.map((p) => {
			const units: Units = {};
			for (const f of p.report.functions) if (f.units) add_units(units, f.units);
			return units;
		});
		out.stable = points.every((p) => p.stable);
		if (capped_at !== null) out.capped_at = capped_at;
		if (overflowed_at !== null) out.overflowed_at = overflowed_at;
		if (points.length < 2) {
			out.error =
				overflowed_at !== null
					? `overflowed the call stack at size ${overflowed_at}x, with fewer than two smaller sizes to fit`
					: `exceeded the cap of ${cap} steps at size ${capped_at}x, with fewer than two smaller sizes to fit`;
			return out;
		}
		const fit = fit_growth(out.sizes, out.steps);
		out.class = fit.class;
		out.exponent = round3(fit.exponent);
		if (fit.class === 'polynomial') out.power = fit.power;
		const last = out.steps[out.steps.length - 1];
		if (
			!own &&
			fit.class === 'constant' &&
			out.steps.every((s) => s === out.steps[0]) &&
			out.input_sizes[out.input_sizes.length - 1] > out.input_sizes[0]
		) {
			out.unmoved = true;
		} else if (
			fit.class !== 'constant' &&
			GROWTH_RANK[fit.class] !== null &&
			fit.a > 0 &&
			last > 0 &&
			fit.a / last >= FIXED_SHARE
		) {
			out.fixed_share = Math.round((fit.a / last) * 100) / 100;
		}
		Object.assign(out, where_steps(points));
		const read = (pts: readonly GrowthPoint[]) => {
			const from = path_from(pts.map((p) => ran_in(p.report)));
			return {
				from,
				odds: points_odds(
					pts,
					pts.map((p) => p.steps),
					from,
					odds
				)
			};
		};
		const ran = new Set<string>();
		for (const p of points) for (const id of ran_in(p.report)) ran.add(id);
		const curves = contract_curves(points, contracted(ran));
		// a contract's curve: its odds over the points (with the probe's per-call steps in place)
		const curve_odds = (cv: ContractCurve, pts: readonly GrowthPoint[], from: number) =>
			points_odds(
				pts,
				pts.map((p) => per_call(p.report, cv.id).steps),
				from,
				odds
			);
		const first = read(points);
		// a close call, or too few sizes left after another path: on the case or on a contract
		const open = (o: GrowthOdds | null) => close_call(o) || (o === null && first.from > 0);
		const want = open(first.odds) || curves.some((cv) => open(curve_odds(cv, points, first.from)));
		const probe = want ? await count_probe(points, count) : null;
		const all = with_probe(points, probe);
		const r = probe ? read(all) : first;
		out.odds = r.odds;
		if (r.from > 0) out.odds_from = all[r.from].k;
		if (probe) out.probe = { size: probe.k, input_size: probe.input_size, steps: probe.steps };
		for (const cv of curves) {
			cv.odds = curve_odds(cv, all, r.from);
			if (r.from > 0) cv.odds_from = all[r.from].k;
			if (probe) cv.probe_steps = per_call(probe.report, cv.id).steps;
		}
		if (curves.length > 0) out.contracts = curves;
	} catch (e) {
		out.error = e instanceof Error ? e.message : String(e);
	}
	return out;
}

export function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

/** `71% acorn@8.15.0, 20% own code`: each package's share of the case at its largest size. */
export function growth_shares(g: GrowthCase, min = 0.01): string {
	const total = g.steps[g.steps.length - 1];
	if (!g.packages || !(total > 0)) return '';
	return g.packages
		.map((p) => [p.package, p.steps[p.steps.length - 1] / total] as const)
		.filter(([, share]) => share >= min)
		.map(([p, share]) => `${Math.round(share * 100)}% ${p}`)
		.join(', ');
}

/** Under a case's line: where its steps are at the largest size, and its top functions' curves. */
function growth_lines(g: GrowthCase): string[] {
	if (!g.top || g.top.length === 0) return [];
	const at = g.sizes[g.sizes.length - 1];
	const lines = [`           at ${at}x: ${growth_shares(g)}`];
	for (const f of g.top) {
		lines.push(
			`           ${f.id}  ${growth_label(f.class, f.power)} (exponent ${f.exponent}; ${f.steps.map((s) => Math.round(s)).join(' / ')} self steps)`
		);
	}
	for (const cv of g.contracts ?? []) {
		const o = odds_words(cv.odds);
		lines.push(
			`           contract ${cv.id}  ${growth_label(cv.class, cv.power)} (exponent ${cv.exponent}; ${cv.steps.map((s) => Math.round(s)).join(' / ')} steps per call${o ? `; odds ${o}` : ''})`
		);
	}
	return lines;
}

/** `; odds quadratic 93%, n log n 7% (with 30x)`, or '' without odds. */
export function odds_note(g: Pick<GrowthCase, 'odds' | 'probe' | 'odds_from'>): string {
	if (!g.odds) return '';
	const extra = [
		g.probe ? `with ${g.probe.size}x` : '',
		g.odds_from !== undefined ? `from ${g.odds_from}x, where the code took another path` : ''
	].filter(Boolean);
	return `; odds ${odds_words(g.odds)}${extra.length > 0 ? ` (${extra.join('; ')})` : ''}`;
}

/**
 * `exceeded the cap at 10x, grown on 1x / 2x / 4x / 8x` (or `overflowed the call stack at
 * 100x, ...`), or '' when every size was counted.
 */
export function capped_words(g: Pick<GrowthCase, 'capped_at' | 'overflowed_at' | 'sizes'>): string {
	const grown = g.sizes.map((k) => `${k}x`).join(' / ');
	if (g.overflowed_at !== undefined)
		return `; overflowed the call stack at ${g.overflowed_at}x, grown on ${grown}`;
	if (g.capped_at === undefined) return '';
	return `; exceeded the cap at ${g.capped_at}x, grown on ${grown}`;
}

/** A fixed part this large (of the steps at the largest size) is said in the verdict. */
export const FIXED_SHARE = 0.5;

/**
 * What the class alone would mislead about: steps that never moved while the generic scaler grew
 * the input, or a fixed part that makes the exponent read low. '' otherwise.
 */
export function verdict_note(
	g: Pick<GrowthCase, 'unmoved' | 'fixed_share' | 'input_sizes' | 'sizes' | 'class' | 'power'>
): string {
	if (g.unmoved) {
		const from = g.input_sizes[0];
		const to = g.input_sizes[g.input_sizes.length - 1];
		return `; no step moved while the generic scaler grew the input from ${from} to ${to}: it grows strings, arrays, Maps, Sets and chains, not an object's keys or a number. If the work follows those, give the case a \`scale\``;
	}
	if (g.fixed_share !== undefined) {
		const at = g.sizes[g.sizes.length - 1];
		return `; ${Math.round(g.fixed_share * 100)}% of the steps at ${at}x are a fixed part, the rest grows ${growth_label(g.class, g.power)}`;
	}
	return '';
}

export async function run_growth(opts: GrowthOptions): Promise<GrowthReport> {
	const sizes = opts.sizes ?? DEFAULT_SIZES;
	const log = opts.log ?? (() => {});
	const loaded = await load_cases(opts);
	const list = opts.scaled ? loaded.filter((c) => c.scale !== undefined) : loaded;
	const m = new Measurer(opts.root);
	const report: GrowthReport = { schema: GROWTH_SCHEMA, sizes, cases: [] };
	// the contracts of every module loaded so far (a case can import more as it runs)
	const book = new ContractBook();
	const contracted = (ran: ReadonlySet<string>): string[] => {
		book.read(m.rt.modules.map((r) => r.meta));
		return [...ran].filter((id) => book.contracts.has(id)).sort();
	};
	for (const c of list) {
		const g = await grow_case(c, m, sizes, opts.cap, opts.odds, contracted);
		report.cases.push(g);
		log(
			g.error
				? `FAILED   ${c.name}: ${g.error}`
				: [
						`${g.stable ? 'ok      ' : 'UNSTABLE'} ${c.name}  ${growth_label(g.class, g.power)} (exponent ${g.exponent}; ${g.steps.map((s) => Math.round(s)).join(' / ')} steps${odds_note(g)}${capped_words(g)}${verdict_note(g)})`,
						...growth_lines(g)
					].join('\n')
		);
	}
	return report;
}

export interface GrowthFinding {
	case: string;
	base: GrowthClass;
	pr: GrowthClass;
	text: string;
}

export interface GrowthDiff {
	findings: GrowthFinding[];
	better: GrowthFinding[];
	/** Same class, steps at the largest size changed: shown, never a finding. */
	same: Array<{ case: string; class: GrowthClass; ratio: number }>;
	/**
	 * A side whose steps fell as its input grew (`shrinks`, `irregular`): the scaled input is
	 * likely not valid input, so no class change is read from it. Shown, never a finding.
	 */
	unclear: Array<{ case: string; text: string }>;
	/**
	 * A change to quadratic or worse whose odds of superlinear growth are under the bar (PR side):
	 * shown, never a finding. Absent in diffs from before growth had odds.
	 */
	unsure?: Array<{ case: string; text: string }>;
	failed: string[];
}

export function diff_growth(
	base: GrowthReport,
	pr: GrowthReport,
	opts: OddsOptions = {}
): GrowthDiff {
	const out: GrowthDiff = {
		findings: [],
		better: [],
		same: [],
		unclear: [],
		unsure: [],
		failed: []
	};
	for (const [b, p] of pair_cases(base.cases, pr.cases).pairs) {
		if (b.error || p.error || !b.class || !p.class) {
			out.failed.push(b.name);
			continue;
		}
		const top = p.top?.[0];
		const shares = growth_shares(p);
		const where = top
			? `; most self steps in ${code(top.id)} (${growth_label(top.class, top.power)})${shares ? `, ${shares}` : ''}`
			: '';
		const text = `${code(b.name)} grows ${growth_label(b.class, b.power)} -> ${growth_label(p.class, p.power)}${where}${odds_note(p)}${capped_words(p)}`;
		const br = GROWTH_RANK[b.class];
		const pr_rank = GROWTH_RANK[p.class];
		if (br === null || pr_rank === null) {
			if (b.class !== p.class) out.unclear.push({ case: b.name, text });
		} else if (pr_rank > br) {
			// a report from before odds (p.odds undefined) keeps the class rule alone
			const bar = opts.min_odds ?? SUPERLINEAR_ODDS;
			if (is_superlinear(p.class) && p.odds !== undefined && !odds_superlinear(p.odds, opts)) {
				out.unsure!.push({
					case: b.name,
					text: `${text}; superlinear ${pct(p.odds?.superlinear ?? 0)}, under ${pct(bar)}`
				});
				continue;
			}
			out.findings.push({ case: b.name, base: b.class, pr: p.class, text });
		} else if (pr_rank < br) {
			out.better.push({ case: b.name, base: b.class, pr: p.class, text });
		} else {
			const bl = b.steps[b.steps.length - 1];
			const pl = p.steps[p.steps.length - 1];
			if (bl > 0 && bl !== pl) {
				out.same.push({ case: b.name, class: p.class, ratio: Math.round((pl / bl) * 100) / 100 });
			}
		}
	}
	return out;
}
