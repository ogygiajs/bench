import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CaseReport, Report } from '../src/report.ts';
import { BENCH_API, CLI } from '../src/verify/fixture.ts';
import { temp_dir, write_files } from './helpers.ts';

const run = promisify(execFile);

async function heisenbench(root: string, args: string[]): Promise<Report> {
	const out = join(root, 'heisenbench-report.json');
	await run(process.execPath, ['--no-warnings', CLI, ...args, '--root', root, '--out', out], {
		cwd: root,
		maxBuffer: 1 << 26
	});
	return JSON.parse(readFileSync(out, 'utf8')) as Report;
}

/** Work that follows its input: a moving input moves the count. */
const LIB = `export function expires(at: number, seed: number, stamp: string): number {
	let n = 0;
	for (let i = 0; i < at % 997; i++) n += i;
	for (let i = 0; i < seed % 101; i++) n -= i;
	return n + stamp.length + stamp.split('').filter((c) => c === '1').length;
}
`;

/*
 * Every way a case's own code reads the clock or randomness outside the measuring window: at the
 * bench file's top (each run imports a fresh copy), in setup, in scale (growth) and in teardown.
 */
const BENCH = `import { bench } from '${BENCH_API}';
import { expires } from './lib.ts';

const LOADED = Date.now();
const LOADED_RANDOM = Math.random();
let torn = 0;

const input = (k: number) => ({
	at: Math.floor(Date.now() / 1000) + 1800 * k + LOADED,
	seed: Math.floor(performance.now() * 1000) + Math.floor(Math.random() * 1e6) + Math.floor(LOADED_RANDOM * 1e6),
	stamp: new Date().toISOString() + crypto.randomUUID() + String(process.hrtime.bigint())
});

bench('a case that signs with the time of its setup', ({ at, seed, stamp }) => expires(at, seed, stamp), {
	setup: () => input(1),
	scale: (_ctx, k) => input(k),
	teardown: () => {
		torn = Date.now();
	}
});

bench('a case whose async setup reads the clock after a wait', ({ at, seed, stamp }) => expires(at, seed, stamp), {
	setup: async () => {
		await new Promise((r) => setTimeout(r, 3));
		return input(2);
	}
});
`;

function project(): string {
	const root = temp_dir('hb-world-');
	write_files(root, {
		'package.json': JSON.stringify({ name: 'world', private: true, type: 'module' }),
		'lib.ts': LIB,
		'world.bench.ts': BENCH
	});
	return root;
}

const counts = (cases: readonly CaseReport[]) =>
	cases.map((c) => ({ name: c.name, error: c.error, stable: c.stable, steps: c.totals.steps }));

test('a case that reads the clock in setup counts the same in every run and every process', async () => {
	const root = project();
	const a = await heisenbench(root, ['run', 'world.bench.ts']);
	await new Promise((r) => setTimeout(r, 25));
	const b = await heisenbench(root, ['run', 'world.bench.ts']);
	for (const c of a.cases) {
		assert.equal(c.error, null, `${c.name}: ${c.error}`);
		assert.equal(c.stable, true, `${c.name}: its two measured runs differ`);
	}
	assert.equal(a.cases.length, 2);
	assert.deepEqual(counts(b.cases), counts(a.cases));
});

test('setup, scale and the bench file read the clock from 2024-01-01, the window’s epoch', async () => {
	const root = project();
	write_files(root, {
		'epoch.bench.ts': `import { bench } from '${BENCH_API}';
const LOADED = Date.now();
bench('the epoch', ({ at }) => { if (at !== 1_704_067_200_000 || LOADED !== 1_704_067_200_000) throw new Error('setup saw ' + at + ', the file ' + LOADED); return at; }, {
	setup: () => ({ at: Date.now() })
});
`
	});
	const r = await heisenbench(root, ['run', 'epoch.bench.ts']);
	assert.equal(r.cases[0].error, null);
});

test('growth scales a clock-reading input to the same count every time', async () => {
	const root = project();
	const grow = async () =>
		(await heisenbench(root, ['growth', 'world.bench.ts', '--filter', 'signs'])).growth;
	const a = await grow();
	const b = await grow();
	assert.ok(a, 'growth ran');
	assert.deepEqual(b, a);
});

test('the real clock and Math.random are back after the case', async () => {
	const { Determinism } = await import('../src/runtime/determinism.ts');
	const { case_world } = await import('../src/runtime/determinism.ts');
	const RealDate = Date;
	const seen = await case_world(async () => {
		await new Promise((r) => setTimeout(r, 2));
		return [Date.now(), Math.random()];
	});
	assert.equal(seen[0], 1_704_067_200_000);
	assert.equal(Date, RealDate);
	assert.ok(Date.now() > 1_750_000_000_000);
	const sync = case_world(() => Date.now());
	assert.equal(sync, 1_704_067_200_000, 'a sync function stays sync');
	assert.ok(new Determinism() instanceof Determinism);
});
