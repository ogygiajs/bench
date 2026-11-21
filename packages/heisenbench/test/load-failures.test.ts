import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { record_transform } from '../src/coverage/record-transform.ts';
import { recorder } from '../src/coverage/recorder.ts';
import { diff_growth } from '../src/growth/index.ts';
import type { GrowthReport } from '../src/growth/index.ts';
import type { Report } from '../src/report.ts';
import { temp_dir, write_files } from './helpers.ts';

/*
 * A bench file that does not load is a failure of the command that read it, never a smaller run:
 * the exit code says so, and the report names the file and its error. Planted: a good bench file
 * next to one that throws on import and one that imports a module that is not there (a package
 * whose build was never run).
 */

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const BENCH_API = JSON.stringify(
	pathToFileURL(fileURLToPath(new URL('../src/bench.ts', import.meta.url))).href
);

function heisenbench(args: string[], cwd: string, timeout = 120_000) {
	const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout });
	return { code: r.status, out: r.stdout, err: r.stderr };
}

const LIB = `export function total(xs: number[]): number {
	let s = 0;
	for (const x of xs) s += x;
	return s;
}
`;

function project(): string {
	const dir = temp_dir('heisenbench-load-');
	write_files(dir, {
		'package.json': '{ "type": "module" }',
		'lib.ts': LIB,
		'ok.bench.ts': `import { bench } from ${BENCH_API};
import { total } from './lib.ts';
const list = (n: number) => Array.from({ length: n }, (_, i) => i);
bench('total', ({ xs }) => total(xs), {
	setup: () => ({ xs: list(20) }),
	scale: (_c, k) => ({ xs: list(20 * k) })
});
`,
		'throws.bench.ts': `import { bench } from ${BENCH_API};\nvoid bench;\nthrow new Error('top-level boom');\n`,
		'missing.bench.ts': `import { bench } from ${BENCH_API};
import { helper } from './utils/dist/index.js';
bench('never loads', () => helper());
`
	});
	return dir;
}

const BAD = ['throws.bench.ts', 'missing.bench.ts'];
const FILES = ['ok.bench.ts', ...BAD];

function failed_files(list: Array<{ file: string; error: string }> | undefined): string[] {
	return (list ?? []).map((f) => f.file).sort();
}

function assert_failed(list: Array<{ file: string; error: string }> | undefined): void {
	assert.deepEqual(failed_files(list), [...BAD].sort());
	const by = new Map((list ?? []).map((f) => [f.file, f.error]));
	assert.match(by.get('throws.bench.ts')!, /top-level boom/);
	assert.match(by.get('missing.bench.ts')!, /utils\/dist\/index\.js/);
}

test('growth: a bench file that does not load fails the run and is named in the report', () => {
	const dir = project();
	const r = heisenbench(
		['growth', ...FILES, '--scaled', 'on', '--sizes', '1,2,4', '--out', 'g.json'],
		dir
	);
	assert.equal(r.code, 1, `a file that did not load fails growth\n${r.out}${r.err}`);
	const g = (JSON.parse(readFileSync(join(dir, 'g.json'), 'utf8')) as Report).growth!;
	assert_failed(g.failed);
	assert.deepEqual(
		g.cases.map((c) => [c.name, c.error]),
		[['total', null]],
		'the files that load are still grown'
	);
});

test('growth --cache: a bench file that does not load fails the run and is named in the report', () => {
	const dir = project();
	for (const round of [1, 2]) {
		const r = heisenbench(
			['growth', ...FILES, '--sizes', '1,2,4', '--cache', 'cache', '--out', 'g.json'],
			dir
		);
		assert.equal(
			r.code,
			1,
			`round ${round}: a file that did not load fails growth\n${r.out}${r.err}`
		);
		const g = (JSON.parse(readFileSync(join(dir, 'g.json'), 'utf8')) as Report).growth!;
		assert_failed(g.failed);
	}
});

test('growth: every file loads, so nothing failed and the run passes', () => {
	const dir = project();
	const r = heisenbench(['growth', 'ok.bench.ts', '--sizes', '1,2,4', '--out', 'g.json'], dir);
	assert.equal(r.code, 0, r.out + r.err);
	const g = (JSON.parse(readFileSync(join(dir, 'g.json'), 'utf8')) as Report).growth!;
	assert.deepEqual(g.failed, []);
});

test('search: a bench file that does not load fails the run and is named in the report', () => {
	const dir = project();
	const r = heisenbench(['search', ...FILES, '--evals', '20', '--out', 's.json'], dir);
	assert.equal(r.code, 1, `a file that did not load fails search\n${r.out}${r.err}`);
	const s = (JSON.parse(readFileSync(join(dir, 's.json'), 'utf8')) as Report).search!;
	assert_failed(s.failed);
	assert.ok(s.cases.some((c) => c.name === 'total' && c.error === null));
});

