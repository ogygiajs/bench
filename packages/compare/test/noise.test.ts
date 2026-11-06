import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, median, spreadOf } from '../src/noise.ts';
import { markOf, range, signed } from '../src/format.ts';

const lower = { better: 'lower', floor: { abs: 5 } } as const;
const ms = (n: number) => `${Math.round(n)} ms`;

test('median and spread', () => {
	assert.equal(median([3, 1, 2]), 2);
	assert.equal(median([4, 1, 3, 2]), 2.5);
	assert.equal(spreadOf([5, 9, 7]), 4);
});

test('repeats apart, beyond the spread and the floor: regressed', () => {
	const j = judge(lower, 0, 0, [120, 121, 122], [100, 101, 102]);
	assert.equal(j.regressed, true);
	assert.equal(j.improved, false);
	assert.equal(j.pr, 121);
	assert.equal(j.base, 101);
	assert.deepEqual(j.spread, [2, 2]);
	assert.equal(markOf(j), '⚠️');
});

test('higher is better: the same numbers are an improvement', () => {
	const j = judge({ better: 'higher', floor: { abs: 5 } }, 0, 0, [120, 121, 122], [100, 101, 102]);
	assert.equal(j.improved, true);
	assert.equal(markOf(j), 'better');
});

test('overlapping repeats are noise, however far the medians are', () => {
	const j = judge(lower, 0, 0, [100, 150, 151], [99, 101, 102]);
	assert.equal(j.regressed, false);
	assert.equal(markOf(j), '≈');
});

test('apart but within the wider spread is noise', () => {
	const j = judge(lower, 0, 0, [110, 111, 140], [100, 101, 109]);
	assert.equal(j.regressed, false);
});

test('apart but under the floor is noise', () => {
	const j = judge({ better: 'lower', floor: { abs: 50 } }, 0, 0, [120, 121, 122], [100, 101, 102]);
	assert.equal(j.regressed, false);
});

test('the floor has to exceed both its parts', () => {
	// 2% of 1000 = 20 > abs 5, so a change of 15 is under the floor.
	const rule = { better: 'lower', floor: { pct: 2, abs: 5 }, once: true } as const;
	assert.equal(judge(rule, 1015, 1000).regressed, false);
	assert.equal(judge(rule, 1021, 1000).regressed, true);
});

test('measured once: exact, judged by its floor', () => {
	const rule = { better: 'lower', floor: { abs: 0 }, once: true } as const;
	const same = judge(rule, 10, 10);
	assert.equal(same.once, true);
	assert.equal(markOf(same), '=');
	assert.equal(judge(rule, 11, 10).regressed, true);
});

test('a timing with too few repeats is not judged', () => {
	const j = judge(lower, 200, 100, [200, 201], [100, 101]);
	assert.equal(j.unjudged, true);
	assert.equal(j.regressed, false);
	assert.equal(markOf(j), '·');
});

test('signed and range', () => {
	assert.equal(signed(12, 100, ms), '+12 ms (+12.0%)');
	assert.equal(signed(-3, 0, ms), '−3 ms');
	assert.equal(signed(0, 10, ms), '±0 ms (±0.0%)');
	assert.equal(
		range([69, 73, 70], (n) => String(n)),
		'69–73'
	);
	assert.equal(
		range([15.1, 16], (n) => `${n.toFixed(1)} ms`),
		'15.1–16.0 ms'
	);
	assert.equal(range([4, 4], ms), '4 ms');
});
