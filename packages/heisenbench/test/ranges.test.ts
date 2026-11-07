import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { load_weights } from '../src/calibrate/weights.ts';
import { estimate_case } from '../src/calibrate/estimate.ts';
import { load_prices } from '../src/prices.ts';
import type { CaseReport } from '../src/report.ts';
import { change_range, units_range, usable } from '../src/ranges/apply.ts';
import { changes_of, load_dataset, weights_of } from '../src/ranges/dataset.ts';
import { input_of_units, main_group, tree_row, TREE_FEATURES } from '../src/ranges/features.ts';
import {
	calibrate_ranges,
	DEFAULT_DATA_DIR,
	DEFAULT_DATASET_VERSION
} from '../src/ranges/index.ts';
import {
	DEFAULT_RANGES_PATH,
	folds_of,
	load_ranges,
	predict_change,
	predict_range
} from '../src/ranges/model.ts';
import { range_text } from '../src/ranges/text.ts';
import { fit_ensemble, predict_ensemble, rng, weighted_quantile } from '../src/ranges/trees.ts';
import { cost_text, real_cost } from '../src/weight/cost.ts';
import { temp_dir } from './helpers.ts';

const prices = load_prices();

test('weighted quantile: the smallest value whose weight reaches the share', () => {
	assert.equal(weighted_quantile([3, 1, 2], [1, 1, 1], 0.5), 2);
	assert.equal(weighted_quantile([3, 1, 2], [1, 1, 1], 0.1), 1);
	assert.equal(weighted_quantile([3, 1, 2], [1, 1, 1], 0.9), 3);
	// a heavy row pulls the quantile to itself
	assert.equal(weighted_quantile([1, 2, 3], [1, 10, 1], 0.9), 2);
});

test('boosted quantile trees: the 10/50/90% of a noisy line, the same trees from the same seed', () => {
	const draw = rng(7);
	const x: number[][] = [];
	const y: number[] = [];
	for (let i = 0; i < 600; i++) {
		const a = draw() * 10;
		x.push([a, draw()]);
		// uniform noise of width 2 around 2a: the 10th and 90th percentiles are 2a - 0.8 and 2a + 0.8
		y.push(2 * a + (draw() * 2 - 1));
	}
	const w = y.map(() => 1);
	const opts = { rounds: 150, depth: 3, learning_rate: 0.1, min_leaf: 10, subsample: 0.8, seed: 3 };
	const fits = [0.1, 0.5, 0.9].map((q) => fit_ensemble(x, y, w, { ...opts, quantile: q }));
	for (const a of [2, 5, 8]) {
		const [lo, mid, hi] = fits.map((e) => predict_ensemble(e, [a, 0.5]));
		assert.ok(Math.abs(mid - 2 * a) < 0.5, `median at ${a}: ${mid}`);
		assert.ok(Math.abs(lo - (2 * a - 0.8)) < 0.6, `10% at ${a}: ${lo}`);
		assert.ok(Math.abs(hi - (2 * a + 0.8)) < 0.6, `90% at ${a}: ${hi}`);
	}
	const again = fit_ensemble(x, y, w, { ...opts, quantile: 0.5 });
	assert.equal(JSON.stringify(again), JSON.stringify(fits[1]));
	const other = fit_ensemble(x, y, w, { ...opts, quantile: 0.5, seed: 4 });
	assert.notEqual(JSON.stringify(other), JSON.stringify(fits[1]));
});

test('a missing feature goes down the side most training rows went', () => {
	// feature 0 decides; rows above 5 are 10 higher; most rows are below 5
	const x: number[][] = [];
	const y: number[] = [];
	for (let i = 0; i < 100; i++) {
		const a = i < 70 ? 1 : 9;
		x.push([a]);
		y.push(a > 5 ? 10 : 0);
	}
	const e = fit_ensemble(
		x,
		y,
		y.map(() => 1),
		{ quantile: 0.5, rounds: 30, depth: 1, learning_rate: 0.5, min_leaf: 5, subsample: 1, seed: 1 }
	);
	assert.ok(predict_ensemble(e, [NaN]) < 1);
	assert.ok(predict_ensemble(e, [9]) > 9);
});