test('contracts: growth with a file that did not load fails the check, though every contract holds', () => {
	const dir = project();
	writeFileSync(join(dir, 'lib.ts'), `/** @heisenbench linear in xs */\n${LIB}`);
	heisenbench(['growth', ...FILES, '--sizes', '1,10,100', '--out', 'g.json'], dir);
	const r = heisenbench(
		[
			'contracts',
			'lib.ts',
			'--reports',
			'g.json',
			'--root',
			dir,
			'--out',
			'c.json',
			'--md',
			'c.md'
		],
		dir
	);
	const c = (JSON.parse(readFileSync(join(dir, 'c.json'), 'utf8')) as Report).contracts!;
	assert.deepEqual(
		c.contracts.map((x) => [x.path, x.verdict]),
		[['total', 'holds']]
	);
	assert.equal(r.code, 1, `the growth it judges is missing files\n${r.out}${r.err}`);
	assert.equal(c.pass, false);
	assert_failed(c.failed);
	assert.match(readFileSync(join(dir, 'c.md'), 'utf8'), /throws\.bench\.ts/);
	assert.match(r.out, /FAILED +throws\.bench\.ts/);
});

test('contracts: a source file that cannot be read fails the check', () => {
	const dir = project();
	writeFileSync(join(dir, 'lib.ts'), `/** @heisenbench linear in xs */\n${LIB}`);
	writeFileSync(join(dir, 'broken.ts'), 'export function (\n');
	heisenbench(['growth', 'ok.bench.ts', '--sizes', '1,10,100', '--out', 'g.json'], dir);
	const r = heisenbench(
		['contracts', 'lib.ts', 'broken.ts', '--reports', 'g.json', '--root', dir, '--out', 'c.json'],
		dir
	);
	assert.equal(r.code, 1, `a source file it could not read is unchecked\n${r.out}${r.err}`);
	const c = (JSON.parse(readFileSync(join(dir, 'c.json'), 'utf8')) as Report).contracts!;
	assert.deepEqual(failed_files(c.failed), ['broken.ts']);
});

test('growth --recorded: a recorded module that does not load fails the run and is named in the report', async () => {
	const dir = temp_dir('heisenbench-load-recorded-');
	const rec_dir = join(dir, 'recording');
	const src = `export function total(xs) {\n\tlet s = 0;\n\tfor (const x of xs) s += x;\n\treturn s;\n}\n`;
	const t = record_transform(src, { filename: join(rec_dir, 'lib.js'), id: 'lib.js' });
	write_files(rec_dir, { 'lib.js': t.code });
	const m = (await import(pathToFileURL(join(rec_dir, 'lib.js')).href)) as {
		total: (xs: number[]) => number;
	};
	recorder.reset();
	for (const n of [10, 40, 90, 200, 400, 25, 60, 150])
		m.total(Array.from({ length: n }, (_, i) => i));
	mkdirSync(join(dir, 'records'), { recursive: true });
	recorder.save(join(dir, 'records', 'tests.bin'));
	recorder.reset();
	// the code under count: a module that throws as it loads
	write_files(dir, {
		'package.json': '{ "type": "module" }',
		'lib.js': `throw new Error('lib boom');\n`
	});
	const r = heisenbench(
		['growth', '--recorded', 'records', '--root', dir, '--out', 'g.json', '--md', 'g.md'],
		dir
	);
	assert.equal(r.code, 1, `a module that did not load fails recorded growth\n${r.out}${r.err}`);
	const g = (JSON.parse(readFileSync(join(dir, 'g.json'), 'utf8')) as Report).recorded_growth!;
	assert.deepEqual(
		(g.failed ?? []).map((f) => f.file),
		['lib.js']
	);
	assert.match(g.failed![0].error, /lib boom/);
	assert.match(readFileSync(join(dir, 'g.md'), 'utf8'), /lib\.js/);
});

test('record: a bench file that does not load fails the recording', () => {
	const dir = project();
	writeFileSync(join(dir, 't.json'), JSON.stringify({ 'lib.ts': ['total'] }));
	const r = heisenbench(['record', ...FILES, '--targets', 't.json', '--out', 's.bin'], dir);
	assert.equal(r.code, 1, `a file that did not load fails the recording\n${r.out}${r.err}`);
	assert.match(r.out, /2 bench files did not load/);
});

test('prove --bench: a bench file that does not load is no proof', () => {
	const dir = project();
	writeFileSync(
		join(dir, 'fast.ts'),
		`export function total(xs: number[]): number {\n\tlet s = 0;\n\tfor (let i = 0; i < xs.length; i++) s += xs[i];\n\treturn s;\n}\n`
	);
	const r = heisenbench(
		[
			'prove',
			'lib.ts',
			'total',
			'--candidate',
			'fast.ts',
			'--bench',
			FILES.join(','),
			'--out',
			'p.json'
		],
		dir
	);
	assert.notEqual(r.code, 0, `proven on fewer inputs than the bench files give\n${r.out}${r.err}`);
	assert.match(r.out + r.err, /throws\.bench\.ts/);
});

test('diff: growth files that did not load on either side are listed as failed', () => {
	const report = (failed: GrowthReport['failed']): GrowthReport => ({
		schema: 'heisenbench-growth/1' as GrowthReport['schema'],
		sizes: [1, 10, 100],
		cases: [],
		failed
	});
	const d = diff_growth(
		report([]),
		report([{ file: 'collab.bench.ts', error: 'Cannot find module ./dist/index.js' }])
	);
	assert.deepEqual(d.failed, ['collab.bench.ts']);
});
