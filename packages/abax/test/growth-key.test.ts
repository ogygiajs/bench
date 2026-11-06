import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { diff_growth } from '../src/growth/index.ts';
import type { GrowthReport } from '../src/growth/index.ts';
import { diff_search } from '../src/search/index.ts';
import type { SearchReport } from '../src/search/index.ts';
import type { Report } from '../src/report.ts';
import { temp_dir } from './helpers.ts';

/*
 * Growth and slow-input search answer keys (spec 9 + 12), measured by the CLI like CI does.
 *
 * Growth: a planted linear -> quadratic change is a class change; a constant-factor change (three
 * passes instead of one) is not. One case scales itself (a size given as a number).
 * Search: functions that are quadratic on some inputs (insertion sort, naive substring count) get
 * their bad input found; a linear function's worst input costs what its typical one does.
 */

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const BENCH_API = fileURLToPath(new URL('../src/bench.ts', import.meta.url));
const GROWTH = fileURLToPath(new URL('./growth-key/', import.meta.url));
const SEARCH = fileURLToPath(new URL('./search-key/', import.meta.url));

function side(dir: string, lib: string, bench: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'lib.ts'), readFileSync(lib, 'utf8'));
	writeFileSync(
		join(dir, 'lib.bench.ts'),
		readFileSync(bench, 'utf8').replace('ABAX_BENCH', BENCH_API)
	);
}

async function cli(dir: string, args: string[]): Promise<Report> {
	await run(process.execPath, ['--no-warnings', CLI, ...args, 'lib.bench.ts', '--root', dir], {
		cwd: dir
	});
	return JSON.parse(readFileSync(join(dir, 'abax-report.json'), 'utf8')) as Report;
}

const tmp = temp_dir('abax-growth-key-');
let base_growth: Promise<GrowthReport> | null = null;

function growth_base(): Promise<GrowthReport> {
	if (!base_growth) {
		const dir = join(tmp, 'growth-base');
		side(dir, join(GROWTH, 'base', 'lib.ts.txt'), join(GROWTH, 'base', 'lib.bench.ts.txt'));
		base_growth = cli(dir, ['growth']).then((r) => r.growth!);
	}
	return base_growth;
}

test('growth: the base is linear, counted exactly at 1x / 10x / 100x', async () => {
	const g = await growth_base();
	assert.deepEqual(g.sizes, [1, 10, 100]);
	const rank = g.cases.find((c) => c.name === 'rank')!;
	assert.equal(rank.error, null);
	assert.equal(rank.stable, true);
	assert.equal(rank.scaler, 'generic');
	assert.equal(rank.class, 'linear');
	assert.ok(rank.input_sizes[2] > 90 * rank.input_sizes[0], 'the input grew about 100x');
	const sum = g.cases.find((c) => c.name === 'sum to n')!;
	assert.equal(sum.scaler, 'case');
	assert.equal(sum.class, 'linear');
	assert.ok(sum.steps[2] > 90 * sum.steps[0] * 0.9);
});

for (const name of readdirSync(GROWTH).filter((d) => d !== 'base')) {
	test(`growth answer key: ${name}`, async () => {
		const expect = JSON.parse(readFileSync(join(GROWTH, name, 'expect.json'), 'utf8')) as {
			what: string;
			flags: Array<{ case: string; base: string; pr: string }>;
		};
		const dir = join(tmp, `growth-${name}`);
		side(dir, join(GROWTH, name, 'lib.ts.txt'), join(GROWTH, 'base', 'lib.bench.ts.txt'));
		const [b, p] = await Promise.all([growth_base(), cli(dir, ['growth']).then((r) => r.growth!)]);
		const d = diff_growth(b, p);
		const shown = JSON.stringify(d.findings);
		assert.deepEqual(
			d.findings.map((f) => ({ case: f.case, base: f.base, pr: f.pr })),
			expect.flags,
			`${expect.what}: ${shown}`
		);
		if (expect.flags.length === 0) {
			// steps did change; only the class did not
			assert.ok(
				d.same.some((s) => s.case === 'rank' && s.ratio > 2),
				JSON.stringify(d.same)
			);
		}
		// the PR comment part, through the CLI
		const base_file = join(tmp, 'growth-base', 'abax-report.json');
		const { stdout } = await run(process.execPath, [
			'--no-warnings',
			CLI,
			'diff',
			base_file,
			join(dir, 'abax-report.json')
		]);
		assert.ok(stdout.includes('#### Growth'), stdout);
		if (expect.flags.length > 0) assert.ok(stdout.includes('linear -> quadratic'), stdout);
		else assert.ok(stdout.includes('No case changed how its steps grow'), stdout);
	});
}

test('search answer key: slow inputs are found, linear code has none', async () => {
	const base_dir = join(tmp, 'search-base');
	const pr_dir = join(tmp, 'search-pr');
	const bench = join(SEARCH, 'base', 'lib.bench.ts.txt');
	side(base_dir, join(SEARCH, 'base', 'lib.ts.txt'), bench);
	side(pr_dir, join(SEARCH, 'pr', 'lib.ts.txt'), bench);
	const [b, p] = await Promise.all([
		cli(base_dir, ['search']).then((r) => r.search!),
		cli(pr_dir, ['search']).then((r) => r.search!)
	]);
	const of = (r: SearchReport, name: string) => r.cases.find((c) => c.name === name)!;
	for (const c of [...b.cases, ...p.cases]) {
		assert.equal(c.error, null);
		assert.equal(c.stopped, 'evals', 'bounded by evaluations, not the clock');
	}
	// insertion sort: linear on its sorted input, quadratic on the input the search finds
	assert.ok(of(p, 'order').ratio >= 5, JSON.stringify(of(p, 'order')));
	// naive substring count: slow on runs of one character
	assert.ok(of(p, 'count').ratio >= 3, JSON.stringify(of(p, 'count')));
	assert.ok(of(p, 'count').input.includes('aaaa'), of(p, 'count').input);
	// linear: the worst input costs what the typical one does
	assert.ok(of(p, 'total').ratio <= 1.05, JSON.stringify(of(p, 'total')));
	// the base has no slow input: split on more separators makes more parts (a few % more), far
	// below a slow input's 3x
	for (const c of b.cases) assert.ok(c.ratio <= 1.25, `base ${c.name}: ${c.ratio}`);

	const found = diff_search(b, p).map((f) => f.case);
	assert.deepEqual(found.sort(), ['count', 'order']);

	// the same search twice gives the same answer (seeded, bounded by evaluations)
	const again = (await cli(pr_dir, ['search'])).search!;
	assert.deepEqual(
		again.cases.map((c) => [c.name, c.worst, c.input]),
		p.cases.map((c) => [c.name, c.worst, c.input])
	);
});
