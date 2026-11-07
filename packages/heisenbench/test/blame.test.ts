import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ddmin, split } from '../src/blame/ddmin.ts';
import type { Outcome } from '../src/blame/ddmin.ts';
import { diff_units } from '../src/blame/hunks.ts';
import { mirror_tree, remove_tree, write_tree } from '../src/blame/tree.ts';
import { move_args } from '../src/blame/index.ts';
import type { BlameResult } from '../src/blame/index.ts';
import { parse_diff } from '../src/diff/git.ts';
import { WEIGHTS_SCHEMA, canonical_function } from '../src/weight/weights.ts';
import type { AppWeights } from '../src/weight/weights.ts';
import { round_sig, sum_costs } from '../src/weight/cost.ts';
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

function commit(dir: string, files: Record<string, string>, message: string): string {
	write_files(dir, files);
	git(dir, 'add', '-A');
	git(dir, 'commit', '-q', '-m', message);
	return git(dir, 'rev-parse', 'HEAD');
}

function heisenbench(args: string[], cwd: string) {
	const r = spawnSync(process.execPath, [CLI, ...args], {
		cwd,
		encoding: 'utf8',
		timeout: 300_000
	});
	assert.ok(r.status === 0, `heisenbench ${args[0]} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
	return r.stdout;
}

/** A fixture repo with a base and a head commit; both counted; then blamed. */
function blame_fixture(
	base: Record<string, string>,
	head: Record<string, string>,
	extra: string[] = []
): { result: BlameResult; md: string; dir: string } {
	const dir = temp_dir('heisenbench-blame-');
	git(dir, 'init', '-q');
	const b = commit(dir, base, 'base');
	heisenbench(
		['run', 'work.bench.ts', '--root', dir, '--out', join(dir, '..', `${b}.base.json`)],
		dir
	);
	const h = commit(dir, head, 'head');
	heisenbench(
		['run', 'work.bench.ts', '--root', dir, '--out', join(dir, '..', `${h}.pr.json`)],
		dir
	);
	const out = join(dir, '..', `${h}.blame.json`);
	const md_file = join(dir, '..', `${h}.blame.md`);
	heisenbench(
		[
			'blame',
			join(dir, '..', `${b}.base.json`),
			join(dir, '..', `${h}.pr.json`),
			'--root',
			dir,
			'--jobs',
			'2',
			'--out',
			out,
			'--md',
			md_file,
			...extra
		],
		dir
	);
	assert.equal(git(dir, 'status', '--porcelain'), '', 'the checkout is never written to');
	return {
		result: JSON.parse(readFileSync(out, 'utf8')) as BlameResult,
		md: readFileSync(md_file, 'utf8'),
		dir
	};
}

/** Filler: unchanged lines that keep two hunks apart (more than MERGE_GAP). */
const GAP = Array.from({ length: 8 }, (_, i) => `// note ${i}`).join('\n');

const BENCH = `import { bench } from ${BENCH_API};
import { total, label, scale } from './lib/work.ts';
import { pad, join_words } from './lib/fmt.ts';

const data = Array.from({ length: 200 }, (_, i) => i);
bench('sums a scaled list', () => total(scale(data, 2)) + label(3).length + pad('x', 4).length + join_words('a', 'b').length);
`;

const WORK_BASE = `export function total(xs: number[]): number {
	let s = 0;
	for (const x of xs) s += x;
	return s;
}
${GAP}
export function label(n: number): string {
	const text = 'n=' + n;
	return text;
}
${GAP}
export function scale(xs: number[], k: number): number[] {
	const out: number[] = [];
	for (let i = 0; i < xs.length; i++) out.push(xs[i] * k);
	return out;
}
`;

// 1: a loop that doubles the work; 2: cosmetic; 3: a renamed variable
const WORK_HEAD = `export function total(xs: number[]): number {
	let s = 0;
	for (const x of xs) s += x;
	for (const x of xs) s += x * 0;
	return s;
}
${GAP}
export function label(n: number): string {
	// the label of a count
	const text = 'n=' + n;
	return text;
}
${GAP}
export function scale(xs: number[], k: number): number[] {
	const result: number[] = [];
	for (let i = 0; i < xs.length; i++) result.push(xs[i] * k);
	return result;
}
`;

const FMT_BASE = `export function pad(s: string, n: number): string {
	let out = s;
	while (out.length < n) out = out + ' ';
	return out;
}
${GAP}
export function join_words(a: string, b: string): string {
	const parts = [a, b];
	const glue = ' ';
	return parts.join(glue);
}
${GAP}
export const VERSION = 1;
`;

// 4: an unrelated function; 5: slightly faster; 6: cosmetic
const FMT_HEAD = `export function pad(s: string, n: number): string {
	let out = s;
	while (out.length < n) out = out + ' ';
	return out;
}

export function shout(s: string): string {
	return s.toUpperCase() + '!';
}
${GAP}
export function join_words(a: string, b: string): string {
	return a + ' ' + b;
}
${GAP}
export const VERSION = 1; // bumped by hand
`;

test('blame names exactly the hunk that doubles the work, among six', () => {
	const { result, md } = blame_fixture(
		{ 'work.bench.ts': BENCH, 'lib/work.ts': WORK_BASE, 'lib/fmt.ts': FMT_BASE },
		{ 'lib/work.ts': WORK_HEAD, 'lib/fmt.ts': FMT_HEAD }
	);
	assert.equal(result.units.length, 6, result.units.map((u) => `${u.file}:${u.lines}`).join(' '));
	assert.equal(result.cases.length, 1);
	const c = result.cases[0];
	assert.equal(c.status, 'found', c.note ?? '');
	const slow = result.units.find((u) => u.file === 'lib/work.ts' && u.lines[0] === 4)!;
	assert.ok(slow, 'the slow hunk is lib/work.ts line 4');
	assert.deepEqual(c.revert.units, [slow.id]);
	assert.deepEqual(c.apply.units, [slow.id]);
	assert.equal(c.interacts, false);
	assert.ok(c.shares[0].revert! > 0.9, `share ${c.shares[0].revert}`);
	assert.ok(c.functions[0].function === 'total', JSON.stringify(c.functions[0]));
	assert.ok(c.functions[0].lines.some((l) => l.line === 4 && l.unit === slow.id));
	assert.match(md, /comes from this change in `lib\/work\.ts` L4/);
	assert.match(md, /\+\tfor \(const x of xs\) s \+= x \* 0;/);
	assert.ok(result.spent.recounts <= 16, `${result.spent.recounts} recounts`);
	console.log(md);
	console.log(
		`recounts ${result.spent.recounts}, reused ${result.spent.reused}, ${result.spent.ms} ms`
	);
});

test('with real-traffic weights the blamed hunk gets the cost function’s estimate and range', () => {
	const scratch = temp_dir('heisenbench-blame-weights-');
	// a unit of real traffic: 200 requests over 10 s; `total` runs 3 times a request (counted)
	const weights: AppWeights = {
		schema: WEIGHTS_SCHEMA,
		source: { sha: null, ogygia: {}, scenarios: [] },
		units: {
			'real request': {
				steps: 0,
				units: 200,
				side: 'server',
				traffic: {
					profiles: { cpuprofile: 1 },
					requests: 200,
					window_ms: 10_000,
					start: null,
					end: null,
					sampled_ms: 100,
					mapped_ms: 100,
					unmatched: []
				}
			}
		},
		functions: {
			[canonical_function('lib/work.ts', 'total')]: {
				'real request': {
					calls: 3,
					calls_counted: true,
					self_steps: 0,
					inclusive_steps: 0,
					self_ns: 900,
					total_ns: 900,
					samples: 400
				}
			}
		}
	};
	const file = join(scratch, 'real-weights.json');
	writeFileSync(file, JSON.stringify(weights));
	const { result, md } = blame_fixture(
		{ 'work.bench.ts': BENCH, 'lib/work.ts': WORK_BASE, 'lib/fmt.ts': FMT_BASE },
		{ 'lib/work.ts': WORK_HEAD, 'lib/fmt.ts': FMT_HEAD },
		['--weights', file, '--requests-per-day', '1000000']
	);
	const c = result.cases[0];
	const slow = result.units.find((u) => u.file === 'lib/work.ts' && u.lines[0] === 4)!;
	assert.deepEqual(c.revert.units, [slow.id]);
	const k = c.cost!;
	assert.ok(k.total, 'priced');
	// the same estimate the ranked findings give that function: the cost function, not a second model
	const total_fn = c.functions.find((f) => f.function === 'total')!;
	assert.deepEqual(k.total, total_fn.cost);
	assert.deepEqual(k.hunks, [{ unit: slow.id, cost: total_fn.cost }]);
	assert.equal(k.total!.requests_per_day, 1_000_000);
	assert.ok(k.total!.cpu_s_range[0] < k.total!.cpu_s_per_day);
	assert.ok(k.total!.cpu_s_per_day < k.total!.cpu_s_range[1]);
	// two functions' costs add, estimates and range ends alike
	const twice = sum_costs([k.total!, k.total!])!;
	assert.equal(twice.ns, round_sig(2 * k.total!.ns));
	assert.deepEqual(twice.range, [
		round_sig(2 * k.total!.range[0]),
		round_sig(2 * k.total!.range[1])
	]);
	assert.equal(sum_costs([]), null);
	assert.match(
		md,
		/\*\*Real cost\*\* of this change on the imported traffic: ≈ .+ at 1M requests\/day \(range /
	);
	assert.match(md, /\| Function \| Δ self steps \| Lines \| Real cost \|/);
	assert.match(md, /3 calls\/request/);
	console.log(
		md
			.split('\n')
			.filter((l) => l.includes('Real cost') || l.includes('total'))
			.join('\n')
	);
});

test('two hunks that only cost together are both named, and said to interact', () => {
	const bench = `import { bench } from ${BENCH_API};
import { run } from './lib/work.ts';

const data = Array.from({ length: 200 }, (_, i) => i);
bench('runs in a mode', () => run(data));
`;
	const work = (branch: string, note: string) => `import { mode } from './mode.ts';

export function run(xs: number[]): number {
	let s = 0;
	for (const x of xs) s += x;
${branch}	return s;
}
${GAP}
export const NOTE = '${note}';
`;
	const { result, md } = blame_fixture(
		{
			'work.bench.ts': bench,
			'lib/mode.ts': `export const mode: string = 'fast';\n`,
			'lib/work.ts': work('', 'a')
		},
		{
			'lib/mode.ts': `export const mode: string = 'slow';\n`,
			'lib/work.ts': work(`	if (mode === 'slow') for (const x of xs) s += x * 2;\n`, 'b')
		}
	);
	assert.equal(result.units.length, 3);
	const c = result.cases[0];
	assert.equal(c.status, 'found', c.note ?? '');
	const flag = result.units.find((u) => u.file === 'lib/mode.ts')!;
	const branch = result.units.find((u) => u.file === 'lib/work.ts' && u.lines[0] === 6)!;
	assert.deepEqual(c.apply.units, [flag.id, branch.id].sort());
	assert.equal(c.revert.units.length, 1, 'undoing either one removes it');
	assert.ok([flag.id, branch.id].includes(c.revert.units[0]));
	assert.equal(c.interacts, true);
	for (const s of c.shares) assert.ok((s.apply ?? 1) < 0.1, `alone: ${JSON.stringify(s)}`);
	assert.match(md, /only cost together/);
	assert.match(md, /They interact/);
	assert.match(md, /`lib\/mode\.ts` L1/);
	assert.match(md, /`lib\/work\.ts` L6/);
	console.log(md);
});

test('ddmin: one cause, two causes together, and an unresolved middle', async () => {
	const items = [0, 1, 2, 3, 4, 5, 6, 7];
	const run = async (judge: (s: number[]) => Outcome, budget = Infinity) => {
		let tests = 0;
		const r = await ddmin(items, {
			async first_failing(cands) {
				for (let i = 0; i < cands.length; i++) {
					if (tests++ >= budget) return null;
					if (judge(cands[i]) === 'fail') return i;
				}
				return -1;
			}
		});
		return { ...r, tests };
	};
	assert.deepEqual((await run((s) => (s.includes(5) ? 'fail' : 'pass'))).set, [5]);
	assert.deepEqual(
		(await run((s) => (s.includes(1) && s.includes(6) ? 'fail' : 'pass'))).set,
		[1, 6]
	);
	// 3 cannot be judged without 2 (it does not compile alone): 2 and 3 stay together
	const needs = await run((s) =>
		s.includes(3) && !s.includes(2) ? 'unresolved' : s.includes(3) ? 'fail' : 'pass'
	);
	assert.deepEqual(needs.set, [2, 3]);
	const cut = await run((s) => (s.includes(5) ? 'fail' : 'pass'), 2);
	assert.equal(cut.complete, false);
	assert.ok(cut.set.includes(5) && cut.set.length < items.length, `narrowed: ${cut.set}`);
	assert.deepEqual(split([1, 2, 3, 4, 5], 2), [
		[1, 2],
		[3, 4, 5]
	]);
});

test('hunks: any set of them makes a tree, and the diff between two trees is git’s', () => {
	const dir = temp_dir('heisenbench-hunks-');
	git(dir, 'init', '-q');
	const base_lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
	const head_lines = [...base_lines];
	head_lines[0] = 'first';
	head_lines.splice(21, 0, 'added');
	head_lines.splice(31, 1);
	const base = commit(
		dir,
		{
			'a.ts': base_lines.join('\n') + '\n',
			'gone.ts': 'export const x = 1;\n',
			'same.bin': 'b\0in',
			'old.ts': 'export const y = 2;\n'
		},
		'base'
	);
	git(dir, 'mv', 'old.ts', 'moved.ts');
	commit(
		dir,
		{
			// the last line loses its newline: a hunk of its own
			'a.ts': head_lines.join('\n'),
			'new.ts': 'export const z = 3;\n',
			'same.bin': 'b\0out'
		},
		'head'
	);
	git(dir, 'rm', '-q', 'gone.ts');
	const head2 = commit(dir, {}, 'head2');
	const u = diff_units(dir, base, head2);
	const kinds = u.units.map((x) => `${x.file}:${x.kind}`);
	assert.ok(kinds.includes('gone.ts:delete') && kinds.includes('new.ts:add'), kinds.join(' '));
	assert.ok(
		kinds.includes('moved.ts:rename') && kinds.includes('same.bin:binary'),
		kinds.join(' ')
	);
	const edits = u.units.filter((x) => x.kind === 'edit');
	assert.equal(edits.length, 4, edits.map((e) => e.new_lines.join('-')).join(' '));
	const at = (rev: string, p: string) => {
		try {
			return execFileSync('git', ['cat-file', 'blob', `${rev}:${p}`], {
				cwd: dir,
				stdio: ['ignore', 'pipe', 'ignore']
			});
		} catch {
			return null;
		}
	};
	const all = new Set(u.units.map((x) => x.id));
	for (const [p, b] of u.tree(all)) assert.deepEqual(b, at(head2, p), `head ${p}`);
	for (const [p, b] of u.tree(new Set())) assert.deepEqual(b, at(base, p), `base ${p}`);
	assert.notEqual(u.hash(all), u.hash(new Set()));
	// a tree from one hunk of a.ts against one from another: git sees what file_diffs says
	const one = new Set([edits[0].id]);
	const other = new Set([edits[1].id, edits[2].id]);
	const ta = u.tree(one).get('a.ts')!;
	const tb = u.tree(other).get('a.ts')!;
	const scratch = temp_dir('heisenbench-hunks-diff-');
	writeFileSync(join(scratch, 'x'), ta);
	writeFileSync(join(scratch, 'y'), tb);
	const r = spawnSync('git', ['diff', '--no-index', '-U0', 'x', 'y'], {
		cwd: scratch,
		encoding: 'utf8'
	});
	const want = parse_diff(r.stdout)[0].hunks;
	const got = u.file_diffs(one, other).find((f) => f.new_path === 'a.ts')!.hunks;
	assert.deepEqual(got, want);
	assert.match(u.text(edits[0]), /^@@ -1,4 \+1,4 @@\n-line 0\n\+first\n line 1/);
});

test('scratch trees: links into the tree stay inside the copy; dependencies link to the original', () => {
	const root = temp_dir('heisenbench-mirror-');
	write_files(root, {
		'packages/a/src/x.ts': 'export const x = 1;\n',
		'packages/b/src/y.ts': 'export const y = 1;\n',
		'node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js': 'export default 1;\n'
	});
	mkdirSync(join(root, 'packages/b/node_modules/@scope'), { recursive: true });
	symlinkSync('../../../a', join(root, 'packages/b/node_modules/@scope/a'));
	symlinkSync(
		'../../../node_modules/.pnpm/dep@1.0.0/node_modules/dep',
		join(root, 'packages/b/node_modules/dep')
	);
	const dst = join(temp_dir('heisenbench-mirror-dst-'), 'copy');
	mirror_tree(root, dst);
	assert.equal(readlinkSync(join(dst, 'packages/b/node_modules/@scope/a')), '../../../a');
	assert.ok(lstatSync(join(dst, 'node_modules/.pnpm')).isSymbolicLink());
	assert.equal(
		readFileSync(join(dst, 'packages/b/node_modules/dep/index.js'), 'utf8'),
		'export default 1;\n'
	);
	write_tree(
		dst,
		new Map([
			['packages/a/src/x.ts', Buffer.from('changed')],
			['packages/b/src/y.ts', null]
		])
	);
	assert.equal(readFileSync(join(root, 'packages/a/src/x.ts'), 'utf8'), 'export const x = 1;\n');
	assert.equal(
		readFileSync(join(dst, 'packages/b/node_modules/@scope/a/src/x.ts'), 'utf8'),
		'changed'
	);
	assert.equal(existsSync(join(dst, 'packages/b/src/y.ts')), false);
	remove_tree(dst);
	assert.ok(existsSync(join(root, 'node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js')));
	assert.deepEqual(
		move_args(
			['--import=/r/pre.ts', '--import', '/r/x/p.ts', '--max-old-space-size=9', '-r', 'pkg'],
			'/r',
			'/l'
		),
		['--import=/l/pre.ts', '--import', '/l/x/p.ts', '--max-old-space-size=9', '-r', 'pkg']
	);
});
