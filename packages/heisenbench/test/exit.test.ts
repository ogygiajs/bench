import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Report } from '../src/report.ts';
import { IDLE_EXIT_MS } from '../src/proc.ts';
import { temp_dir, write_files } from './helpers.ts';

/*
 * How a Heisenbench process ends. A run that wrote a 200 MB report hung at 0% CPU one time in
 * three: in process.exit(), the main thread joined V8's worker threads while one of them, compiling
 * a Sparkplug batch, waited for the main thread to collect garbage. The native deadlock does not
 * show on demand, so these tests pin what rules it out: every Heisenbench process turns concurrent
 * Sparkplug off before anything else runs, the CLI ends by its event loop emptying (no
 * process.exit while work may be in flight), and what a bench leaves open is named and does not
 * keep the process up.
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const CLI = join(SRC, 'cli.ts');
const BENCH_API = JSON.stringify(pathToFileURL(join(SRC, 'bench.ts')).href);
/** What the watchdog prints when the loop did not empty by itself. */
const KEPT_ALIVE = /still kept the process alive/;

function cli(
	args: string[],
	cwd: string
): Promise<{ code: number | null; signal: string | null; out: string; err: string; ms: number }> {
	const t0 = performance.now();
	return new Promise((resolve) => {
		const c = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		c.stdout.on('data', (d: Buffer) => (out += d));
		c.stderr.on('data', (d: Buffer) => (err += d));
		const timer = setTimeout(() => c.kill('SIGKILL'), 120_000);
		c.on('close', (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, out, err, ms: performance.now() - t0 });
		});
	});
}

/** Every file Heisenbench starts a process with: the CLI and each child script. */
function entry_points(): string[] {
	const found = ['cli.ts'];
	for (const dir of readdirSync(SRC, { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		for (const f of readdirSync(join(SRC, dir.name)))
			if (f === 'child.ts' || f.endsWith('-child.ts')) found.push(`${dir.name}/${f}`);
	}
	return found;
}

test('every Heisenbench process sets its V8 flags before it imports anything else', () => {
	const entries = entry_points();
	assert.ok(entries.length >= 8, entries.join(', '));
	for (const e of entries) {
		const first = readFileSync(join(SRC, e), 'utf8')
			.split('\n')
			.find((l) => l.startsWith('import '));
		const want = e.includes('/') ? "import '../v8-flags.ts';" : "import './v8-flags.ts';";
		assert.equal(first, want, `${e} imports v8-flags.ts first`);
	}
});

test('the CLI never calls process.exit itself: it leaves when its loop is empty', () => {
	const text = readFileSync(CLI, 'utf8');
	assert.ok(!/process\.(exit|reallyExit)\s*\(/.test(text), 'no process.exit in cli.ts');
	assert.match(text, /exit_when_idle\(code, prefix\);\s*$/);
});

test('a run with a big report, and an --append onto it, end by themselves with the report written', async () => {
	const dir = temp_dir('heisenbench-exit-');
	const many = (tag: string, n: number) =>
		`import { bench } from ${BENCH_API};\nimport { work } from './lib.ts';\nfor (let i = 0; i < ${n}; i++) bench(\`${tag} \${i}\`, () => work(i));\n`;
	write_files(dir, {
		'lib.ts': `export function work(n: number) {\n\tconst out: number[] = [];\n\tfor (let i = 0; i < 40; i++) out.push((n * i) % 7);\n\treturn out.reduce((a, b) => a + b, 0);\n}\n`,
		'a.bench.ts': many('a', 600),
		'b.bench.ts': many('b', 400)
	});
	const first = await cli(['run', 'a.bench.ts', '--out', 'r.json'], dir);
	assert.equal(first.signal, null, first.err);
	assert.equal(first.code, 0, first.out + first.err);
	assert.doesNotMatch(first.err, KEPT_ALIVE, 'nothing was left open: the loop emptied by itself');
	const text = readFileSync(join(dir, 'r.json'), 'utf8');
	const report = JSON.parse(text) as Report;
	assert.equal(report.cases.length, 600);
	assert.equal(
		text,
		JSON.stringify(report, null, '\t') + '\n',
		'the format of every report so far'
	);

	const second = await cli(['run', 'b.bench.ts', '--out', 'r.json', '--append'], dir);
	assert.equal(second.signal, null, second.err);
	assert.equal(second.code, 0, second.out + second.err);
	assert.doesNotMatch(second.err, KEPT_ALIVE);
	assert.match(second.out, /appended to r\.json: 1000 cases in all/);
	const merged_text = readFileSync(join(dir, 'r.json'), 'utf8');
	const merged = JSON.parse(merged_text) as Report;
	assert.deepEqual(
		merged.cases.slice(0, 600),
		report.cases,
		'the earlier cases are kept as they were'
	);
	assert.equal(merged.cases[600]?.name, 'b 0');
	assert.equal(merged_text, JSON.stringify(merged, null, '\t') + '\n');
	assert.deepEqual(readdirSync(dir).sort(), ['a.bench.ts', 'b.bench.ts', 'lib.ts', 'r.json']);
});

test('a bench that leaves a timer open: the run still ends, names the timer, and keeps its exit code', async () => {
	const dir = temp_dir('heisenbench-exit-');
	write_files(dir, {
		'open.bench.ts': `import { bench } from ${BENCH_API};\nsetInterval(() => {}, 1000);\nbench('leaves a timer', () => 1);\n`
	});
	const r = await cli(['run', 'open.bench.ts', '--out', 'r.json'], dir);
	assert.equal(r.signal, null, 'it ended by itself');
	assert.equal(r.code, 0, r.out + r.err);
	assert.match(
		r.err,
		/^heisenbench run: done, but Timeout( \(\d+\))? still kept the process alive after \d+ ms \(a bench left it open\); exiting$/m
	);
	assert.ok(r.ms >= IDLE_EXIT_MS, 'it waited for the loop first');
	assert.equal((JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')) as Report).cases.length, 1);
});
