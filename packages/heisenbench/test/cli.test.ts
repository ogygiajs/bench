import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Report } from '../src/report.ts';
import { temp_dir, write_files } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const BENCH_API = pathToFileURL(fileURLToPath(new URL('../src/bench.ts', import.meta.url))).href;

function heisenbench(args: string[], cwd: string, timeout = 60_000) {
	const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout });
	return { code: r.status, out: r.stdout, err: r.stderr, signal: r.signal };
}

/** No stack trace, no Node warning: what a user sees is Heisenbench's own lines. */
function clean(text: string): void {
	assert.ok(!/^\s+at .+:\d+:\d+\)?$/m.test(text), `a stack trace:\n${text}`);
	assert.ok(!text.includes('ExperimentalWarning'), `a warning:\n${text}`);
}

test('wrong or missing arguments: one line, exit 2, no stack', () => {
	const dir = temp_dir('heisenbench-cli-');
	writeFileSync(join(dir, 'not.json'), '{ nope');
	writeFileSync(join(dir, 'other.json'), '{"a":1}');
	const cases: Array<[string[], RegExp]> = [
		[['nope'], /unknown command nope/],
		[['--out', 'x'], /give a command before --out/],
		[['run'], /which files/],
		[['run', 'missing.bench.ts'], /no such file: missing\.bench\.ts/],
		[['run', 'C:\\work\\lib.bench.ts'], /no such file: C:\\work\\lib\.bench\.ts/],
		[['run', '.'], /is a directory/],
		[['run', 'not.json', '--out'], /--out needs a value/],
		[['run', 'not.json', '--bogus', '1'], /unknown option --bogus/],
		[['run', 'not.json', '--state', 'sometimes'], /--state takes fresh or shared/],
		[['run', 'not.json', '--root', 'nowhere'], /--root nowhere is not a directory/],
		[['run', 'not.json', '--out', 'no/such/dir/r.json'], /no directory/],
		[['health', 'not.json', '--runs', 'abc'], /--runs takes a whole number above 0/],
		[['growth', 'not.json', '--sizes', '1,x'], /--sizes takes numbers above 0/],
		[['diff', 'not.json'], /needs 2 files, got 1/],
		[['diff', 'not.json', 'other.json'], /not\.json is not JSON/],
		[['diff', 'other.json', 'other.json'], /other\.json is not an heisenbench report/],
		[['time', 'x.bench.ts', '--base', '.'], /--pr <dir> is required/],
		[['coverage', 'other.json'], /--app <app dir,app dir...> is required/],
		[['verify', 'extra'], /takes no file arguments/],
		[['calibrate', 'sideways'], /calibrate takes prices, points, agree, weights or ranges/]
	];
	for (const [args, msg] of cases) {
		const r = heisenbench(args, dir);
		assert.equal(r.code, 2, `${args.join(' ')}: exit ${r.code}\n${r.err}`);
		assert.match(r.err, msg, args.join(' '));
		assert.ok(r.err.trim().split('\n').length <= 2, `${args.join(' ')}: ${r.err}`);
		clean(r.err);
	}
	const help = heisenbench(['--help'], dir);
	assert.equal(help.code, 0);
	assert.match(help.out, /heisenbench run <bench files/);
	assert.equal(heisenbench([], dir).code, 2, 'no command at all prints the help and exits 2');
});

