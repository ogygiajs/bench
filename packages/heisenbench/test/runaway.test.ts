import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Report } from '../src/report.ts';
import { temp_dir, write_files } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const href = (rel: string) =>
	JSON.stringify(pathToFileURL(fileURLToPath(new URL(rel, import.meta.url))).href);
const BENCH_API = href('../src/bench.ts');
const RUNNER = href('../src/runner.ts');

function node(args: string[], cwd: string, timeout = 180_000) {
	const r = spawnSync(process.execPath, args, {
		cwd,
		encoding: 'utf8',
		timeout,
		killSignal: 'SIGKILL'
	});
	return { code: r.status, signal: r.signal, out: r.stdout, err: r.stderr };
}

const LIB = `export function total(xs: number[]): number {
	let s = 0;
	for (const x of xs) s += x;
	return s;
}
function tick(n: number): number {
	return n & 1;
}
export function spin_forever(): number {
	let s = 0;
	for (let i = 0; ; i++) s += tick(i);
	return s;
}
export function spin_after_records(n: number): number {
	let s = 0;
	for (let i = 0; i < n; i++) s += tick(i);
	return s;
}
`;

function project(cases: string): string {
	const dir = temp_dir('heisenbench-runaway-');
	write_files(dir, {
		'package.json': '{ "type": "module" }',
		'lib.ts': LIB,
		'spin.bench.ts': `import { bench } from ${BENCH_API};
import { total, spin_forever, spin_after_records } from './lib.ts';
void spin_forever; void spin_after_records;
bench('before', () => total([1, 2, 3]));
${cases}
bench('after', () => total([4, 5, 6, 7]));
`
	});
	return dir;
}

function cases_of(dir: string): Map<string, Report['cases'][number]> {
	const r = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')) as Report;
	return new Map(r.cases.map((c) => [c.name, c]));
}

test('run: a case that loops forever is stopped at the step ceiling, named, and the other cases still count', () => {
	const dir = project(`bench('spins', () => spin_forever());`);
	const r = node([CLI, 'run', 'spin.bench.ts', '--out', 'r.json'], dir);
	assert.notEqual(r.signal, 'SIGKILL', `the run hung on the runaway case\n${r.out}${r.err}`);
	assert.equal(r.code, 1, `a runaway case fails the run\n${r.out}${r.err}`);
	const line = r.out.split('\n').find((l) => l.startsWith('FAILED   spins'));
	assert.ok(line, `a FAILED line names the case\n${r.out}`);
	assert.match(line, /HB_RUNAWAY/);
	assert.match(line, /spin\.bench\.ts/);
	assert.match(line, /spin_forever/);
	assert.match(line, /lib\.ts:9/);
	const by = cases_of(dir);
	assert.match(by.get('spins')!.error!, /HB_RUNAWAY/);
	assert.equal(by.get('before')!.error, null);
	assert.equal(by.get('after')!.error, null, 'the case after the runaway one still counts');
	assert.ok(by.get('after')!.totals.steps > 0);
});

function run_script(dir: string, ceiling: Record<string, number>): ReturnType<typeof node> {
	write_files(dir, {
		'go.ts': `import { CEILING, run_benches } from ${RUNNER};
Object.assign(CEILING, ${JSON.stringify(ceiling)});
const r = await run_benches({ files: ['spin.bench.ts'], out: 'r.json', log: (l) => console.log(l) });
process.exitCode = r.cases.some((c) => c.error !== null) ? 1 : 0;
`
	});
	return node(['go.ts'], dir, 60_000);
}

test('run: an async case that spins after an await is stopped the same way', () => {
	const dir = project(
		`bench('spins later', async () => { await Promise.resolve(); return spin_forever(); });`
	);
	const r = run_script(dir, { steps: 5e6 });
	assert.equal(r.code, 1, r.out + r.err);
	assert.match(r.out, /FAILED {3}spins later: .*HB_RUNAWAY.*spin_forever/);
	assert.equal(cases_of(dir).get('after')!.error, null);
});

test('run: a case whose setup loops forever is stopped at the step ceiling too, and says it was in setup', () => {
	const dir = project(
		`bench('spins in setup', () => 1, { setup: () => ({ n: spin_forever() }) });`
	);
	const r = run_script(dir, { steps: 5e6 });
	assert.equal(r.code, 1, r.out + r.err);
	assert.match(r.out, /FAILED {3}spins in setup: .*HB_RUNAWAY.*in setup.*spin_forever/);
	assert.equal(cases_of(dir).get('after')!.error, null);
});

test('run: a replay that counts far more than its own recording is stopped at a multiple of the recorded count', () => {
	const dir = project(`const g = globalThis as { hb_runs?: number };
bench('grows on replay', () => spin_after_records((g.hb_runs = (g.hb_runs ?? 0) + 1) === 1 ? 100 : 1e9));`);
	const r = run_script(dir, { steps: 1e12 });
	assert.notEqual(r.signal, 'SIGKILL', `the replay ran to the absolute ceiling\n${r.out}${r.err}`);
	assert.equal(r.code, 1, r.out + r.err);
	assert.match(r.out, /FAILED {3}grows on replay: .*HB_RUNAWAY.*recording run counted/);
});

test('run: a case that spins in code nothing counts is stopped by the wall-clock backstop, named', () => {
	const dir = project(`bench('spins uncounted', () => { for (;;) {} });`);
	const started = Date.now();
	const r = run_script(dir, { wall_ms: 1500 });
	assert.ok(Date.now() - started < 30_000, `the backstop never fired\n${r.out}${r.err}`);
	assert.match(r.err, /HB_STALLED/);
	assert.match(r.err, /spins uncounted/);
	assert.match(r.err, /spin\.bench\.ts/);
	assert.notEqual(r.code, 0);
});

test('run: normal cases count the same with the ceiling in place', () => {
	const dir = project('');
	const r = node([CLI, 'run', 'spin.bench.ts', '--out', 'r.json'], dir);
	assert.equal(r.code, 0, r.out + r.err);
	const by = cases_of(dir);
	assert.equal(by.get('before')!.error, null);
	assert.equal(by.get('after')!.error, null);
});
