import type { BenchCase } from '../bench.ts';
import { pair_cases } from '../cases.ts';
import { code } from '../md.ts';
import { GROWTH_RANK, fit_growth, growth_label } from './fit.ts';
import type { GrowthClass } from './fit.ts';
import { Measurer, load_cases } from './measure.ts';
import type { LoadOptions } from './measure.ts';
import { input_size, scale_input } from './scale.ts';
import { build_case_report } from '../report.ts';
import type { CaseReport } from '../report.ts';
import { StepCapError } from '../runtime/index.ts';
import { OWN_CODE, package_label } from '../identity.ts';
import { add_units } from '../units.ts';
import type { Units } from '../units.ts';

/*
 * Growth (spec 9): a case's input scaled to several sizes (1x / 10x / 100x by default), steps
 * counted exactly at each, and the curve class fitted. PR vs base, a class change (linear ->
 * quadratic) is a finding; the same class with more steps is not (that is the step diff's job).
 * A size whose run goes past the step cap (GROWTH_CAP) is not counted: the case "exceeded the cap
 * at" that size and is fitted on a doubling ladder of smaller sizes (count_ladder).
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
	error: string | null;
	/**
	 * Where the steps are: the functions with the most self steps at the largest size (at most
	 * TOP_FUNCTIONS), each with its own curve. Absent in reports from before it was kept.
	 */
	top?: GrowthFunction[];
	/** Self steps per package at each size (`own code` for the project's), most at the largest first. */
	packages?: Array<{ package: string; steps: number[] }>;
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

/**
 * Count `count(k)` at every size of `sizes` (ascending), with the step cap. At the first size
 * that goes past the cap, growing stops there and falls back to a doubling ladder (1, 2, 4, 8 ...)
 * of the sizes below it that were not counted yet, each under the same cap, so a curve too steep
 * for the sizes asked (an exponential at 10x) still gets the points it can afford.
 */
export async function count_ladder(
	sizes: readonly number[],
	count: (k: number) => Promise<GrowthPoint>
): Promise<{ points: GrowthPoint[]; capped_at: number | null }> {
	const points: GrowthPoint[] = [];
	let capped_at: number | null = null;
	for (const k of sizes) {
		try {
			points.push(await count(k));
		} catch (e) {
			if (!(e instanceof StepCapError)) throw e;
			capped_at = k;
			break;
		}
	}
	if (capped_at !== null) {
		const done = new Set(points.map((p) => p.k));
		for (let k = 1; k < capped_at; k *= 2) {
			if (done.has(k)) continue;
			try {
				points.push(await count(k));
			} catch (e) {
				if (!(e instanceof StepCapError)) throw e;
				capped_at = k;
				break;
			}
		}
		points.sort((a, b) => a.k - b.k);
		// a ladder size past the new cap point is not measured; neither is any size above it
		const cap = capped_at;
		points.splice(0, points.length, ...points.filter((p) => p.k < cap));
	}
	return { points, capped_at };
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

/** Grow one case: the input at every size, counted. */
export async function grow_case(
	c: BenchCase,
	m: Measurer,
	sizes: number[] = DEFAULT_SIZES,
	cap = GROWTH_CAP
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
		const { points, capped_at } = await count_ladder(sizes, count);
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
		if (points.length < 2) {
			out.error = `exceeded the cap of ${cap} steps at size ${capped_at}x, with fewer than two smaller sizes to fit`;
			return out;
		}
		const fit = fit_growth(out.sizes, out.steps);
		out.class = fit.class;
		out.exponent = round3(fit.exponent);
		if (fit.class === 'polynomial') out.power = fit.power;
		Object.assign(out, where_steps(points));
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
	return lines;
}

/** `exceeded the cap at 10x, grown on 1x / 2x / 4x / 8x`, or '' when no size was capped. */
export function capped_words(g: Pick<GrowthCase, 'capped_at' | 'sizes'>): string {
	if (g.capped_at === undefined) return '';
	return `; exceeded the cap at ${g.capped_at}x, grown on ${g.sizes.map((k) => `${k}x`).join(' / ')}`;
}

export async function run_growth(opts: GrowthOptions): Promise<GrowthReport> {
	const sizes = opts.sizes ?? DEFAULT_SIZES;
	const log = opts.log ?? (() => {});
	const loaded = await load_cases(opts);
	const list = opts.scaled ? loaded.filter((c) => c.scale !== undefined) : loaded;
	const m = new Measurer(opts.root);
	const report: GrowthReport = { schema: GROWTH_SCHEMA, sizes, cases: [] };
	for (const c of list) {
		const g = await grow_case(c, m, sizes, opts.cap);
		report.cases.push(g);
		log(
			g.error
				? `FAILED   ${c.name}: ${g.error}`
				: [
						`${g.stable ? 'ok      ' : 'UNSTABLE'} ${c.name}  ${growth_label(g.class, g.power)} (exponent ${g.exponent}; ${g.steps.map((s) => Math.round(s)).join(' / ')} steps${capped_words(g)})`,
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
	failed: string[];
}

export function diff_growth(base: GrowthReport, pr: GrowthReport): GrowthDiff {
	const out: GrowthDiff = { findings: [], better: [], same: [], unclear: [], failed: [] };
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
		const text = `${code(b.name)} grows ${growth_label(b.class, b.power)} -> ${growth_label(p.class, p.power)}${where}${capped_words(p)}`;
		const br = GROWTH_RANK[b.class];
		const pr_rank = GROWTH_RANK[p.class];
		if (br === null || pr_rank === null) {
			if (b.class !== p.class) out.unclear.push({ case: b.name, text });
		} else if (pr_rank > br) {
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
