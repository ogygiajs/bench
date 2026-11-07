import { FEATURES } from '../calibrate/weights.ts';
import type { Weights } from '../calibrate/weights.ts';
import type { Prices } from '../prices.ts';
import { linear_row, main_group } from './features.ts';
import type { RangeInput } from './features.ts';
import { changes_of, weights_of } from './dataset.ts';
import type { Observation } from './dataset.ts';
import {
	QUANTILES,
	counts_only,
	folds_of,
	linear_ns,
	predict_change,
	predict_range,
	train_ranges
} from './model.ts';
import type { TrainOptions, TrainRow } from './model.ts';
import { weighted_quantile } from './trees.ts';

/*
 * Held-out evaluation. The groups (dataset.ts: by change, or stricter, by code) are dealt into
 * folds; each fold is predicted by a model trained on the others, so every observation is
 * predicted once by a model that never saw its change (or its code). Three estimates side by side:
 *
 *   weights   the committed steps -> ns weights (weights.json, fitted on the calibration corpus)
 *             with the range a real-cost estimate gives them today (their absolute spread)
 *   linear    the same non-negative fit refitted on the training folds, with the training folds'
 *             10th to 90th percentile of measured / estimated as its range
 *   model     the linear part times boosted quantile trees (model.ts), from counts alone
 *             (counts_only), as reports and diffs ask it: they have no engine health or input
 *             size for a function
 *   model_full  the same model given all that was measured (engine health, input size, bytes)
 *
 * Changes are scored the same way, on the pairs whose time moved beyond noise: a change of the
 * weights or of the linear fit is its changed units through the fit; the model's is
 * predict_change.
 */

export type SplitBy = 'change' | 'code';
export type Method = 'weights' | 'linear' | 'model' | 'model_full';
export const METHODS: Method[] = ['weights', 'linear', 'model', 'model_full'];

export interface Prediction {
	id: string;
	measured: number;
	ns: number;
	range: [number, number];
}

export interface MethodScore {
	/** Median of |estimate - measured|, ns. */
	median_abs_ns: number;
	/** Median and mean of |ln(estimate / measured)|. */
	median_log: number;
	mean_log: number;
	/** Share of measured times inside the range. */
	coverage: number;
	/** Median of the range's high end over its low end. */
	median_width: number;
}

/** How an estimate of a change (PR minus base, ns) did against the measured change. */
export interface ChangeScore {
	/** Median of |estimate - measured| / |measured|. */
	median_rel: number;
	/** Share with the sign of the measured change. */
	sign: number;
	coverage: number;
	median_width: number;
}

export interface CoverageRow {
	bucket: string;
	n: number;
	coverage: Record<Method, number>;
	/** Median |ln(estimate / measured)|. */
	median_log: Record<Method, number>;
}

export interface Evaluation {
	split: SplitBy;
	folds: number;
	groups: number;
	observations: number;
	scores: Record<Method, MethodScore>;
	/** The pairs whose time moved beyond noise: each estimate of the change against the measured. */
	changes: { pairs: number; scores: Record<Method, ChangeScore> };
	tables: Record<'source' | 'input_size' | 'kind' | 'time' | 'load', CoverageRow[]>;
}

