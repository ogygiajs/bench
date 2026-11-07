import { test } from 'node:test';
import assert from 'node:assert/strict';
import { find_token } from '../src/transform/instrument.ts';
import { counts_by_line, fn_of, load_module, measure } from './helpers.ts';
import { context_path } from '../src/identity.ts';

test('find_token skips tokens inside comments', () => {
	const code = 'a /* => */ // =>\n =>';
	assert.equal(find_token(code, '=>', 0), code.lastIndexOf('=>'));
	assert.equal(find_token(code, '{', 0), -1);
});

test('an arrow body after a comment holding `=>` (as Svelte ships it) is instrumented', async () => {
	const m = await load_module<{ run: (n: number) => number[] }>(
		[
			'export function run(n) {',
			'\tconst fns = [];',
			'\tfns.push(() => /** @type {(x: number) => number} */ (double)(n));',
			'\tfns.push((/* (a) => b */ k = 1) => k + n);',
			'\treturn fns.map((f) => f());',
			'}',
			'function double(x) {',
			'\treturn x * 2;',
			'}'
		].join('\n'),
		'.js'
	);
	let out: number[] = [];
	const report = await measure(() => {
		out = m.run(5);
	});
	assert.deepEqual(out, [10, 6]);
	assert.equal(fn_of(report, 'double').calls, 1);
	const pushed = report.functions
		.filter((f) => context_path(f.path) === 'run > push:0')
		.sort((a, b) => a.line - b.line);
	assert.equal(pushed.length, 2);
	assert.equal(counts_by_line(pushed[0])[3], 1);
	assert.equal(pushed[1].calls, 1);
});
