import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { nnls } from '../calibrate/nnls.ts';
import { FEATURES } from '../calibrate/weights.ts';
import { package_url } from '../own.ts';
import type { Prices } from '../prices.ts';
import { TREE_FEATURES, input_steps, linear_row, tree_row } from './features.ts';
import type { RangeInput } from './features.ts';
import { fit_ensemble, predict_ensemble, round_sig } from './trees.ts';
import type { Ensemble, TreeOptions } from './trees.ts';

/*
 * Steps to ns, with a range. Two parts, both fitted on the training data:
 *
 *   linear   ns = sum of ops x ns per op kind + built-in steps x w + dynamic steps x w + per call,
 *            non-negative least squares on relative error, the same fit as weights.json
 *            (calibrate/weights.ts), so it explains itself the same way
 *   trees    three ensembles of shallow boosted trees (trees.ts), one per quantile (10%, 50%,
 *            90%), each predicting log(measured / linear) from what the code is made of: its
 *            share of steps per group of kinds, its size, its allocations, its input size, its
 *            engine health
 *
 * The estimate is linear x exp(tree), at each quantile: "1.2 ms, likely 0.9 to 1.6". The 10-90%
 * range is then widened by what held-out folds of the training data missed (widening below), and
 * every row trains twice, as measured and from counts alone, because a report's units are all
 * most callers have. Nothing in the gate reads it; it is extra text next to the exact steps.
 * docs/calibration.md "Ranges" has the method and the held-out numbers.
 */

export const RANGES_SCHEMA = 'heisenbench-ranges/1';
export const QUANTILES = [0.1, 0.5, 0.9] as const;

export const DEFAULT_TREE_OPTIONS: Omit<TreeOptions, 'quantile'> = {
	rounds: 120,
	depth: 3,
	learning_rate: 0.08,
	min_leaf: 8,
	subsample: 0.8,
	seed: 1
};

export interface RangesModel {
	schema: typeof RANGES_SCHEMA;
	/** Goes up when what the model predicts changed. */
	version: number;
	/** The training data: its version (`training-*-<v>.json`), observations and content hash. */
	dataset: { version: number; observations: number; hash: string };
	prices: { version: number; hash: string };
	node: string;
	options: Omit<TreeOptions, 'quantile'>;
	/** The share of unseen times the 10-90% range is widened to hold, and by how much (log units). */
	coverage: number;
	widen: number;
	/** A change's range: its estimate times and over exp(change_widen). */
	change_widen: number;
	/** ns per unit of each linear feature (calibrate/weights.ts FEATURES). */
	linear: Record<string, number>;
	features: string[];
	quantiles: number[];
	ensembles: Ensemble[];
}

export interface RangeEstimate {
	/** The median estimate, ns per call. */
	ns: number;
	/** The 10th and 90th percentile. */
	range: [number, number];
	/** The linear part alone. */
	linear_ns: number;
}

export const DEFAULT_RANGES_PATH = package_url('ranges.json');

export interface TrainRow {
	input: RangeInput;
	ns: number;
	weight: number;
	/** Rows of one group are left out together when the range is widened. */
	group?: string;
}

/**
 * Fit the linear part: NNLS on relative error (rows over the measured ns, as calibrate/weights.ts
 * fits weights.json), each row times the square root of its weight, columns scaled to unit size
 * for the solver.
 */
export function fit_linear(rows: readonly TrainRow[], prices: Prices): Record<string, number> {
	const raw = rows.map((r) => linear_row(r.input, prices));
	const k = FEATURES.length;
	const scale = Array.from({ length: k }, (_, j) =>
		Math.max(...raw.map((x, i) => Math.abs(x[j]) / rows[i].ns), 1e-300)
	);
	const a = raw.map((x, i) => {
		const s = Math.sqrt(rows[i].weight) / rows[i].ns;
		return x.map((v, j) => (v * s) / scale[j]);
	});
	const b = rows.map((r) => Math.sqrt(r.weight));
	const z = nnls(a, b);
	const out: Record<string, number> = {};
	FEATURES.forEach((f, j) => (out[f] = round_sig(z[j] / scale[j])));
	return out;
}

/** The linear part's ns; `with_call` false leaves out the cost of the call itself (a change). */
export function linear_ns(
	x: RangeInput,
	linear: Record<string, number>,
	prices: Prices,
	with_call = true
): number {
	const row = linear_row(x, prices);
	let ns = 0;
	for (let j = 0; j < FEATURES.length; j++) {
		const f = FEATURES[j];
		if (f === 'case' && !with_call) continue;
		ns += row[j] * (linear[f] ?? 0);
	}
	return ns;
}

/** The floor of the linear part: a log needs something above 0. */
const MIN_NS = 1;

