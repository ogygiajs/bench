import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { kind_steps } from '../audit/fit.ts';
import { case_units } from '../calibrate/weights.ts';
import type { Prices } from '../prices.ts';
import type { CaseReport } from '../report.ts';
import { package_file } from '../own.ts';
import {
	auc,
	brier,
	column_scales,
	fit_logistic,
	predict_logistic,
	reliability,
	standardize,
	zeros
} from './logistic.ts';
import type { ReliabilityBin } from './logistic.ts';

/*
 * "Will users feel it?": the odds that a step change shows up on the clock. Steps are exact, but a
 * +4% in steps is not always a +4% in time: a case that runs in 80 ns sits on the timer's grain,
 * a call costs less time than its price says, a JSON.parse more. This model learns, from the
 * labeled pairs in calibration/data/training-*.json, how likely a change of a given size and kind
 * is to make the time layer's noise rule say "slower" or "faster".
 *
 * Logistic regression on seven features of the two sides' steps (FEATURES), fitted by Newton's
 * method (logistic.ts). Trained on the pairs whose steps changed: a case whose steps did not move
 * gets no odds. Checked on held-out changes (folds split by commit and by planted change, never
 * rows of one change on both sides) against the baseline "every step change shows".
 *
 * Tried and left out, because the held-out scores got worse with them on dataset v1: how far
 * allocations, bytes and calls moved, the engine findings (worse and better), a share for string
 * work, and the input size (not in a report either). 186 changed pairs are few; a bigger dataset
 * can bring them back (docs/feel-odds.md).
 *
 * The odds are words next to the exact numbers. Pass and fail never read them.
 */

export const FEEL_SCHEMA = 'heisenbench-feel/1';

/** Where the committed model lives (package root, shipped with the npm package). */
export const FEEL_FILE = 'feel.json';

/** The counts of one side of a change. */
export interface FeelSide {
	steps: number;
	/** Steps per kind of work (`call`, `bi.JSON.parse`, `dyn.string_char`): sums to `steps`. */
	steps_by_kind: Record<string, number>;
}

export interface FeelInput {
	base: FeelSide;
	pr: FeelSide;
}

const ALLOC_KINDS = new Set(['alloc', 'alloc_word', 'new']);

/** Shares of the step change by family of work: built-ins, calls, allocations. */
function kind_shares(i: FeelInput): { builtin: number; call: number; alloc: number } {
	const kinds = new Set([...Object.keys(i.base.steps_by_kind), ...Object.keys(i.pr.steps_by_kind)]);
	let total = 0;
	const sum = { builtin: 0, call: 0, alloc: 0 };
	for (const k of [...kinds].sort()) {
		const d = Math.abs((i.pr.steps_by_kind[k] ?? 0) - (i.base.steps_by_kind[k] ?? 0));
		total += d;
		if (k.startsWith('bi.')) sum.builtin += d;
		else if (k === 'call') sum.call += d;
		else if (ALLOC_KINDS.has(k)) sum.alloc += d;
	}
	if (total === 0) return sum;
	return { builtin: sum.builtin / total, call: sum.call / total, alloc: sum.alloc / total };
}

/** The features, in the model file's order. */
export const FEATURES: ReadonlyArray<{ name: string; of: (i: FeelInput) => number }> = [
	// how far the steps moved, either way: abs(ln(pr / base))
	{ name: 'steps_moved', of: (i) => Math.abs(Math.log((i.pr.steps + 1) / (i.base.steps + 1))) },
	// how big the case is: a case of a few hundred steps sits on the timer's grain
	{ name: 'steps_size', of: (i) => Math.log10(Math.min(i.base.steps, i.pr.steps) + 1) },
	// how many steps moved
	{ name: 'steps_delta', of: (i) => Math.log10(Math.abs(i.pr.steps - i.base.steps) + 1) },
	{ name: 'faster', of: (i) => (i.pr.steps < i.base.steps ? 1 : 0) },
	// what kind of work moved: a built-in's price is its time, a call costs less than its price
	{ name: 'builtin_share', of: (i) => kind_shares(i).builtin },
	{ name: 'call_share', of: (i) => kind_shares(i).call },
	{ name: 'alloc_share', of: (i) => kind_shares(i).alloc }
];

