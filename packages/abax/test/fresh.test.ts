import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run_benches } from '../src/runner.ts';
import { temp_dir, write_files } from './helpers.ts';

const BENCH_API = fileURLToPath(new URL('../src/bench.ts', import.meta.url));

const root = temp_dir('abax-fresh-');
write_files(root, {
	'state.ts': `let calls = 0;
const memo = new Map<number, number>();

export function grows(): number {
	calls++;
	let s = 0;
	for (let i = 0; i < calls * 10; i++) s += i;
	return s;
}

export function memoized(k: number): number {
	const hit = memo.get(k);
	if (hit !== undefined) return hit;
	let v = 0;
	for (let i = 0; i < 200; i++) v += i * k;
	memo.set(k, v);
	return v;
}
`,
	'state.bench.ts': `import { bench } from ${JSON.stringify(BENCH_API)};
import { grows, memoized } from './state.ts';
bench('grows', () => grows());
bench('memoized', () => memoized(7));
`
});
const files = [join(root, 'state.bench.ts')];

test('fresh module state: a module counter no longer makes identical runs differ', async () => {
	const fresh = await run_benches({ files, root, sha: null });
	const shared = await run_benches({ files, root, sha: null, fresh: false });
	const f = fresh.cases.find((c) => c.name === 'grows')!;
	const s = shared.cases.find((c) => c.name === 'grows')!;
	assert.equal(f.stable, true);
	assert.equal(s.stable, false, 'one shared copy: every run loops longer than the last');
	// every fresh run is a first call: 10 iterations (the loop test runs 11 times)
	const loop = f.functions.find((x) => x.path === 'grows')!;
	assert.deepEqual(
		loop.blocks.map((b) => b.count),
		[1, 11, 10, 10, 1]
	);
	// and it is the same on every run of the whole suite
	const again = await run_benches({ files, root, sha: null });
	assert.equal(again.cases[0].totals.steps, f.totals.steps);
});

test('fresh module state: a memo starts empty, so the measured run takes the cold path', async () => {
	const fresh = (await run_benches({ files, root, sha: null, filter: 'memoized' })).cases[0];
	const shared = (await run_benches({ files, root, sha: null, filter: 'memoized', fresh: false }))
		.cases[0];
	assert.equal(fresh.stable, true);
	assert.equal(shared.stable, true);
	assert.ok(
		fresh.totals.steps > 10 * shared.totals.steps,
		`cold ${fresh.totals.steps} vs warm ${shared.totals.steps}`
	);
	// the copies count into the same counters: one function entry, not one per copy
	assert.equal(fresh.functions.filter((x) => x.path === 'memoized').length, 1);
});