/** The linear part and the trees, before the range is widened. */
function fit_core(
	rows: readonly TrainRow[],
	prices: Prices,
	options: Omit<TreeOptions, 'quantile'>
): Pick<RangesModel, 'linear' | 'ensembles'> {
	const linear = fit_linear(rows, prices);
	// every row twice, at half its weight: as measured, and as a report's units alone tell it
	// (counts_only), so the trees learn both ways and a missing feature routes where it should
	const half = rows.map((r) => ({ ...r, weight: r.weight / 2 }));
	const both = [...half, ...half.map((r) => ({ ...r, input: counts_only(r.input) }))];
	const lin = both.map((r) => Math.max(linear_ns(r.input, linear, prices), MIN_NS));
	const x = both.map((r, i) => tree_row(r.input, lin[i]));
	const y = both.map((r, i) => Math.log(r.ns / lin[i]));
	const w = both.map((r) => r.weight);
	const ensembles = QUANTILES.map((q) => fit_ensemble(x, y, w, { ...options, quantile: q }));
	return { linear, ensembles };
}

/**
 * What a report's units alone tell of some code (a function's change, a case without engine
 * health or growth): the steps, built-in calls, allocations and calls, nothing else.
 */
export function counts_only(x: RangeInput): RangeInput {
	return {
		steps_by_kind: x.steps_by_kind,
		builtin_calls: x.builtin_calls,
		allocations: x.allocations,
		calls: x.calls,
		bytes: null,
		input_size: null,
		engine: null,
		node: null
	};
}

/** Groups dealt into `k` folds in the order of their hash: no group is split, and no luck. */
export function folds_of(keys: readonly string[], k: number): Map<string, number> {
	const h = (s: string) => createHash('sha256').update(s).digest('hex');
	const order = [...new Set(keys)]
		.map((g) => [h(g), g] as const)
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.map(([, g]) => g);
	return new Map(order.map((g, i) => [g, i % k]));
}

/** The finite-sample `coverage` quantile of conformity scores: ceil((n + 1) coverage) of n. */
function conformal(scores: number[], coverage: number): number {
	if (scores.length === 0) return 0;
	const s = [...scores].sort((a, b) => a - b);
	return round_sig(s[Math.min(s.length - 1, Math.ceil((s.length + 1) * coverage) - 1)]);
}

/** A score past every real one: a change estimated with the wrong sign is never inside. */
const WRONG_SIGN = 50;

/**
 * How far to move both ends of the ranges, in log units, so they hold `coverage` of times they
 * never saw (conformalized quantile regression). The trees are fitted again with one fold of
 * groups left out at a time; each left-out row scores how far outside its range it fell
 * (negative: inside), and the widening is the `coverage` quantile of the scores: positive widens,
 * negative narrows. A left-out change scores |log(measured / estimated)|, and its widening is
 * the whole half-width of its range.
 */
function widening(
	rows: readonly TrainRow[],
	changes: readonly TrainChange[],
	prices: Prices,
	options: Omit<TreeOptions, 'quantile'>,
	folds: number,
	coverage: number
): { widen: number; change_widen: number } {
	const groups = rows.map((r) => r.group ?? '');
	const fold = folds_of(groups, folds);
	const scores: number[] = [];
	const change_scores: number[] = [];
	for (let f = 0; f < folds; f++) {
		const train = rows.filter((_, i) => fold.get(groups[i]) !== f);
		const test = rows.filter((_, i) => fold.get(groups[i]) === f);
		if (test.length === 0 || train.length === 0) continue;
		const m = fit_core(train, prices, options);
		// scored both ways a model is asked: with all that was measured, and from counts alone
		for (const r of test) {
			for (const input of [r.input, counts_only(r.input)]) {
				const q = raw_quantiles(m, input, prices);
				const y = Math.log(r.ns / q.lin);
				scores.push(Math.max(q.q[0] - y, y - q.q[2]));
			}
		}
		for (const c of changes) {
			if (fold.get(c.group) !== f) continue;
			// a change is estimated from a function's units: counts alone
			const p = predict_change(
				{ ...m, widen: 0, change_widen: 0 },
				c.delta_steps,
				counts_only(c.context),
				prices
			);
			change_scores.push(
				Math.sign(p.ns) === Math.sign(c.measured) && p.ns !== 0
					? Math.abs(Math.log(c.measured / p.ns))
					: WRONG_SIGN
			);
		}
	}
	return {
		widen: conformal(scores, coverage),
		change_widen: Math.max(0, conformal(change_scores, coverage))
	};
}

/** A measured change of the training data: steps PR minus base, the bigger side, its time. */
export interface TrainChange {
	delta_steps: number;
	context: RangeInput;
	/** PR minus base, ns. */
	measured: number;
	group: string;
}

export interface TrainOptions {
	dataset: RangesModel['dataset'];
	node: string;
	options?: Partial<Omit<TreeOptions, 'quantile'>>;
	/** The share of unseen times the range should hold, and the folds that measure it. */
	coverage?: number;
	folds?: number;
	/** Changes whose time moved beyond noise: what the range of a change is widened on. */
	changes?: readonly TrainChange[];
}

/**
 * The widening aims at 85%, not the 80% a 10-90% range names: the folds it is measured on are
 * groups of the training data, and code at a new commit is a little further from all of them
 * than they are from each other. On the held-out evaluation 0.8 held 80 to 82% depending on the
 * seed, 0.85 held 85%.
 */