export function feature_row(i: FeelInput): number[] {
	return FEATURES.map((f) => f.of(i));
}

// ---- the model file

export interface FeelEvaluation {
	/** Held-out folds, split by group (one commit, or one planted change at every size). */
	folds: number;
	groups: number;
	rows: number;
	positives: number;
	/** Scores of the held-out odds, on the pairs whose steps changed. */
	model: { auc: number; brier: number };
	/** "Every step change shows": odds 1 for every changed pair. */
	baseline: { auc: number; brier: number };
	/** The same on every pair, the unchanged ones given 0 by both. */
	all_pairs: {
		rows: number;
		model: { auc: number; brier: number };
		baseline: { auc: number; brier: number };
	};
	reliability: ReliabilityBin[];
}

export interface FeelModel {
	schema: typeof FEEL_SCHEMA;
	/** Which dataset it was fitted on (calibration/data/training-*-<version>.json). */
	dataset: {
		version: number;
		counts: string;
		times: string;
		/** sha256 (16 hex) of each file's bytes. */
		counts_hash: string;
		times_hash: string;
		/** The prices its steps were counted with (a diff prices the kinds with the current ones). */
		prices: { version: number; hash: string };
		pairs: number;
		/** Pairs whose steps changed (the ones fitted), and how many of them showed on the clock. */
		changed: number;
		beyond_noise: number;
		/** The machine's 1-minute load while the dataset was timed. */
		load: { min: number; mean: number; max: number; cores: number };
	};
	seed: number;
	l2: number;
	features: string[];
	/** Standardization: feature minus mean, over scale. */
	mean: number[];
	scale: number[];
	weights: number[];
	bias: number;
	evaluation: FeelEvaluation;
}

/** Six significant digits: the file does not hang on the last bit of a float. */
function r6(x: number): number {
	return Number.isFinite(x) ? Number(x.toPrecision(6)) : x;
}

/** The model's odds that this change shows up on the clock (0..1); null when the steps did not move. */
export function feel_probability(model: FeelModel, i: FeelInput): number | null {
	if (i.base.steps === i.pr.steps) return null;
	const x = standardize(feature_row(i), model);
	return predict_logistic(model, x);
}

let cached: FeelModel | null | undefined;

/** The committed model (feel.json), or null when the package has none. */
export function load_feel_model(path?: string): FeelModel | null {
	if (path === undefined && cached !== undefined) return cached;
	const file = path ?? package_file(FEEL_FILE);
	let model: FeelModel | null = null;
	if (existsSync(file)) {
		const m = JSON.parse(readFileSync(file, 'utf8')) as FeelModel;
		if (m.schema !== FEEL_SCHEMA)
			throw new Error(`heisenbench: ${file} is not a feel model (schema ${String(m.schema)})`);
		const names = FEATURES.map((f) => f.name).join(',');
		if (m.features.join(',') !== names)
			throw new Error(
				`heisenbench: ${file} was fitted on other features (retrain: heisenbench feel train)`
			);
		model = m;
	}
	if (path === undefined) cached = model;
	return model;
}

/** The model's input for one case of a diff, from its two counted reports. */
export function feel_input(base: CaseReport, pr: CaseReport, prices: Prices): FeelInput | null {
	const side = (c: CaseReport): FeelSide | null => {
		const by_kind: Record<string, number> = {};
		let sum = 0;
		for (const [k, v] of kind_steps(case_units(c), prices)) {
			by_kind[k] = v;
			sum += v;
		}
		// a report without units (from before they were kept) cannot say what kind of work moved
		if (Math.abs(sum - c.totals.steps) > 0.01 * Math.max(1, c.totals.steps)) return null;
		return { steps: c.totals.steps, steps_by_kind: by_kind };
	};
	const b = side(base);
	const p = side(pr);
	return b && p ? { base: b, pr: p } : null;
}

