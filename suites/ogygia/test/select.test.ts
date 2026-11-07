import { test } from 'node:test';
import assert from 'node:assert/strict';
import { is_shared, manifest_scope, select_all, select_changed } from '../src/select.ts';

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
	for (const changed of ['pnpm-lock.yaml', 'internal/heisenbench/src/preload.ts']) {
		const s = select_changed(graphs, [changed]);
		assert.equal(s.mode, 'all');
		assert.equal(s.selected.length, 2);
		assert.equal(s.reason, `${changed} changed`);
		assert.deepEqual(s.changed, [changed]);
	}
});

test('the root manifests run every bench file', () => {
	for (const changed of ['package.json', 'tsconfig.json', 'tsconfig.base.json', '.npmrc']) {
		const s = select_changed(graphs, [changed]);
		assert.equal(s.mode, 'all', changed);
		assert.equal(s.reason, `${changed} changed`);
	}
});

test('a package manifest reaches the bench files that load that package', () => {
	// core's imports map re-pointed: the core bench runs, the router one does not
	const s = select_changed(graphs, ['packages/core/package.json']);
	assert.equal(s.mode, 'changed');
	assert.deepEqual(s.selected, ['packages/core/bench/serialize.bench.ts']);
	assert.deepEqual(s.reach, {
		'packages/core/bench/serialize.bench.ts': ['packages/core/package.json']
	});
	// a bench file of another package that imports core runs too
	const cross = new Map([
		...graphs,
		[
			'packages/ogygia/bench/page.bench.ts',
			['packages/ogygia/bench/page.bench.ts', 'packages/core/src/escape.ts']
		]
	]);
	assert.deepEqual(select_changed(cross, ['packages/core/package.json']).selected, [
		'packages/core/bench/serialize.bench.ts',
		'packages/ogygia/bench/page.bench.ts'
	]);
	assert.deepEqual(select_changed(graphs, ['packages/router/tsconfig.json']).selected, [
		'packages/router/bench/match.bench.ts'
	]);
	// a manifest no bench file reaches runs nothing
	assert.deepEqual(select_changed(graphs, ['apps/docs/package.json']).selected, []);
});

test('a nested manifest reaches only what sits under it', () => {
	const s = select_changed(graphs, ['packages/core/src/sub/package.json']);
	assert.deepEqual(s.selected, []);
	assert.equal(manifest_scope('packages/core/src/sub/package.json'), 'packages/core/src/sub/');
	assert.equal(manifest_scope('packages/core/src/x.ts'), null);
	assert.equal(is_shared('packages/core/package.json'), false);
	assert.equal(is_shared('package.json'), true);
});

test('a full run selects everything', () => {
	const s = select_all(['b.bench.ts', 'a.bench.ts'], 'a full run');
	assert.deepEqual(s.selected, ['b.bench.ts', 'a.bench.ts']);
	assert.equal(s.mode, 'all');
});
