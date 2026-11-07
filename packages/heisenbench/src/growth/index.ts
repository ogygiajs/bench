import type { BenchCase } from '../bench.ts';
import { pair_cases } from '../cases.ts';
import { code } from '../md.ts';
import { GROWTH_RANK, fit_growth } from './fit.ts';
import type { GrowthClass } from './fit.ts';
import { Measurer, load_cases } from './measure.ts';
import type { LoadOptions } from './measure.ts';
import { input_size, scale_input } from './scale.ts';
import { build_case_report } from '../report.ts';
import { OWN_CODE, package_label } from '../identity.ts';
import { add_units } from '../units.ts';
import type { Units } from '../units.ts';

/*
 * Growth (spec 9): a case's input scaled to several sizes (1x / 10x / 100x by default), steps
 * counted exactly at each, and the curve class fitted. PR vs base, a class change (linear ->
 * quadratic) is a finding; the same class with more steps is not (that is the step diff's job).
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
	/** Only the cases that declare their own `scale` (default: every case, the rest scaled generically). */
	scaled?: boolean;
	log?: (line: string) => void;
}

export const DEFAULT_SIZES = [1, 10, 100];

/** Grow one case: the input at every size, counted. */
export async function grow_case(
	c: BenchCase,
	m: Measurer,
	sizes: number[] = DEFAULT_SIZES
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
		// function id -> self steps at each size; package -> self steps at each size
		const per_fn = new Map<string, number[]>();
		const per_pkg = new Map<string, number[]>();
		const add = (into: Map<string, number[]>, key: string, i: number, n: number): void => {
			let row = into.get(key);
			if (!row) into.set(key, (row = sizes.map(() => 0)));
			row[i] += n;
		};
		for (let i = 0; i < sizes.length; i++) {
			const k = sizes[i];
			const make = async (): Promise<unknown> => {
				const ctx = c.setup ? await c.setup() : undefined;
				return own ? own(ctx, k) : scale_input(ctx, k);
			};
			out.input_sizes.push(input_size(await make()));
			const r = await m.steps(c, make);
			out.steps.push(r.steps);
			if (!r.stable) out.stable = false;
			const report = build_case_report(m.rt, r.snap, {
				name: c.name,
				file: c.file,
				stable: r.stable,
				timers: 0,
				runaway: false,
				error: null
			});
			const units: Units = {};
			for (const f of report.functions) if (f.units) add_units(units, f.units);
			out.units!.push(units);
			for (const f of report.functions) {
				if (f.self_steps === 0) continue;
				add(per_fn, f.id, i, f.self_steps);
				add(per_pkg, package_label(f.module) ?? OWN_CODE, i, f.self_steps);
			}
		}
		const fit = fit_growth(sizes, out.steps);
		out.class = fit.class;
		out.exponent = round3(fit.exponent);
		const last = sizes.length - 1;
		const most = (a: [string, number[]], b: [string, number[]]): number =>
			b[1][last] - a[1][last] || (a[0] < b[0] ? -1 : 1);
		out.top = [...per_fn]
			.sort(most)
			.slice(0, TOP_FUNCTIONS)
			.map(([id, steps]) => {
				const f = fit_growth(sizes, steps);
				return { id, steps, class: f.class, exponent: round3(f.exponent) };
			});
		out.packages = [...per_pkg].sort(most).map(([p, steps]) => ({ package: p, steps }));
	} catch (e) {
		out.error = e instanceof Error ? e.message : String(e);
	}
	return out;
}

function round3(n: number): number {
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
			`           ${f.id}  ${f.class} (exponent ${f.exponent}; ${f.steps.map((s) => Math.round(s)).join(' / ')} self steps)`
		);
	}
	return lines;
}

export async function run_growth(opts: GrowthOptions): Promise<GrowthReport> {
	const sizes = opts.sizes ?? DEFAULT_SIZES;
	const log = opts.log ?? (() => {});
	const loaded = await load_cases(opts);
	const list = opts.scaled ? loaded.filter((c) => c.scale !== undefined) : loaded;
	const m = new Measurer(opts.root);
	const report: GrowthReport = { schema: GROWTH_SCHEMA, sizes, cases: [] };
	for (const c of list) {
		const g = await grow_case(c, m, sizes);
		report.cases.push(g);
		log(
			g.error
				? `FAILED   ${c.name}: ${g.error}`
				: [
						`${g.stable ? 'ok      ' : 'UNSTABLE'} ${c.name}  ${g.class} (exponent ${g.exponent}; ${g.steps.map((s) => Math.round(s)).join(' / ')} steps)`,
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
	failed: string[];
}

export function diff_growth(base: GrowthReport, pr: GrowthReport): GrowthDiff {
	const out: GrowthDiff = { findings: [], better: [], same: [], failed: [] };
	for (const [b, p] of pair_cases(base.cases, pr.cases).pairs) {
		if (b.error || p.error || !b.class || !p.class) {
			out.failed.push(b.name);
			continue;
		}
		const top = p.top?.[0];
		const shares = growth_shares(p);
		const where = top
			? `; most self steps in ${code(top.id)} (${top.class})${shares ? `, ${shares}` : ''}`
			: '';
		const text = `${code(b.name)} grows ${b.class} -> ${p.class}${where}`;
		if (GROWTH_RANK[p.class] > GROWTH_RANK[b.class]) {
			out.findings.push({ case: b.name, base: b.class, pr: p.class, text });
		} else if (GROWTH_RANK[p.class] < GROWTH_RANK[b.class]) {
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
