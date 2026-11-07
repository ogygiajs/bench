import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TREND_DEFAULTS, detect_trend } from '../src/trend/index.ts';
import { segment } from '../src/trend/segment.ts';
import {
	PLANTED_TRENDS,
	churn,
	normal,
	planted_series,
	seeded,
	trend_answer
} from '../src/trend/planted.ts';

for (const p of PLANTED_TRENDS) {
	test(`trend: planted ${p.name} (${p.what})`, () => {
		assert.deepEqual(trend_answer(detect_trend(planted_series(p.moves))), p.expect);
	});
}

test('trend: five 1% PRs among flat commits: +5.1% over 9 commits, in 5 rises', () => {
	const p = PLANTED_TRENDS.find((x) => x.name === 'creep')!;
	const r = detect_trend(planted_series(p.moves));
	assert.equal(r.creeps.length, 1);
	const c = r.creeps[0];
	assert.deepEqual([c.start, c.end, c.commits, c.rises], ['c12', 'c20', 9, 5]);
	assert.ok(Math.abs(c.ratio - (1.01 ** 5 - 1)) < 1e-4, `ratio ${c.ratio}`);
	assert.equal(c.reverted_at, null);
});

test('trend: a creep given back names the commit that gave it back', () => {
	const p = PLANTED_TRENDS.find((x) => x.name === 'creep-revert')!;
	const c = detect_trend(planted_series(p.moves)).creeps[0];
	assert.equal(c.status, 'reverted');
	assert.equal(c.reverted_at, 'c21');
	assert.equal(c.end, 'c15');
});

test('trend: a step is never part of a creep, and a big one is never creep alone', () => {
	for (const size of [0.02, 0.05, 0.1, 0.5, 3]) {
		const r = detect_trend(planted_series([0, 0, 0, 0, 0, 0, 0, 0, size, 0, 0, 0, 0, 0, 0, 0]));
		assert.equal(r.verdict, 'step', `a ${size * 100}% step`);
		assert.deepEqual(
			r.steps.map((s) => s.sha),
			['c08']
		);
	}
	// just under the step size: one commit, not a trend either
	assert.equal(detect_trend(planted_series([0, 0, 0, 0, 0, 0.019, 0, 0, 0, 0])).verdict, 'flat');
});

test('trend: the same series gives the same answer, byte for byte', () => {
	for (const p of PLANTED_TRENDS) {
		const a = JSON.stringify(detect_trend(planted_series(p.moves)));
		const b = JSON.stringify(detect_trend(planted_series([...p.moves])));
		assert.equal(a, b, p.name);
	}
});

test('trend: points that were not counted are skipped, not read as a fall', () => {
	const p = PLANTED_TRENDS.find((x) => x.name === 'creep')!;
	const series = planted_series(p.moves).map((pt, i) =>
		i === 5 || i === 25 ? { ...pt, steps: null } : pt
	);
	const r = detect_trend(series);
	assert.equal(r.points, p.moves.length - 2);
	assert.deepEqual(trend_answer(r), p.expect);
});

test('trend: a rise that came with a new counter is counted as such', () => {
	const p = PLANTED_TRENDS.find((x) => x.name === 'creep')!;
	const series = planted_series(p.moves).map((pt, i) => ({ ...pt, counter: i < 14 ? 'a' : 'b' }));
	const r = detect_trend(series);
	assert.equal(r.creeps[0].counter_changes, 1);
	const steps = planted_series([0, 0, 0, 0.1, 0, 0]).map((pt, i) => ({
		...pt,
		counter: i < 3 ? 'a' : 'b'
	}));
	assert.equal(detect_trend(steps).steps[0].counter_changed, true);
});

test('trend: on churn alone, about 1 case in 100 shows a creep at most', () => {
	let false_creeps = 0;
	let runs = 0;
	for (const sd of [0.002, 0.005, 0.01]) {
		for (let seed = 1; seed <= 200; seed++) {
			if (detect_trend(planted_series(churn(40, sd, seed * 31))).creeps.length > 0) false_creeps++;
			runs++;
		}
	}
	// sparse churn: a commit touches the case one time in five, by 0.6% or so
	for (let seed = 1; seed <= 200; seed++) {
		const r = seeded(seed * 97);
		const m = Array.from({ length: 40 }, () => (r() < 0.2 ? 0.006 * normal(r) : 0));
		if (detect_trend(planted_series(m)).creeps.length > 0) false_creeps++;
		runs++;
	}
	assert.ok(false_creeps / runs <= 0.015, `${false_creeps} of ${runs}`);
});

test('trend: a creep on churn is found at its first commit, or one off, nearly always', () => {
	let exact = 0;
	let near = 0;
	const n = 200;
	for (let seed = 1; seed <= n; seed++) {
		const m = churn(40, 0.003, seed * 13);
		for (let i = 15; i < 23; i++) m[i] += 0.01;
		const c = detect_trend(planted_series(m)).creeps;
		if (c.some((k) => k.start_index === 15)) exact++;
		if (c.some((k) => Math.abs(k.start_index - 15) <= 1)) near++;
	}
	assert.ok(exact / n >= 0.8, `exact ${exact} of ${n}`);
	assert.ok(near / n >= 0.95, `within one ${near} of ${n}`);
});

test('trend: the options are checked, and each one changes what it says', () => {
	assert.throws(() => detect_trend([], { sigma_pct: 0 }), /sigma_pct/);
	assert.throws(() => detect_trend([], { min_rises: 1.5 }), /min_rises/);
	assert.throws(() => detect_trend([], { cut_penalty: -1 }), /cut_penalty/);
	const p = PLANTED_TRENDS.find((x) => x.name === 'creep')!;
	const series = planted_series(p.moves);
	assert.equal(detect_trend(series, { min_rise: 0.06 }).verdict, 'flat');
	assert.equal(detect_trend(series, { min_rises: 6 }).verdict, 'flat');
	// with 1% steps, each rise is a step
	assert.equal(detect_trend(series, { step_ratio: 0.009 }).verdict, 'step');
	assert.deepEqual(Object.keys(TREND_DEFAULTS).sort(), [
		'churn_floor_pct',
		'cut_penalty',
		'min_rise',
		'min_rises',
		'min_z',
		'sigma_pct',
		'slope_penalty',
		'step_ratio'
	]);
});

test('trend: segmentation cuts a step between two flat levels and fits a ramp as a line', () => {
	const o = { sigma: 0.5, cut_penalty: 6, slope_penalty: 3 };
	const step = [0, 0, 0, 0, 0, 5, 5, 5, 5, 5];
	assert.deepEqual(
		segment(step, o).map((p) => [p.kind, p.start, p.end]),
		[
			['flat', 0, 5],
			['flat', 5, 10]
		]
	);
	const ramp = [0, 0, 0, 0, 1, 2, 3, 4, 5, 5, 5, 5];
	const pieces = segment(ramp, o);
	assert.ok(pieces.some((p) => p.kind === 'line' && p.slope > 0.9));
});

test('trend: three hundred commits take well under a second', () => {
	const m = churn(300, 0.003, 3);
	for (let i = 100; i < 140; i++) m[i] += 0.004;
	const t0 = performance.now();
	const r = detect_trend(planted_series(m));
	const ms = performance.now() - t0;
	assert.ok(ms < 1000, `${ms} ms`);
	// 0.4% a commit on churn of 0.3%: found, inside the planted span (its start is fuzzy there)
	assert.ok(r.creeps.some((c) => c.start_index < 140 && c.end_index >= 100 && c.ratio > 0.1));
});
