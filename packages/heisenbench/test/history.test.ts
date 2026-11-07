import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { align_lines, likeness } from '../src/history/align.ts';
import { parse_blame } from '../src/history/git.ts';
import { build_history, run_of } from '../src/history/index.ts';
import type { HistoryLine, HistoryResult, HistoryRun } from '../src/history/index.ts';
import { render_history, render_history_text } from '../src/history/markdown.ts';
import { load_prices } from '../src/prices.ts';
import { REPORT_SCHEMA } from '../src/report.ts';
import type { Report } from '../src/report.ts';
import { temp_dir, write_files } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const BENCH_API = JSON.stringify(
	pathToFileURL(fileURLToPath(new URL('../src/bench.ts', import.meta.url))).href
);

function git(dir: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd: dir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 't',
			GIT_AUTHOR_EMAIL: 't@t',
			GIT_COMMITTER_NAME: 't',
			GIT_COMMITTER_EMAIL: 't@t'
		}
	}).trim();
}

function commit(
	dir: string,
	files: Record<string, string>,
	message: string,
	remove: string[] = []
): string {
	write_files(dir, files);
	for (const f of remove) git(dir, 'rm', '-q', f);
	git(dir, 'add', '-A');
	git(dir, 'commit', '-q', '-m', message);
	return git(dir, 'rev-parse', 'HEAD');
}

