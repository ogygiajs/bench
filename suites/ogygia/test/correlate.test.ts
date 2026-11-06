import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	last_commits,
	parse_max,
	ranks,
	spearman,
	summarize_rows,
	trees_to_drop
} from '../src/correlate.ts';

test('--max: the newest N commits; 0 is none, not all', () => {
	const commits = ['a', 'b', 'c', 'd'];
	assert.deepEqual(last_commits(commits, 2), ['c', 'd']);
	assert.deepEqual(last_commits(commits, 0), []);
	assert.deepEqual(last_commits(commits, 9), commits);
	assert.equal(parse_max(undefined), 40);
	assert.equal(parse_max('0'), 0);
	assert.equal(parse_max('12'), 12);
	for (const bad of ['-1', '1.5', 'x', '', true]) assert.throws(() => parse_max(bad), /--max/);
});

test('a measured pair leaves behind only the trees the next pair uses', () => {
	// consecutive first-parent commits: the commit is the next pair's parent
	assert.deepEqual(trees_to_drop({ parent: 'p', commit: 'c1' }, { parent: 'c1', commit: 'c2' }), [
		'p'
	]);
	// a gap (commits that touched no bench package in between): both go
	assert.deepEqual(trees_to_drop({ parent: 'p', commit: 'c1' }, { parent: 'x', commit: 'c2' }), [
		'p',
		'c1'
	]);
	// the last pair: both go
	assert.deepEqual(trees_to_drop({ parent: 'p', commit: 'c1' }, undefined), ['p', 'c1']);
});
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
