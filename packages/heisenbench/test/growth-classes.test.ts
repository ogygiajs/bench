import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { GrowthCase } from '../src/growth/index.ts';
import type { Report } from '../src/report.ts';
import { temp_dir, write_files } from './helpers.ts';

/*
 * Every shape past quadratic, planted and grown by the CLI the way CI grows a bench file: a cubic,
 * a quartic, an exponential (every subset of the input, which would not finish at 16x), and a
 * case whose steps fall as the input grows (a function that refuses a repeated input at once:
 * the generic scaler's copies are not valid input for it). The exponential one goes past the step
 * cap, is said to, and is grown on a doubling ladder of smaller sizes instead.
 */

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const BENCH_API = fileURLToPath(new URL('../src/bench.ts', import.meta.url));

const LIB = `
export function triples(xs) {
	let n = 0;
	for (const a of xs) for (const b of xs) for (const c of xs) if (a + b > c) n++;
	return n;
}
export function quads(xs) {
	let n = 0;
	for (const a of xs) for (const b of xs) for (const c of xs) for (const d of xs) if (a + b > c + d) n++;
	return n;
}
export function subset_sums(xs) {
	let count = 0;
	const go = (i, s) => {
		if (i === xs.length) {
			if (s > 0) count++;
			return;
		}
		go(i + 1, s);
		go(i + 1, s + xs[i]);
	};
	go(0, 0);
	return count;
}
// a repeated element is refused at once; a unique list gets every pair compared
export function pairs_if_unique(xs) {
	for (let i = 1; i < xs.length; i++) if (xs[i] === xs[0]) return -1;
	let n = 0;
	for (const a of xs) for (const b of xs) if (a < b) n++;
	return n;
}
`;

const BENCH = `
import { bench } from 'HEISENBENCH_BENCH';
import { triples, quads, subset_sums, pairs_if_unique } from './lib.js';
bench('cubic', ({ xs }) => triples(xs), { setup: () => ({ xs: [3, 1, 2] }) });
bench('quartic', ({ xs }) => quads(xs), { setup: () => ({ xs: [2, 1] }) });
bench('exponential', ({ xs }) => subset_sums(xs), { setup: () => ({ xs: [1, 2] }) });
bench('shrinks', ({ xs }) => pairs_if_unique(xs), { setup: () => ({ xs: [0, 1, 2, 3, 4, 5, 6, 7] }) });
`;

test('growth names every shape: cubic, quartic, exponential past the cap, and steps that fall', async () => {
	const dir = temp_dir('heisenbench-growth-classes-');
	write_files(dir, {
		'lib.js': LIB,
		'lib.bench.ts': BENCH.replace('HEISENBENCH_BENCH', BENCH_API)
	});
	const { stdout } = await run(
		process.execPath,
		[
			'--no-warnings',
			CLI,
			'growth',
			'lib.bench.ts',
			'--root',
			dir,
			'--sizes',
			'1,4,16',
			'--cap',
			'2e7'
		],
		{ cwd: dir }
	);
	const report = JSON.parse(readFileSync(join(dir, 'heisenbench-report.json'), 'utf8')) as Report;
	const by = new Map<string, GrowthCase>(report.growth!.cases.map((c) => [c.name, c]));

	assert.equal(by.get('cubic')!.class, 'cubic');
	assert.equal(by.get('cubic')!.capped_at, undefined);
	assert.equal(by.get('quartic')!.class, 'quartic');

	const exp = by.get('exponential')!;
	assert.equal(exp.error, null);
	assert.equal(exp.class, 'exponential');
	assert.equal(exp.capped_at, 16, 'every subset of 32 numbers is past the cap');
	assert.deepEqual(exp.sizes, [1, 2, 4, 8], 'grown on the doubling ladder below the capped size');
	assert.match(stdout, /exponential \(.*exceeded the cap at 16x, grown on 1x \/ 2x \/ 4x \/ 8x\)/);

	const shrinks = by.get('shrinks')!;
	assert.equal(shrinks.class, 'shrinks');
	assert.match(stdout, /shrinks: the scaled input may be invalid/);

	// the odds keep every class, with at least 95% on it; steps that fall have none
	for (const name of ['cubic', 'quartic', 'exponential']) {
		const g = by.get(name)!;
		assert.equal(g.odds?.odds[0].shape, g.class, `${name}: ${JSON.stringify(g.odds)}`);
		assert.ok(g.odds!.odds[0].p >= 0.95, `${name}: ${JSON.stringify(g.odds)}`);
	}
	assert.equal(shrinks.odds, null);
});