function heisenbench(args: string[], cwd: string): string {
	const r = spawnSync(process.execPath, [CLI, ...args], {
		cwd,
		encoding: 'utf8',
		timeout: 300_000
	});
	assert.ok(r.status === 0, `heisenbench ${args[0]} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
	return r.stdout;
}

test('likeness and align_lines pair an edited line with the line it was, in order', () => {
	assert.equal(likeness('\tlet s = 0;', 'let  s = 0;'), 1);
	assert.ok(likeness('return line_at(src, i);', 'return line_at(newlines, i);') > 0.5);
	assert.ok(likeness('let lo = 0;', 'for (const k of Object.keys(node)) {') < 0.5);
	assert.equal(likeness('', ''), 0, 'blank lines are never paired');
	assert.deepEqual(
		align_lines(
			['let line = base_line;', 'for (let i = 0; i < n; i++) line++;', 'return line;'],
			['let lo = 0;', 'for (let i = 0; i < n; i += 2) line++;', 'return line + lo;']
		),
		[
			[1, 1],
			[2, 2]
		]
	);
	// never crossing: the better total wins
	assert.deepEqual(align_lines(['a = b + c;', 'x = y + z;'], ['x = y + z;', 'a = b + c;']), [
		[0, 1]
	]);
});

test('parse_blame reads every line of --line-porcelain, its boundary commit, path and line', () => {
	const sha = 'a'.repeat(40);
	const out = [
		`${sha} 7 1 2`,
		'author t',
		'boundary',
		'filename src/old.ts',
		'\tconst a = 1;',
		`${sha} 8 2`,
		'author t',
		'filename src/old.ts',
		'\tconst b = 2;',
		`${'b'.repeat(40)} 3 3 1`,
		'filename src/new.ts',
		'\t'
	].join('\n');
	assert.deepEqual(parse_blame(out), [
		{ commit: sha, path: 'src/old.ts', line: 7 },
		{ commit: sha, path: 'src/old.ts', line: 8 },
		{ commit: 'b'.repeat(40), path: 'src/new.ts', line: 3 }
	]);
});

const BENCH = `import { bench } from ${BENCH_API};
import { total } from '../src/lib.ts';

const data = Array.from({ length: 200 }, (_, i) => i);
bench('total of 200', () => total(data));
`;

const TOTAL = `export function total(xs: number[]): number {
	let sum = 0;
	for (const value of xs) sum += value;
	return sum;
}
`;

const TOTAL_SLOWER = `export function total(xs: number[]): number {
	let sum = 0;
	for (const value of xs) sum += value;
	for (let pass = 0; pass < 3; pass++) for (const value of xs) sum += 0;
	return sum;
}
`;

const TWICE = `export function twice(xs: number[]): number[] {
	const out: number[] = [];
	for (const value of xs) out.push(value * 2);
	return out;
}
`;

test('history: a line keeps its history through a move to another file, a reorder and an edit', () => {
	const dir = temp_dir('heisenbench-history-');
	const runs = join(dir, '..', `${dir.split('/').pop()}-runs`);
	mkdirSync(runs, { recursive: true });
	git(dir, 'init', '-q');
	const count = (sha: string) =>
		heisenbench(
			[
				'run',
				'bench/total.bench.ts',
				'--root',
				dir,
				'--sha',
				sha,
				'--out',
				join(runs, `${sha}.json`)
			],
			dir
		);
	const label = `export function label(n: number): string {\n\treturn 'n=' + n;\n}\n`;
	const c1 = commit(
		dir,
		{ 'bench/total.bench.ts': BENCH, 'src/lib.ts': TOTAL + label },
		'base (#1)'
	);
	count(c1);
	const c2 = commit(dir, { 'src/lib.ts': TOTAL_SLOWER + label }, 'three more passes (#2)');
	count(c2);
	// the function moves to its own file; lib.ts re-exports it
	const c3 = commit(
		dir,
		{
			'src/lib.ts': `export { total } from './math.ts';\n` + label,
			'src/math.ts': TOTAL_SLOWER + '\n' + TWICE
		},
		'total moves to math.ts (#3)'
	);
	count(c3);
	// reordered inside the file
	const c4 = commit(dir, { 'src/math.ts': TWICE + '\n' + TOTAL_SLOWER }, 'twice first (#4)');
	count(c4);
	// the first loop's line edited in place: it costs more
	const c5 = commit(
		dir,
		{
			'src/math.ts': TWICE + '\n' + TOTAL_SLOWER.replace('sum += value;', 'sum += value * 1;')
		},
		'the sum multiplies (#5)'
	);
	count(c5);
	const c6 = commit(dir, { 'README.md': 'notes\n' }, 'docs (#6)');
	count(c6);

	const out = join(runs, 'history.json');
	const md = join(runs, 'history.md');
	const text = heisenbench(
		['history', 'src/math.ts:total', '--reports', runs, '--repo', dir, '--out', out, '--md', md],
		dir
	);
	const r = JSON.parse(readFileSync(out, 'utf8')) as HistoryResult;
	assert.equal(r.runs.length, 6);
	assert.deepEqual(
		r.runs.map((x) => x.pr),
		[1, 2, 3, 4, 5, 6]
	);
	const line = (s: string): HistoryLine => r.lines.find((l) => l.text.includes(s))!;
	const passes = line('pass < 3');
	assert.equal(passes.last?.kind, 'new code');
	assert.equal(passes.last?.commits[0].sha, c2, 'the passes were added by #2');
	assert.ok(passes.last!.delta! > 0);
	assert.equal(passes.events.length, 1, 'the move and the reorder changed nothing');
	assert.deepEqual(
		passes.at.map((p) => p?.path ?? null),
		[null, 'src/lib.ts', 'src/math.ts', 'src/math.ts', 'src/math.ts', 'src/math.ts']
	);
	const sum = line('sum += value * 1');
	assert.equal(sum.last?.commits[0].sha, c5, 'the edit in #5 made it cost more');
	assert.equal(sum.last?.edited, true);
	assert.ok(sum.last!.delta! > 0 && sum.last!.before! > 0);
	assert.equal(sum.at[0]?.path, 'src/lib.ts', 'its history goes back to before the move');
	assert.equal(sum.events.length, 1);
	assert.equal(line('let sum = 0').last, null, 'an unchanged line has no change');

	const fn = r.functions.find((f) => f.id === 'src/math.ts > total')!;
	assert.ok(fn.was.includes('src/lib.ts > total'), 'the moved function keeps its history');
	assert.equal(fn.timeline.length, 6);
	assert.deepEqual(
		fn.timeline.filter((t) => t.change).map((t) => t.change!.commits[0].sha),
		[c2, c5]
	);
	assert.equal(fn.last?.commits[0].sha, c5);
	assert.match(text, new RegExp(`${c2.slice(0, 8)} \\(#2\\)`));
	assert.match(readFileSync(md, 'utf8'), /\| Commit \| Subject \| Self steps \| Δ \|/);
	const missing = spawnSync(
		process.execPath,
		[CLI, 'history', 'src/math.ts:nothing_here', '--reports', runs, '--repo', dir],
		{ cwd: dir, encoding: 'utf8' }
	);
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /no function "nothing_here" ran in src\/math\.ts/);
});