/** "80%": odds as the comment shows them, never 0% or 100% (the model is never that sure). */
export function odds_text(p: number): string {
	const n = Math.round(p * 100);
	if (n < 1) return 'under 1%';
	if (n > 99) return 'over 99%';
	return `${n}%`;
}

// ---- the dataset

interface CountRow {
	id: string;
	source: 'planted' | 'history';
	template?: string;
	variant?: string;
	commit?: string;
	base: FeelSide;
	pr: FeelSide;
}

interface TimeRow {
	id: string;
	group: string;
	beyond_noise: boolean;
}

export interface FeelRow {
	id: string;
	/** Held out together: one commit, or one planted change at every size. */
	group: string;
	input: FeelInput;
	/** The time layer's noise rule said slower or faster. */
	label: 0 | 1;
}

export interface FeelDataset {
	version: number;
	counts: string;
	times: string;
	counts_hash: string;
	times_hash: string;
	prices: { version: number; hash: string };
	/** Every timed pair, changed or not. */
	rows: FeelRow[];
	load: FeelModel['dataset']['load'];
}

function hash16(text: string): string {
	return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Read training-counts-<v>.json and training-times-<v>.json (calibration/data/ by default). */
export function read_feel_dataset(version: number, dir?: string): FeelDataset {
	const at = (name: string): string =>
		dir === undefined ? package_file(`calibration/data/${name}`) : `${dir}/${name}`;
	const counts = `training-counts-${version}.json`;
	const times = `training-times-${version}.json`;
	for (const f of [counts, times]) {
		if (!existsSync(at(f))) throw new Error(`heisenbench: no dataset file ${at(f)}`);
	}
	const counts_text = readFileSync(at(counts), 'utf8');
	const times_text = readFileSync(at(times), 'utf8');
	const c = JSON.parse(counts_text) as {
		prices: { version: number; hash: string };
		rows: CountRow[];
	};
	const t = JSON.parse(times_text) as {
		rows: TimeRow[];
		machine: { cores: number };
		groups: Array<{ id: string; load: { min: number; max: number; mean: number } }>;
	};
	const timed = new Map(t.rows.map((r) => [r.id, r]));
	const rows: FeelRow[] = [];
	for (const r of c.rows) {
		const tr = timed.get(r.id);
		if (!tr) continue;
		const group =
			r.source === 'planted' ? `planted/${r.template}/${r.variant}` : `history/${r.commit}`;
		const side = (s: FeelSide): FeelSide => ({ steps: s.steps, steps_by_kind: s.steps_by_kind });
		rows.push({
			id: r.id,
			group,
			input: { base: side(r.base), pr: side(r.pr) },
			label: tr.beyond_noise ? 1 : 0
		});
	}
	const used = new Set(rows.map((r) => timed.get(r.id)!.group));
	const loads = t.groups.filter((g) => used.has(g.id)).map((g) => g.load);
	const mean = loads.reduce((a, l) => a + l.mean, 0) / Math.max(1, loads.length);
	return {
		version,
		counts,
		times,
		counts_hash: hash16(counts_text),
		times_hash: hash16(times_text),
		prices: { version: c.prices.version, hash: c.prices.hash },
		rows,
		load: {
			min: r6(Math.min(...loads.map((l) => l.min))),
			mean: r6(mean),
			max: r6(Math.max(...loads.map((l) => l.max))),
			cores: t.machine.cores
		}
	};
}

// ---- training and the held-out check

export interface FeelTrainOptions {
	seed?: number;
	l2?: number;
	folds?: number;
}

export const DEFAULT_SEED = 1;
export const DEFAULT_L2 = 1;
export const DEFAULT_FOLDS = 5;

/** The pairs a model is fitted on: the ones whose steps changed. */
export function changed_rows(rows: FeelRow[]): FeelRow[] {
	return rows.filter((r) => r.input.base.steps !== r.input.pr.steps);
}

/**
 * Groups dealt to folds: sorted by a seeded hash of their name, then dealt in turn. The same seed
 * gives the same folds; a group is always on one side.
 */
export function fold_of_groups(groups: string[], folds: number, seed: number): Map<string, number> {
	const sorted = [...new Set(groups)].sort((a, b) => {
		const ha = hash16(`${seed}\0${a}`);
		const hb = hash16(`${seed}\0${b}`);
		return ha < hb ? -1 : ha > hb ? 1 : a < b ? -1 : 1;
	});
	return new Map(sorted.map((g, i) => [g, i % folds]));
}

interface Fitted {
	mean: number[];
	scale: number[];
	weights: number[];
	bias: number;
}

function fit_rows(rows: FeelRow[], l2: number): Fitted {
	const raw = rows.map((r) => feature_row(r.input));
	const s = column_scales(raw);
	const fit = fit_logistic(
		raw.map((x) => standardize(x, s)),
		rows.map((r) => r.label),
		{ l2 }
	);
	return { mean: s.mean, scale: s.scale, weights: fit.weights, bias: fit.bias };
}

/** Held-out odds of every changed pair: each fold predicted by a model fitted on the others. */
export function held_out(
	rows: FeelRow[],
	opts: FeelTrainOptions = {}
): { p: number[]; y: number[]; groups: number } {
	const folds = opts.folds ?? DEFAULT_FOLDS;
	const seed = opts.seed ?? DEFAULT_SEED;
	const l2 = opts.l2 ?? DEFAULT_L2;
	const fold = fold_of_groups(
		rows.map((r) => r.group),
		folds,
		seed
	);
	const p = zeros(rows.length);
	for (let k = 0; k < folds; k++) {
		const train = rows.filter((r) => fold.get(r.group) !== k);
		const test = rows.map((r, i) => [r, i] as const).filter(([r]) => fold.get(r.group) === k);
		if (test.length === 0) continue;
		const m = fit_rows(train, l2);
		for (const [r, i] of test) p[i] = predict_logistic(m, standardize(feature_row(r.input), m));
	}
	return { p, y: rows.map((r) => r.label), groups: fold.size };
}

function scores(p: number[], y: number[]): { auc: number; brier: number } {
	return { auc: r6(auc(p, y)), brier: r6(brier(p, y)) };
}

export function evaluate_feel(data: FeelDataset, opts: FeelTrainOptions = {}): FeelEvaluation {
	const rows = changed_rows(data.rows);
	const { p, y, groups } = held_out(rows, opts);
	const ones = rows.map(() => 1);
	const unchanged = data.rows.filter((r) => r.input.base.steps === r.input.pr.steps);
	const all_y = [...y, ...unchanged.map((r) => r.label)];
	const zeros = unchanged.map(() => 0);
	return {
		folds: opts.folds ?? DEFAULT_FOLDS,
		groups,
		rows: rows.length,
		positives: y.filter((v) => v === 1).length,
		model: scores(p, y),
		baseline: scores(ones, y),
		all_pairs: {
			rows: data.rows.length,
			model: scores([...p, ...zeros], all_y),
			baseline: scores([...ones, ...zeros], all_y)
		},
		reliability: reliability(p, y, 5).map((b) => ({
			...b,
			predicted: r6(b.predicted),
			observed: r6(b.observed)
		}))
	};
}

/** Fit the model on every changed pair of the dataset, with its held-out scores. */
export function train_feel(data: FeelDataset, opts: FeelTrainOptions = {}): FeelModel {
	const seed = opts.seed ?? DEFAULT_SEED;
	const l2 = opts.l2 ?? DEFAULT_L2;
	const rows = changed_rows(data.rows);
	const m = fit_rows(rows, l2);
	return {
		schema: FEEL_SCHEMA,
		dataset: {
			version: data.version,
			counts: data.counts,
			times: data.times,
			counts_hash: data.counts_hash,
			times_hash: data.times_hash,
			prices: data.prices,
			pairs: data.rows.length,
			changed: rows.length,
			beyond_noise: rows.filter((r) => r.label === 1).length,
			load: data.load
		},
		seed,
		l2,
		features: FEATURES.map((f) => f.name),
		mean: m.mean.map(r6),
		scale: m.scale.map(r6),
		weights: m.weights.map(r6),
		bias: r6(m.bias),
		evaluation: evaluate_feel(data, { ...opts, seed, l2 })
	};
}

/** Columns the repository's formatter fits a line in, a tab counted as 2. */
const PRINT_WIDTH = 100;

/**
 * JSON as the repository's formatter writes it: objects one key per line, a list of numbers or
 * strings on one line when it fits. The same value gives the same bytes.
 */
function json_text(v: unknown, depth: number, prefix: number): string {
	const pad = '\t'.repeat(depth + 1);
	const end = '\t'.repeat(depth);
	if (Array.isArray(v)) {
		if (v.length === 0) return '[]';
		if (v.every((x) => x === null || typeof x !== 'object')) {
			const inline = `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
			// the key before it and the comma after it count
			if (prefix + inline.length + 1 <= PRINT_WIDTH) return inline;
		}
		const items = v.map((x) => pad + json_text(x, depth + 1, (depth + 1) * 2));
		return `[\n${items.join(',\n')}\n${end}]`;
	}
	if (v !== null && typeof v === 'object') {
		const entries = Object.entries(v);
		if (entries.length === 0) return '{}';
		const items = entries.map(([k, x]) => {
			const key = `${JSON.stringify(k)}: `;
			return pad + key + json_text(x, depth + 1, (depth + 1) * 2 + key.length);
		});
		return `{\n${items.join(',\n')}\n${end}}`;
	}
	return JSON.stringify(v);
}

/** The model file's text: the same model gives the same bytes. */
export function feel_text(m: FeelModel): string {
	return json_text(m, 0, 0) + '\n';
}

/** The held-out scores as a markdown table, with the reliability table under it. */
export function render_feel_evaluation(m: FeelModel): string {
	const e = m.evaluation;
	const f = (n: number) => n.toFixed(3);
	const pct = (n: number) => `${Math.round(n * 100)}%`;
	const lines = [
		`Dataset v${m.dataset.version}: ${m.dataset.pairs} timed pairs, ${m.dataset.changed} with a step change, ${m.dataset.beyond_noise} of those beyond noise. Held out: ${e.folds} folds over ${e.groups} groups (a commit, or a planted change at every size), seed ${m.seed}.`,
		'',
		'| Pairs | Odds | AUC | Brier |',
		'| --- | --- | ---: | ---: |',
		`| ${e.rows} with a step change | this model | ${f(e.model.auc)} | ${f(e.model.brier)} |`,
		`| ${e.rows} with a step change | every step change shows | ${f(e.baseline.auc)} | ${f(e.baseline.brier)} |`,
		`| all ${e.all_pairs.rows} | this model | ${f(e.all_pairs.model.auc)} | ${f(e.all_pairs.model.brier)} |`,
		`| all ${e.all_pairs.rows} | every step change shows | ${f(e.all_pairs.baseline.auc)} | ${f(e.all_pairs.baseline.brier)} |`,
		'',
		'Reliability (held-out odds against what the clock said):',
		'',
		'| Odds | Pairs | Mean odds | Showed on the clock |',
		'| --- | ---: | ---: | ---: |'
	];
	for (const b of e.reliability) {
		lines.push(
			`| ${pct(b.from)} to ${pct(b.to)} | ${b.rows} | ${b.rows ? pct(b.predicted) : ''} | ${b.rows ? pct(b.observed) : ''} |`
		);
	}
	return lines.join('\n') + '\n';
}