export const DEFAULT_COVERAGE = 0.85;
export const DEFAULT_FOLDS = 5;

export function train_ranges(
	rows: readonly TrainRow[],
	prices: { prices: Prices; hash: string },
	o: TrainOptions
): Omit<RangesModel, 'version'> {
	const options = { ...DEFAULT_TREE_OPTIONS, ...o.options };
	const core = fit_core(rows, prices.prices, options);
	const coverage = o.coverage ?? DEFAULT_COVERAGE;
	const folds = o.folds ?? DEFAULT_FOLDS;
	const w = widening(rows, o.changes ?? [], prices.prices, options, folds, coverage);
	return {
		schema: RANGES_SCHEMA,
		dataset: o.dataset,
		prices: { version: prices.prices.version, hash: prices.hash },
		node: o.node,
		options,
		coverage,
		widen: w.widen,
		change_widen: w.change_widen,
		linear: core.linear,
		features: [...TREE_FEATURES],
		quantiles: [...QUANTILES],
		ensembles: core.ensembles
	};
}

function raw_quantiles(
	m: Pick<RangesModel, 'linear' | 'ensembles'>,
	x: RangeInput,
	prices: Prices
): { lin: number; q: number[] } {
	const lin = Math.max(linear_ns(x, m.linear, prices), MIN_NS);
	const row = tree_row(x, lin);
	// quantiles cannot cross: sorted, the lowest is the 10th percentile
	const q = m.ensembles.map((e) => predict_ensemble(e, row)).sort((a, b) => a - b);
	return { lin, q };
}

/** The estimate of one call of some code. */
export function predict_range(
	m: Pick<RangesModel, 'linear' | 'ensembles' | 'widen'>,
	x: RangeInput,
	prices: Prices
): RangeEstimate {
	const { lin, q } = raw_quantiles(m, x, prices);
	const at = (v: number) => lin * Math.exp(v);
	// a negative widening never pulls an end past the median
	const lo = Math.min(q[0] - m.widen, q[1]);
	const hi = Math.max(q[2] + m.widen, q[1]);
	return { ns: at(q[1]), range: [at(lo), at(hi)], linear_ns: lin };
}

/**
 * The estimate of a change of `delta_steps` (PR minus base) in some code (`context`: the side
 * with more steps): the change costs what an average step of that code costs, the estimate of
 * one call without the cost of the call itself (both sides pay it) over its steps. The range is
 * that times and over exp(change_widen), the miss that held 85% of the held-out changes.
 *
 * Two other ways did worse on the training data's changes: the linear part of the changed units
 * times the code's correction (the linear part puts 0 ns on several op kinds, so a change made of
 * them came out near 0), and the difference of the two sides' estimates (a small change that
 * crosses one split of a tree moves the whole call's time).
 */
export function predict_change(
	m: Pick<RangesModel, 'linear' | 'ensembles' | 'widen' | 'change_widen'>,
	delta_steps: number,
	context: RangeInput,
	prices: Prices
): RangeEstimate {
	const steps = input_steps(context);
	if (!(steps > 0) || delta_steps === 0) return { ns: 0, range: [0, 0], linear_ns: 0 };
	const c = predict_range(m, context, prices);
	// the share of the estimate that is not the cost of the call itself
	const own = Math.max(0, 1 - (m.linear.case ?? 0) / c.linear_ns);
	const ns = (delta_steps * c.ns * own) / steps;
	const f = Math.exp(m.change_widen);
	const lo = ns / f;
	const hi = ns * f;
	return {
		ns,
		range: lo <= hi ? [lo, hi] : [hi, lo],
		linear_ns: (delta_steps * c.linear_ns * own) / steps
	};
}

/** sha256 of some files' bytes, 16 hex characters: which training data a model came from. */
export function hash_files(paths: string[]): string {
	const h = createHash('sha256');
	for (const p of paths) h.update(readFileSync(p));
	return h.digest('hex').slice(0, 16);
}

export function model_json(m: RangesModel): string {
	return JSON.stringify(m) + '\n';
}

export function load_ranges(path: string | URL = DEFAULT_RANGES_PATH): RangesModel | null {
	if (!existsSync(path)) return null;
	const m = JSON.parse(readFileSync(path, 'utf8')) as RangesModel;
	return m.schema === RANGES_SCHEMA ? m : null;
}

/** Write a model; the version goes up when what it predicts changed. */
export function write_ranges(
	path: string | URL,
	fit: Omit<RangesModel, 'version'>
): { model: RangesModel; changed: boolean } {
	const old = load_ranges(path);
	const predicts = (m: Omit<RangesModel, 'version'>) =>
		JSON.stringify([m.linear, m.ensembles, m.widen, m.change_widen]);
	const same = old !== null && predicts(old) === predicts(fit);
	const { schema, ...rest } = fit;
	const model: RangesModel = {
		schema,
		version: old ? (same ? old.version : old.version + 1) : 1,
		...rest
	};
	const text = model_json(model);
	const changed = !existsSync(path) || readFileSync(path, 'utf8') !== text;
	if (changed) writeFileSync(path, text);
	return { model, changed };
}
