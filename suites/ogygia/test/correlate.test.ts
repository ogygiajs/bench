import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ranks, spearman, summarize_rows } from '../src/correlate.ts';
import type { Row } from '../src/correlate.ts';

test('ranks: ties share the mean of their positions', () => {
	assert.deepEqual(ranks([10, 20, 20, 5]), [2, 3.5, 3.5, 1]);
});

test('spearman: 1 for any increasing relation, -1 for decreasing, ties handled', () => {
	assert.equal(spearman([1, 2, 3, 4], [1, 8, 27, 64]), 1);
	assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
	assert.ok(Math.abs(spearman([0, 0, 1, 2], [0.1, -0.2, 3, 9]) - 0.949) < 0.01);
	assert.ok(Number.isNaN(spearman([1, 1, 1], [1, 2, 3])));
});

test('summary: the confusion matrix uses the 3% floor for steps, the noise rule for time', () => {
	const row = (steps_pct: number, p50_pct: number, time: Row['time']): Row => ({
		commit: 'c',
		subject: 's',
		case: 'x',
		file: 'f',
		base_steps: 100,
		pr_steps: 100 + steps_pct,
		steps_pct,
		base_p50: 100,
		pr_p50: 100 + p50_pct,
		p50_pct,
		base_mean: 100,
		pr_mean: 100 + p50_pct,
		mean_pct: p50_pct,
		time
	});
	const s = summarize_rows([
		row(10, 9, 'slower'),
		row(-20, -15, 'faster'),
		row(1, 0.5, 'same'),
		row(0, 0, 'same'),
		row(5, 0, 'same'),
		row(0, 6, 'slower')
	]);
	assert.deepEqual(s.confusion, { tp: 2, fp: 1, fn: 1, tn: 2 });
	assert.equal(s.direction_agree, 2);
	assert.equal(s.changed_rows, 4);
});