/** A report of one case with one function `f` of `src/a.ts`, whose line 2 costs `steps`. */
function report(sha: string, steps: number): Report {
	const { hash, prices } = load_prices();
	return {
		schema: REPORT_SCHEMA,
		prices: { version: prices.version, hash },
		node: 'v26.4.0',
		git: { sha, prefix: '' },
		cases: [
			{
				name: 'x',
				file: 'bench/x.bench.ts',
				stable: true,
				timers: 0,
				runaway_timers: false,
				error: null,
				totals: { steps: steps + 4, allocations: 0, bytes: 0, calls: 1 },
				functions: [
					{
						id: 'src/a.ts > f',
						module: 'src/a.ts',
						path: 'f',
						kind: 'function',
						line: 1,
						end_line: 3,
						calls: 1,
						self_steps: steps + 4,
						inclusive_steps: steps + 4,
						allocations: 0,
						bytes: 0,
						shape: [],
						blocks: [],
						sites: [],
						builtins: [],
						lines: [
							{ line: 1, steps: 4, allocations: 0, bytes: 0 },
							{ line: 2, steps, allocations: 0, bytes: 0 }
						]
					}
				],
				edges: []
			}
		]
	};
}

test('history: a counter change is marked, a changed input is left out, a gap names its commits', () => {
	const dir = temp_dir('heisenbench-history-marks-');
	git(dir, 'init', '-q');
	const a = `export function f(n: number): number {\n\treturn n + 1;\n}\n`;
	const c1 = commit(
		dir,
		{ 'src/a.ts': a, 'bench/x.bench.ts': 'export const n = 1;\n' },
		'one (#1)'
	);
	const c2 = commit(dir, { 'other.txt': '2\n' }, 'two (#2)');
	// a comment in the bench file is no change of input; the code is
	const c3 = commit(dir, { 'bench/x.bench.ts': '// more\nexport const n = 2;\n' }, 'three (#3)');
	const c4 = commit(dir, { 'other.txt': '4\n' }, 'four (#4)');
	const c5 = commit(dir, { 'other.txt': '5\n' }, 'five (#5)');
	const c6 = commit(dir, { 'bench/x.bench.ts': '// the input\nexport const n = 2;\n' }, 'six (#6)');
	const run = (sha: string, steps: number, counter: string): HistoryRun =>
		run_of({ meta: { sha, heisenbench: counter }, head: report(sha, steps) }, `${sha}.json`)!;
	const r = build_history({
		repo: dir,
		file: 'src/a.ts',
		rev: c6,
		runs: [
			run(c1, 100, 'A'),
			run(c2, 150, 'B'),
			run(c3, 300, 'B'),
			// no run of c4
			run(c5, 310, 'B'),
			run(c6, 330, 'B')
		]
	});
	assert.deepEqual(
		r.runs.map((x) => x.pr),
		[1, 2, 3, 5, 6]
	);
	assert.equal(r.transitions[0].counter_changed, true);
	assert.deepEqual(r.transitions[1].bench_changed, ['bench/x.bench.ts > x']);
	assert.deepEqual(r.transitions[3].bench_changed, [], 'a comment is not a new input');
	assert.deepEqual(
		r.transitions[2].commits.map((c) => c.sha),
		[c4, c5]
	);
	const l2 = r.lines[1];
	assert.deepEqual(
		l2.events.map((e) => [e.commits.at(-1)!.sha, e.delta, e.counter_changed]),
		[
			[c2, 50, true],
			[c5, 10, false],
			[c6, 20, false]
		]
	);
	assert.equal(l2.last?.commits[0].sha, c6);
	assert.equal(l2.steps, 330);
	assert.equal(l2.per_call, 330);
	assert.ok(r.notes.some((n) => n.includes('counter changed at 1 of 4')));
	assert.ok(r.notes.some((n) => n.includes('span more than one commit')));
	const text = render_history_text(r);
	assert.match(text, /\+50\) \[counter changed\]/);
	assert.match(text, new RegExp(`${c6.slice(0, 8)} \\(#6\\)  \\+6\\.\\d% \\(\\+20\\)`));
	assert.match(
		render_history(r),
		new RegExp(`${c4.slice(0, 8)}\\.\\.${c5.slice(0, 8)} \\(2 commits\\)`)
	);
	// only the counter-changed change: it is the last, still marked
	const marked = build_history({
		repo: dir,
		file: 'src/a.ts',
		rev: c2,
		runs: [run(c1, 100, 'A'), run(c2, 150, 'B')]
	});
	assert.equal(marked.lines[1].last?.counter_changed, true);
});