test('held-out folds never split a group, and every group lands in one', () => {
	const keys = ['a', 'a', 'b', 'c', 'c', 'c', 'd', 'e', 'f'];
	const f = folds_of(keys, 3);
	assert.equal(f.size, 6);
	for (const v of f.values()) assert.ok(v >= 0 && v < 3);
	assert.deepEqual(folds_of([...keys].reverse(), 3), f);
});

test('the training data: two sides per pair, groups by change and by code, quiet groups weigh more', () => {
	// version 1 (a busy machine) stays readable beside version 2 (a quiet one)
	for (const v of [1, 2]) assert.equal(load_dataset(DEFAULT_DATA_DIR, v).observations.length, 950);
	const d = load_dataset(DEFAULT_DATA_DIR, DEFAULT_DATASET_VERSION);
	const o = d.observations;
	// an undo is the same change as the change it undoes
	const loop = o.find((x) => x.pair === 'planted/answer-extra-loop-n20')!;
	const undo = o.find((x) => x.pair === 'planted/answer-undo-extra-loop-n20')!;
	assert.equal(loop.change, undo.change);
	assert.equal(loop.code, 'planted/answer');
	// a commit is one change group, a bench file one code group
	const h = o.filter((x) => x.source === 'history');
	assert.ok(new Set(h.map((x) => x.change)).size >= 17);
	assert.ok(h.every((x) => x.code.startsWith('history/packages/') && x.code.endsWith('.ts')));
	assert.equal(new Set(o.map((x) => x.code)).size, 16);
	assert.ok(weights_of(o).every((v) => v > 0));
	// a row timed at twice the load weighs half; the same code timed twice weighs half each
	const one = { ...loop, load: 10, fingerprint: 'a' };
	assert.deepEqual(weights_of([one, { ...one, load: 20, fingerprint: 'b' }]), [1, 0.5]);
	assert.deepEqual(weights_of([one, { ...one }]), [0.5, 0.5]);
	const changes = changes_of(o, (x) => x.change);
	assert.ok(changes.length >= 70);
	assert.ok(changes.every((c) => c.delta_steps !== 0 && c.measured !== 0));
});

test('the committed model is what the training data and seed give, byte for byte', () => {
	const dir = temp_dir('heisenbench-ranges-');
	const a = join(dir, 'a.json');
	const b = join(dir, 'b.json');
	const committed = readFileSync(DEFAULT_RANGES_PATH, 'utf8');
	// a retrain over the committed file leaves it as it is (its version included)
	writeFileSync(a, committed);
	assert.equal(calibrate_ranges({ out: a }).changed, false);
	const bytes = readFileSync(a, 'utf8');
	assert.equal(bytes, committed);
	// two retrains from nothing: the same bytes
	const c = join(dir, 'c.json');
	calibrate_ranges({ out: b });
	calibrate_ranges({ out: c });
	assert.equal(readFileSync(b, 'utf8'), readFileSync(c, 'utf8'));
	const m = load_ranges(a)!;
	assert.equal(m.dataset.version, 2);
	assert.equal(m.dataset.observations, 950);
	assert.equal(m.features.length, TREE_FEATURES.length);
	assert.equal(m.prices.hash, prices.hash);
	assert.ok(bytes.length < 120_000, `${bytes.length} bytes`);
});

test('an estimate: the range holds the median, more of the same work takes longer', () => {
	const m = load_ranges()!;
	assert.ok(usable(m, prices.hash));
	assert.ok(!usable(m, 'another-prices'));
	const small = units_range(
		m,
		{ call: 100, branch: 2000, compare: 2000, arith: 2000 },
		prices.prices
	);
	const big = units_range(
		m,
		{ call: 10_000, branch: 200_000, compare: 200_000, arith: 200_000 },
		prices.prices
	);
	for (const r of [small, big]) assert.ok(r.range[0] <= r.ns && r.ns <= r.range[1]);
	assert.ok(big.ns > small.ns * 5, `${small.ns} -> ${big.ns}`);
	// the trees see the same row for the same units: the same estimate
	const x = input_of_units({ call: 10, branch: 20 }, prices.prices);
	assert.deepEqual(predict_range(m, x, prices.prices), predict_range(m, x, prices.prices));
	assert.equal(tree_row(x, 100).length, TREE_FEATURES.length);
	assert.equal(main_group(x), 'call');
});

