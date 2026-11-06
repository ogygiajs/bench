import { test } from 'node:test';
import assert from 'node:assert/strict';
import { select_all, select_changed } from '../src/select.ts';

const graphs = new Map([
	[
		'packages/router/bench/match.bench.ts',
		['packages/router/bench/match.bench.ts', 'packages/router/src/match.ts']
	],
	[
		'packages/core/bench/serialize.bench.ts',
		[
			'packages/core/bench/serialize.bench.ts',
			'packages/core/src/escape.ts',
			'packages/core/src/seed-refs.ts'
		]
	]
]);

test('a PR runs the bench files whose graph reaches a changed file, and says which file', () => {
	const s = select_changed(graphs, ['README.md', 'packages/core/src/escape.ts']);
	assert.equal(s.mode, 'changed');
	assert.deepEqual(s.selected, ['packages/core/bench/serialize.bench.ts']);
	assert.deepEqual(s.reach, {
		'packages/core/bench/serialize.bench.ts': ['packages/core/src/escape.ts']
	});
	assert.deepEqual(s.all, [
		'packages/core/bench/serialize.bench.ts',
		'packages/router/bench/match.bench.ts'
	]);
});

test('a changed bench file runs itself', () => {
	const s = select_changed(graphs, ['packages/router/bench/match.bench.ts']);
	assert.deepEqual(s.selected, ['packages/router/bench/match.bench.ts']);
});

test('nothing reached, nothing runs', () => {
	const s = select_changed(graphs, ['apps/docs/src/content/docs/a/+doc.svx']);
	assert.deepEqual(s.selected, []);
	assert.equal(s.reason, null);
});

test('the lockfile or the bench harness changing runs every bench file', () => {
	for (const changed of ['pnpm-lock.yaml', 'internal/abax/src/preload.ts']) {
		const s = select_changed(graphs, [changed]);
		assert.equal(s.mode, 'all');
		assert.equal(s.selected.length, 2);
		assert.equal(s.reason, `${changed} changed`);
		assert.deepEqual(s.changed, [changed]);
	}
});

test('a full run selects everything', () => {
	const s = select_all(['b.bench.ts', 'a.bench.ts'], 'a full run');
	assert.deepEqual(s.selected, ['b.bench.ts', 'a.bench.ts']);
	assert.equal(s.mode, 'all');
});
