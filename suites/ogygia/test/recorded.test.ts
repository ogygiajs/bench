import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dist_twin, summarize } from '../src/recorded.ts';

test('a source file and its twin in the unbundled build', () => {
	assert.equal(
		dist_twin('packages/core/src/compiler/region/transform.ts'),
		'packages/core/dist/compiler/region/transform.js'
	);
	assert.equal(
		dist_twin('packages/core/src/page-store.svelte.ts'),
		'packages/core/dist/page-store.svelte.js'
	);
	assert.equal(dist_twin('packages/core/src/x.mts'), 'packages/core/dist/x.mjs');
	assert.equal(dist_twin('packages/core/test/x.ts'), null, 'only package sources have one');
});

test('result.json keeps the findings of a recorded growth run, not every curve', () => {
	const fn = (id: string, grows: boolean, confident = true) => ({ id, grows, confident }) as never;
	const s = summarize(
		{
			report: {
				schema: 'heisenbench-recorded-growth/1',
				functions: [fn('a', true), fn('b', false), fn('c', false, false)],
				skipped: {},
				steps_spent: 0
			},
			markdown: 'md',
			error: null,
			seconds: { build: 1, record: 2, grow: 3 }
		},
		'all'
	);
	assert.equal(s.grown, 3);
	assert.equal(s.decided, 2);
	assert.deepEqual(
		s.findings.map((g) => (g as { id: string }).id),
		['a']
	);
});