test('a change: its sign is the steps’ sign, it grows with the change, none without one', () => {
	const m = load_ranges()!;
	const base = { call: 100, branch: 2000, compare: 2000 };
	const more = { call: 100, branch: 4000, compare: 4000 };
	const most = { call: 100, branch: 8000, compare: 8000 };
	const up = change_range(m, base, more, prices.prices)!;
	const way_up = change_range(m, base, most, prices.prices)!;
	const down = change_range(m, more, base, prices.prices)!;
	assert.ok(up.ns > 0 && down.ns < 0);
	assert.ok(way_up.ns > up.ns);
	assert.ok(up.range[0] > 0 && up.range[0] <= up.ns && up.ns <= up.range[1]);
	assert.ok(down.range[1] < 0 && down.range[0] <= down.ns && down.ns <= down.range[1]);
	assert.equal(change_range(m, base, { ...base }, prices.prices), null);
	// a new function: all of it is the change
	const fresh = change_range(m, null, base, prices.prices)!;
	assert.ok(fresh.ns > 0);
	const p = predict_change(m, 0, input_of_units(base, prices.prices), prices.prices);
	assert.equal(p.ns, 0);
});

test('range text: one unit for all three numbers, signed for a change', () => {
	assert.equal(range_text({ ns: 1.2e6, range: [0.9e6, 1.6e6] }), '1.2 ms, likely 0.9 to 1.6');
	assert.equal(
		range_text({ ns: 4200, range: [1500, 12_000] }, true),
		'+4.2 µs, likely +1.5 to +12'
	);
	assert.equal(range_text({ ns: -35, range: [-80, -12] }, true), '−35 ns, likely −80 to −12');
});

test('the case estimate and the real cost carry the model next to the weights, which stay as they were', () => {
	const m = load_ranges()!;
	const w = load_weights()!;
	const c = {
		name: 'loop',
		file: 'a.bench.ts',
		totals: { steps: 6000, allocations: 0, bytes: 0, calls: 100 },
		functions: [{ units: { call: 100, branch: 2000, compare: 2000, arith: 2000 } }]
	} as unknown as CaseReport;
	const plain = estimate_case(c, w, prices.prices);
	const with_model = estimate_case(c, w, prices.prices, m);
	assert.equal(plain.model, undefined);
	assert.equal(with_model.ns, plain.ns);
	assert.equal(with_model.time_led, plain.time_led);
	assert.ok(with_model.model!.range[0] <= with_model.model!.ns);
	assert.equal(with_model.model!.version, m.version);

	const unit = {
		key: 'real request',
		traffic: {
			profiles: {},
			requests: 1,
			window_ms: 0,
			start: null,
			end: null,
			sampled_ms: 1,
			mapped_ms: 1,
			unmatched: []
		}
	};
	const fw = {
		calls: 40,
		self_steps: 0,
		inclusive_steps: 0,
		self_ns: 0,
		samples: 0,
		calls_counted: true
	};
	const input = {
		delta_steps: 300,
		delta_units: { branch: 300 },
		ref_steps: 104,
		ref_units: { call: 1, branch: 100 },
		kind: 'self' as const,
		per_call: true
	};
	const ctx = { ns_weights: w, prices: prices.prices, requests_per_day: 86_400 };
	const before = real_cost(fw, unit, input, { ...ctx, ranges: null })!;
	const after = real_cost(fw, unit, input, { ...ctx, ranges: m })!;
	assert.equal(before.model, undefined);
	const { model, ...rest } = after;
	assert.deepEqual(rest, before);
	assert.ok(model!.ns > 0 && model!.range[0] <= model!.ns && model!.ns <= model!.range[1]);
	assert.match(cost_text(after), /; model [\d.]+ CPU-\w+\/day, likely [\d.]+ to [\d.]+$/);
});
