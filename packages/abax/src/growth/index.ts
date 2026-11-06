import type { BenchCase } from '../bench.ts';
import { pair_cases } from '../cases.ts';
import { GROWTH_RANK, fit_growth } from './fit.ts';
import type { GrowthClass } from './fit.ts';
import { Measurer, load_cases } from './measure.ts';
import type { LoadOptions } from './measure.ts';
import { input_size, scale_input } from './scale.ts';

/*
 * Growth (spec 9): a case's input scaled to several sizes (1x / 10x / 100x by default), steps
 * counted exactly at each, and the curve class fitted. PR vs base, a class change (linear ->
 * quadratic) is a finding; the same class with more steps is not (that is the step diff's job).
 */

export const GROWTH_SCHEMA = 'abax-growth/1';

export interface GrowthCase {
	name: string;
	file: string;
	/** Scale factors measured. */
	sizes: number[];
	/** Input size at each factor (chars + elements + entries + keys). */
	input_sizes: number[];
	steps: number[];
	/** Every size counted the same twice. */
	stable: boolean;
	/** `generic` (scale_input) or `case` (the case's own `scale`). */
	scaler: 'generic' | 'case';
	class: GrowthClass | null;
	exponent: number;
	error: string | null;
}

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
		stable: true,
		scaler: own ? 'case' : 'generic',
		class: null,
		exponent: 0,
		error: null
	};
	try {
		for (const k of sizes) {
			const make = async (): Promise<unknown> => {
				const ctx = c.setup ? await c.setup() : undefined;
				return own ? own(ctx, k) : scale_input(ctx, k);
			};
			out.input_sizes.push(input_size(await make()));
			const r = await m.steps(c, make);
			out.steps.push(r.steps);
			if (!r.stable) out.stable = false;
		}
		const fit = fit_growth(sizes, out.steps);
		out.class = fit.class;
		out.exponent = Math.round(fit.exponent * 1000) / 1000;
	} catch (e) {
		out.error = e instanceof Error ? e.message : String(e);
	}
	return out;
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
				: `${g.stable ? 'ok      ' : 'UNSTABLE'} ${c.name}  ${g.class} (exponent ${g.exponent}; ${g.steps.map((s) => Math.round(s)).join(' / ')} steps)`
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
		const text = `${'`'}${b.name}${'`'} grows ${b.class} -> ${p.class}`;
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
