import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PRICES_ENV } from '../src/prices.ts';
import type { Report } from '../src/report.ts';
import { temp_dir } from './helpers.ts';

/*
 * The price audit's answer key, run by the CLI like CI runs it: a page built with `+=` in a loop,
 * and a control that sums the same rows. With today's prices the audit is quiet. With the join
 * pricing from before cons strings (every join charged per character of its whole result, a
 * price file with `cons_min: null`) the steps of the page grow quadratic while its time grows
 * linear, and the audit must name `dyn.string_char` on the page and nothing on the control.
 */

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const BENCH_API = fileURLToPath(new URL('../src/bench.ts', import.meta.url));
const KEY = fileURLToPath(new URL('./audit-key/', import.meta.url));
const PRICES = fileURLToPath(new URL('../prices.json', import.meta.url));

const tmp = temp_dir('heisenbench-audit-key-');

function project(name: string): string {
	const dir = join(tmp, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'lib.ts'), readFileSync(join(KEY, 'lib.ts.txt'), 'utf8'));
	writeFileSync(
		join(dir, 'lib.bench.ts'),
		readFileSync(join(KEY, 'lib.bench.ts.txt'), 'utf8').replace('HEISENBENCH_BENCH', BENCH_API)
	);
	return dir;
}

async function audit(dir: string, prices?: string): Promise<Report> {
	const env = { ...process.env };
	if (prices) env[PRICES_ENV] = prices;
	else delete env[PRICES_ENV];
	await run(
		process.execPath,
		[
			'--no-warnings',
			CLI,
			'audit',
			'lib.bench.ts',
			'--root',
			dir,
			'--repeats',
			'3',
			'--time-ms',
			'100',
			'--md',
			'audit.md'
		],
		{ cwd: dir, env }
	);
	return JSON.parse(readFileSync(join(dir, 'heisenbench-report.json'), 'utf8')) as Report;
}

test("audit key: today's join prices are quiet", async () => {
	const r = await audit(project('today'));
	const a = r.audit!;
	assert.equal(a.cases.length, 2);
	assert.deepEqual(
		a.findings.map((f) => f.text),
		[]
	);
	const page = a.cases.find((c) => c.name.startsWith('render_page'))!;
	assert.equal(page.steps_class, 'linear');
	assert.equal(page.time_class, 'linear');
});

test('audit key: joins charged for their whole result are found on the page, not the control', async () => {
	const prices = JSON.parse(readFileSync(PRICES, 'utf8')) as Record<string, unknown>;
	const file = join(tmp, 'old-join-prices.json');
	writeFileSync(file, JSON.stringify({ ...prices, cons_min: null }));
	const dir = project('old-joins');
	const r = await audit(dir, file);
	const a = r.audit!;
	const page = a.cases.find((c) => c.name.startsWith('render_page'))!;
	const control = a.cases.find((c) => c.name.startsWith('total_length'))!;
	assert.equal(page.steps_class, 'quadratic');
	assert.equal(page.time_class, 'linear');
	assert.equal(page.suspect?.kind, 'dyn.string_char');
	assert.equal(control.suspect, null);
	assert.equal(a.findings.length, 1);
	const f = a.findings[0];
	assert.equal(f.kind, 'dyn.string_char');
	assert.equal(f.direction, 'over');
	assert.match(f.text, /^price suspect: dyn\.string_char: steps grow quadratic in render_page/);
	assert.match(readFileSync(join(dir, 'audit.md'), 'utf8'), /price suspect: `dyn\.string_char`/);
});