test('bad bench files are reported one by one; the good ones are counted', () => {
	const dir = temp_dir('heisenbench-cli-');
	const api = JSON.stringify(BENCH_API);
	write_files(dir, {
		'lib.ts': 'export function add(a: number, b: number) { return a + b; }\n',
		'kinds.ts': `export enum Color { Red, Green = 'g' }
export namespace Shapes { export const sides = (n: number) => n * 2; }
export class Point {
	constructor(public x: number, private y: number) {}
	sum(): number { return this.x + this.y; }
}
`,
		'ok.bench.ts': `import { bench } from ${api};\nimport { add } from './lib.ts';\nbench('adds', () => add(1, 2));\n`,
		'kinds.bench.ts': `import { bench } from ${api};
import { Color, Shapes, Point } from './kinds.ts';
enum Local { A = 1 }
bench('ts kinds', () => new Point(Local.A, 2).sum() + Shapes.sides(3) + (Color.Green === 'g' ? 1 : 0));
`,
		'naïve café.bench.ts': `import { bench } from ${api};\nimport { add } from './lib.ts';\nbench('unicode file', () => add(2, 3));\n`,
		'empty.bench.ts': `import { bench } from ${api};\nvoid bench;\n`,
		'throws.bench.ts': `import { bench } from ${api};\nvoid bench;\nthrow new Error('top-level boom\\nsecond line');\n`,
		'syntax.bench.ts': `import { bench } from ${api};\nbench('x', () => {;\n`,
		'case-throws.bench.ts': `import { bench } from ${api};\nbench('throws inside', () => { throw new TypeError('inner boom'); });\n`,
		'stuck.bench.ts': `import { bench } from ${api};\nbench('never resolves', () => new Promise(() => {}));\n`,
		'handle.bench.ts': `import { bench } from ${api};\nsetInterval(() => {}, 1000);\nbench('leaves a timer', () => 1);\n`,
		'dup.bench.ts': `import { bench } from ${api};\nbench('same', () => 1);\nbench('same', () => 2);\n`
	});
	const files = [
		'ok.bench.ts',
		'kinds.bench.ts',
		'naïve café.bench.ts',
		'empty.bench.ts',
		'throws.bench.ts',
		'syntax.bench.ts',
		'case-throws.bench.ts',
		'stuck.bench.ts',
		'handle.bench.ts',
		'dup.bench.ts'
	];
	const r = heisenbench(['run', ...files, '--out', 'r.json'], dir, 120_000);
	assert.equal(r.signal, null, 'the run ended by itself (a live timer did not keep it up)');
	assert.equal(r.code, 1, r.out + r.err);
	clean(r.out + r.err);
	const report = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')) as Report;
	const by = new Map(report.cases.map((c) => [c.name, c]));
	assert.ok((by.get('adds')?.totals.steps ?? 0) > 0);
	assert.ok((by.get('unicode file')?.totals.steps ?? 0) > 0);
	assert.equal(by.get('unicode file')?.file, 'naïve café.bench.ts');
	const kinds = by.get('ts kinds')!;
	assert.equal(kinds.error, null);
	assert.ok(
		kinds.functions.some(
			(f) => f.module === 'kinds.ts' && f.path === 'Point > sum' && f.line === 5
		),
		'parameter properties compile and keep their lines'
	);
	assert.match(by.get('throws inside')!.error!, /inner boom/);
	assert.match(by.get('never resolves')!.error!, /never finished/);
	assert.equal(by.get('leaves a timer')!.error, null);
	const errors = new Map((report.load_errors ?? []).map((e) => [e.file, e.error]));
	assert.match(errors.get('throws.bench.ts')!, /^top-level boom$/);
	assert.ok(errors.has('syntax.bench.ts'));
	assert.match(errors.get('dup.bench.ts')!, /two cases in dup\.bench\.ts are named 'same'/);
	assert.match(r.out, /NO CASES empty\.bench\.ts/);
	assert.match(r.out, /FAILED   throws\.bench\.ts: top-level boom/);
	// outside git: no commit, no failure
	assert.equal(report.git.sha, null);
	assert.ok(report.env && report.env.node === process.version && report.env.v8.length > 0);
});

test('Ctrl-C mid-run stops the run and the layer children it started', async () => {
	const dir = temp_dir('heisenbench-cli-');
	write_files(dir, {
		'lib.ts':
			'export function spin(n: number) { let s = 0; for (let i = 0; i < n; i++) s += i; return s; }\n',
		'slow.bench.ts': `import { bench } from ${JSON.stringify(BENCH_API)};\nimport { spin } from './lib.ts';\nbench('slow', () => spin(2000));\n`
	});
	const child = spawn(
		process.execPath,
		[CLI, 'run', 'slow.bench.ts', '--measure', 'time', '--time-ms', '20000'],
		{ cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }
	);
	let err = '';
	child.stderr.on('data', (d) => (err += d));
	const children = (): number[] => {
		const ps = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
		return ps
			.split('\n')
			.map((l) => l.trim().split(/\s+/))
			.filter((p) => Number(p[1]) === child.pid)
			.map((p) => Number(p[0]));
	};
	// wait until the time layer's child runs
	let kids: number[] = [];
	for (let i = 0; i < 200 && kids.length === 0; i++) {
		await new Promise((r) => setTimeout(r, 100));
		kids = children();
	}
	assert.ok(kids.length > 0, 'the time layer child started');
	const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
	child.kill('SIGINT');
	assert.equal(await exited, 130);
	assert.match(err, /heisenbench: stopped \(SIGINT\)/);
	await new Promise((r) => setTimeout(r, 300));
	for (const pid of kids) {
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
		assert.equal(alive, false, `child ${pid} outlived the run`);
	}
});