function median(xs: number[]): number {
	if (xs.length === 0) return NaN;
	const s = [...xs].sort((a, b) => a - b);
	const h = s.length >> 1;
	return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

const inside = (p: Prediction): boolean => p.measured >= p.range[0] && p.measured <= p.range[1];
const log_err = (p: Prediction): number => Math.abs(Math.log(p.ns / p.measured));
const ordered = (a: number, b: number): [number, number] => (a <= b ? [a, b] : [b, a]);

function score(ps: Prediction[]): MethodScore {
	const logs = ps.map(log_err);
	return {
		median_abs_ns: median(ps.map((p) => Math.abs(p.ns - p.measured))),
		median_log: median(logs),
		mean_log: logs.reduce((s, v) => s + v, 0) / Math.max(1, logs.length),
		coverage: ps.filter(inside).length / Math.max(1, ps.length),
		median_width: median(ps.map((p) => p.range[1] / p.range[0]))
	};
}

function change_score(ps: Prediction[]): ChangeScore {
	const n = Math.max(1, ps.length);
	return {
		median_rel: median(ps.map((p) => Math.abs(p.ns - p.measured) / Math.abs(p.measured))),
		sign: ps.filter((p) => Math.sign(p.ns) === Math.sign(p.measured)).length / n,
		coverage: ps.filter(inside).length / n,
		median_width: median(
			ps.map((p) => (p.range[0] * p.range[1] > 0 ? p.range[1] / p.range[0] : Infinity))
		)
	};
}

const SIZES = ['under 100', '100 to 1K', '1K to 10K', '10K to 100K', '100K or more', 'unknown'];
function size_bucket(n: number | null | undefined): string {
	if (n === null || n === undefined) return 'unknown';
	if (n < 100) return SIZES[0];
	if (n < 1_000) return SIZES[1];
	if (n < 10_000) return SIZES[2];
	if (n < 100_000) return SIZES[3];
	return SIZES[4];
}

const TIMES = ['under 1 µs', '1 to 10 µs', '10 to 100 µs', '100 µs to 1 ms', '1 ms or more'];
function time_bucket(ns: number): string {
	if (ns < 1e3) return TIMES[0];
	if (ns < 1e4) return TIMES[1];
	if (ns < 1e5) return TIMES[2];
	if (ns < 1e6) return TIMES[3];
	return TIMES[4];
}

const LOADS = ['under 10', '10 to 12', '12 to 14', '14 or more'];
function load_bucket(l: number): string {
	if (l < 10) return LOADS[0];
	if (l < 12) return LOADS[1];
	if (l < 14) return LOADS[2];
	return LOADS[3];
}

function table(
	obs: readonly Observation[],
	key: (o: Observation) => string,
	order: string[] | null,
	p: Record<Method, Map<string, Prediction>>
): CoverageRow[] {
	const by = new Map<string, Observation[]>();
	for (const o of obs) by.set(key(o), [...(by.get(key(o)) ?? []), o]);
	const keys = order ? order.filter((k) => by.has(k)) : [...by.keys()].sort();
	return keys.map((k) => {
		const list = by.get(k)!;
		const of = <T>(f: (m: Method) => T): Record<Method, T> =>
			Object.fromEntries(METHODS.map((m) => [m, f(m)])) as Record<Method, T>;
		return {
			bucket: k,
			n: list.length,
			coverage: of((m) => list.filter((o) => inside(p[m].get(o.id)!)).length / list.length),
			median_log: of((m) => median(list.map((o) => log_err(p[m].get(o.id)!))))
		};
	});
}

/** ns of the committed weights for a linear row (the call itself in it or not). */
function weights_ns(row: number[], w: Weights): number {
	let ns = 0;
	for (let j = 0; j < FEATURES.length; j++) ns += row[j] * (w.ns[FEATURES[j]] ?? 0);
	return ns;
}

/** Steps by kind of PR minus base. */
function delta_input(base: RangeInput, pr: RangeInput): RangeInput {
	const steps_by_kind: Record<string, number> = { ...pr.steps_by_kind };
	for (const [k, v] of Object.entries(base.steps_by_kind))
		steps_by_kind[k] = (steps_by_kind[k] ?? 0) - v;
	return { steps_by_kind };
}

export interface EvaluateOptions {
	split: SplitBy;
	folds?: number;
	tree?: TrainOptions['options'];
	coverage?: number;
	/** The committed weights: the baseline a real-cost estimate uses today. */
	weights: Weights;
	prices: { prices: Prices; hash: string };
}

/** Out-of-fold predictions of the estimates, and their scores. */
export function evaluate_ranges(obs: readonly Observation[], o: EvaluateOptions): Evaluation {
	const k = o.folds ?? 5;
	const group = (x: Observation) => (o.split === 'change' ? x.change : x.code);
	const folds = folds_of(obs.map(group), k);
	const prices = o.prices.prices;
	const spread = o.weights.fit.spread?.absolute ?? [1, 1, 1];
	const p: Record<Method, Map<string, Prediction>> = {
		weights: new Map(),
		linear: new Map(),
		model: new Map(),
		model_full: new Map()
	};
	const c: Record<Method, Prediction[]> = { weights: [], linear: [], model: [], model_full: [] };
	const all_changes = changes_of(obs, group);
	const by_pair = new Map<string, Observation[]>();
	for (const x of obs) by_pair.set(x.pair, [...(by_pair.get(x.pair) ?? []), x]);
	for (const x of obs) {
		const ns = Math.max(weights_ns(linear_row(x.input, prices), o.weights), 1);
		p.weights.set(x.id, { id: x.id, measured: x.ns, ns, range: [ns * spread[0], ns * spread[2]] });
	}
	for (let f = 0; f < k; f++) {
		const train = obs.filter((x) => folds.get(group(x)) !== f);
		const test = obs.filter((x) => folds.get(group(x)) === f);
		if (test.length === 0) continue;
		const w = weights_of(train);
		const rows: TrainRow[] = train.map((x, i) => ({
			input: x.input,
			ns: x.ns,
			weight: w[i],
			group: group(x)
		}));
		const fit = train_ranges(rows, o.prices, {
			dataset: { version: 0, observations: rows.length, hash: '' },
			node: '',
			options: o.tree,
			coverage: o.coverage,
			folds: k,
			changes: all_changes.filter((ch) => folds.get(ch.group) !== f)
		});
		// the explainable baseline: the linear part alone, its range its misses on these folds
		const lin = fit.linear;
		const miss = rows.map((r) => r.ns / Math.max(linear_ns(r.input, lin, prices), 1));
		const lo = weighted_quantile(miss, w, QUANTILES[0]);
		const hi = weighted_quantile(miss, w, QUANTILES[2]);
		for (const x of test) {
			const m = predict_range(fit, counts_only(x.input), prices);
			p.model.set(x.id, { id: x.id, measured: x.ns, ns: m.ns, range: m.range });
			const full = predict_range(fit, x.input, prices);
			p.model_full.set(x.id, { id: x.id, measured: x.ns, ns: full.ns, range: full.range });
			const l = Math.max(linear_ns(x.input, lin, prices), 1);
			p.linear.set(x.id, { id: x.id, measured: x.ns, ns: l, range: [l * lo, l * hi] });
		}
		for (const ch of all_changes.filter((x) => folds.get(x.group) === f)) {
			const sides = by_pair.get(ch.id)!;
			const d = delta_input(
				sides.find((x) => x.side === 'base')!.input,
				sides.find((x) => x.side === 'pr')!.input
			);
			const m = predict_change(fit, ch.delta_steps, counts_only(ch.context), prices);
			c.model.push({ id: ch.id, measured: ch.measured, ns: m.ns, range: m.range });
			const full = predict_change(fit, ch.delta_steps, ch.context, prices);
			c.model_full.push({ id: ch.id, measured: ch.measured, ns: full.ns, range: full.range });
			const ln = linear_ns(d, lin, prices, false);
			c.linear.push({ id: ch.id, measured: ch.measured, ns: ln, range: ordered(ln * lo, ln * hi) });
			const row = linear_row(d, prices);
			row[row.length - 1] = 0;
			const wn = weights_ns(row, o.weights);
			c.weights.push({
				id: ch.id,
				measured: ch.measured,
				ns: wn,
				range: ordered(wn * spread[0], wn * spread[2])
			});
		}
	}
	const tab = (key: (x: Observation) => string, order: string[] | null = null) =>
		table(obs, key, order, p);
	const scores = Object.fromEntries(
		METHODS.map((m) => [m, score(obs.map((x) => p[m].get(x.id)!))])
	) as Record<Method, MethodScore>;
	return {
		split: o.split,
		folds: k,
		groups: new Set(obs.map(group)).size,
		observations: obs.length,
		scores,
		changes: {
			pairs: c.model.length,
			scores: Object.fromEntries(METHODS.map((m) => [m, change_score(c[m])])) as Record<
				Method,
				ChangeScore
			>
		},
		tables: {
			source: tab((x) => x.source),
			input_size: tab((x) => size_bucket(x.input.input_size), SIZES),
			kind: tab((x) => main_group(x.input)),
			time: tab((x) => time_bucket(x.ns), TIMES),
			load: tab((x) => load_bucket(x.load), LOADS)
		}
	};
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const x2 = (v: number): string => (Number.isFinite(v) ? `${v.toFixed(2)}x` : '-');
const log3 = (v: number): string => v.toFixed(3);

function ns_words(ns: number): string {
	const a = Math.abs(ns);
	if (a >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
	if (a >= 1e3) return `${(ns / 1e3).toFixed(1)} µs`;
	return `${ns.toFixed(0)} ns`;
}

const WORDS: Record<Method, string> = {
	weights: 'weights.json (today)',
	linear: 'linear part alone, refitted',
	model: 'model, from counts (as reports use it)',
	model_full: 'model, with engine health and input size'
};

/** The evaluation as markdown: scores, then coverage by group. */
export function render_evaluation(e: Evaluation): string {
	const out: string[] = [
		`${e.groups} groups in ${e.folds} folds, ${e.observations} timed sides.`,
		'',
		'| Estimate | Median abs error | Median log error | Mean log error | Inside 10-90% | Median width |',
		'| --- | ---: | ---: | ---: | ---: | ---: |'
	];
	for (const m of METHODS) {
		const s = e.scores[m];
		out.push(
			`| ${WORDS[m]} | ${ns_words(s.median_abs_ns)} | ${log3(s.median_log)} | ${log3(s.mean_log)} | ${pct(s.coverage)} | ${x2(s.median_width)} |`
		);
	}
	out.push(
		'',
		`Changes: the ${e.changes.pairs} pairs whose time moved beyond noise, the estimate of PR minus base against the measured change.`,
		'',
		'| Estimate | Median error | Right sign | Inside the range | Median width |',
		'| --- | ---: | ---: | ---: | ---: |'
	);
	for (const m of METHODS) {
		const s = e.changes.scores[m];
		out.push(
			`| ${WORDS[m]} | ${pct(s.median_rel)} | ${pct(s.sign)} | ${pct(s.coverage)} | ${x2(s.median_width)} |`
		);
	}
	const titles: Record<keyof Evaluation['tables'], string> = {
		source: 'By source',
		input_size: 'By input size',
		kind: 'By unit kind (the group holding most of the steps)',
		time: 'By measured time',
		load: 'By load average while timed'
	};
	for (const [t, rows] of Object.entries(e.tables) as Array<
		[keyof Evaluation['tables'], CoverageRow[]]
	>) {
		out.push(
			'',
			`${titles[t]}:`,
			'',
			'| Group | Sides | Model inside | With engine inside | Linear inside | Weights inside | Model log error | Linear log error |',
			'| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
		);
		for (const r of rows) {
			out.push(
				`| ${r.bucket} | ${r.n} | ${pct(r.coverage.model)} | ${pct(r.coverage.model_full)} | ${pct(r.coverage.linear)} | ${pct(r.coverage.weights)} | ${log3(r.median_log.model)} | ${log3(r.median_log.linear)} |`
			);
		}
	}
	return out.join('\n') + '\n';
}
