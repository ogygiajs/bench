import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { MutationReport } from '../src/mutation/index.ts';
import { stratified_sample } from '../src/mutation/index.ts';
import { make_mutant, plan_module, rewrite } from '../src/mutation/operators.ts';
import { fingerprint, twin_difference } from '../src/mutation/twin.ts';
import type { TwinSummary } from '../src/mutation/twin.ts';
import { temp_dir, write_files } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const BENCH_API = JSON.stringify(
	pathToFileURL(fileURLToPath(new URL('../src/bench.ts', import.meta.url))).href
);

/*
 * The planted module: one function a case grows (`sum_all`), one only called with three words
 * (`tag_all`), one a generator feeds (`count_iter`: walking its input twice consumes it, so the
 * quadratic mutant changes what it returns), a memo the case hits twice (`label`), and one no case
 * calls (`never`).
 */
const WORK = `const seen = new Map<string, number>();

export function sum_all(xs: number[]): number {
	let s = 0;
	for (const x of xs) s += x;
	return s;
}

export function tag_all(words: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < words.length; i++) out.push('#' + words[i]);
	return out;
}

export function count_iter(it: Iterable<number>): number {
	let n = 0;
	for (const _ of it) n++;
	return n;
}

export function label(k: string): number {
	if (seen.has(k)) return seen.get(k)!;
	let v = 0;
	for (let i = 0; i < 40; i++) v += k.length * i;
	seen.set(k, v);
	return v;
}

export function never(xs: number[]): number {
	let m = 0;
	for (const x of xs) if (x > m) m = x;
	return m;
}
`;

const BENCH = `import { bench } from ${BENCH_API};
import { sum_all, tag_all, count_iter, label } from './lib/work.ts';

const list = (n: number) => Array.from({ length: n }, (_, i) => i);
bench('sum_all: a list that grows', ({ xs }) => sum_all(xs), {
	setup: () => ({ xs: list(40) }),
	scale: (_ctx, k) => ({ xs: list(40 * k) })
});
bench('tag_all: three words', () => tag_all(['a', 'b', 'c']));
bench('count_iter: a generator', () =>
	count_iter(
		(function* () {
			for (let i = 0; i < 20; i++) yield i;
		})()
	)
);
bench('label: the same key twice', () => label('x') + label('x'));
`;

function fixture(): string {
	const dir = temp_dir('heisenbench-mutate-');
	write_files(dir, {
		'package.json': JSON.stringify({ name: 'planted', type: 'module' }),
		'lib/work.ts': WORK,
		'work.bench.ts': BENCH,
		'sources.txt': 'lib/work.ts\n'
	});
	return dir;
}

function mutate(
	dir: string,
	tag: string,
	extra: string[] = []
): { report: MutationReport; md: string } {
	const out = join(dir, '..', `${tag}.mutation.json`);
	const md = join(dir, '..', `${tag}.mutation.md`);
	const r = spawnSync(
		process.execPath,
		[
			CLI,
			'mutate',
			'work.bench.ts',
			'--root',
			dir,
			'--list',
			join(dir, 'sources.txt'),
			'--sample',
			'all',
			'--jobs',
			'2',
			'--out',
			out,
			'--md',
			md,
			...extra
		],
		{ cwd: dir, encoding: 'utf8', timeout: 300_000 }
	);
	assert.equal(r.status, 0, `heisenbench mutate exited ${r.status}\n${r.stdout}\n${r.stderr}`);
	return {
		report: JSON.parse(readFileSync(out, 'utf8')) as MutationReport,
		md: readFileSync(md, 'utf8')
	};
}

function statuses(r: MutationReport, path: string): Record<string, string> {
	const f = r.functions.find((x) => x.path === path);
	assert.ok(f, `no ${path} in the report`);
	return Object.fromEntries(f.mutants.map((m) => [m.operator, m.status]));
}

test('planted: a grown function catches its 2x and quadratic mutants, a constant input misses the quadratic one, an unreached function misses all', () => {
	const dir = fixture();
	const { report, md } = mutate(dir, 'a');
	assert.equal(
		readFileSync(join(dir, 'lib/work.ts'), 'utf8'),
		WORK,
		'the root is never written to'
	);

	assert.deepEqual(statuses(report, 'sum_all'), {
		double: 'caught',
		quadratic: 'caught',
		alloc: 'caught'
	});
	const sum = report.functions.find((f) => f.path === 'sum_all')!;
	const q = sum.mutants.find((m) => m.operator === 'quadratic')!;
	assert.equal(q.by, 'growth');
	assert.deepEqual(q.growth, [
		{ case: 'sum_all: a list that grows', base: 'linear', mutant: 'quadratic' }
	]);

	assert.deepEqual(statuses(report, 'tag_all'), {
		double: 'caught',
		quadratic: 'missed',
		alloc: 'caught'
	});
	const tq = report.functions
		.find((f) => f.path === 'tag_all')!
		.mutants.find((m) => m.operator === 'quadratic')!;
	assert.equal(tq.noticed_steps, true, 'the step table sees the extra pass at the one size');
	assert.match(tq.note ?? '', /declares `scale`/);

	assert.deepEqual(statuses(report, 'never'), {
		double: 'unreached',
		quadratic: 'unreached',
		alloc: 'unreached'
	});

	// walking a generator twice consumes it: the twin sees a different count, the mutant is not a slowdown
	assert.deepEqual(statuses(report, 'count_iter'), {
		double: 'caught',
		quadratic: 'discarded',
		alloc: 'caught'
	});
	const cq = report.functions
		.find((f) => f.path === 'count_iter')!
		.mutants.find((m) => m.operator === 'quadratic')!;
	assert.match(cq.note ?? '', /changed behavior/);

	// the memo is hit by the second call: defeating it costs steps the table shows
	assert.equal(statuses(report, 'label').cache, 'caught');

	// scores: 2x 4 of 5 (never), quadratic 1 of 3 (sum_all; tag_all and never missed; count_iter discarded)
	assert.equal(report.totals.double.score, 4 / 5);
	assert.equal(report.totals.quadratic.score, 1 / 3);
	assert.equal(report.totals.quadratic.discarded, 1);
	assert.equal(report.totals.quadratic.run_score, 1 / 2);
	assert.match(md, /Benchmarks catch 80% of 2x slowdowns, 33% of linear-to-quadratic slowdowns/);

	// missed, ranked by steps: tag_all (run, quadratic) before never (not run), each with a case
	assert.deepEqual(
		report.missed.map((m) => [m.id, m.operators]),
		[
			['lib/work.ts > tag_all', ['quadratic']],
			['lib/work.ts > never', ['double', 'quadratic', 'alloc']]
		]
	);
	assert.match(report.missed[0].suggestion ?? '', /scale: \(ctx, k\)/);
	assert.match(report.missed[1].suggestion ?? '', /bench\('never: /);
	assert.match(report.missed[1].suggestion ?? '', /import \{ never \} from '\.\/lib\/work\.ts';/);
});

test('the same seed gives the same report; a second run reuses every count from --work', () => {
	const dir = fixture();
	const work = join(dir, '..', 'mutate-work');
	const strip = (r: MutationReport) => JSON.stringify({ ...r, cost: null });
	const a = mutate(dir, 'a', ['--seed', '3', '--sample', '2']);
	const b = mutate(dir, 'b', ['--seed', '3', '--sample', '2', '--work', work]);
	assert.equal(strip(a.report), strip(b.report));
	assert.equal(a.report.sample.evaluated, 2);
	const c = mutate(dir, 'c', ['--seed', '3', '--sample', '2', '--work', work]);
	assert.equal(strip(c.report), strip(a.report));
	assert.equal(c.report.cost.recounts, 0);
	assert.ok(c.report.cost.cached > 0);
});

test('operators: every rewrite keeps the line count, and the hook wraps each return', () => {
	const fns = [
		{ id: 'm.ts > sum_all', path: 'sum_all', line: 3, col: 7, end_line: 7 },
		{ id: 'm.ts > label', path: 'label', line: 21, col: 7, end_line: 27 }
	];
	const plan = plan_module('m.ts', 'm.ts', WORK, fns);
	assert.deepEqual(plan.unmatched, []);
	const [sum, label] = plan.functions;
	assert.deepEqual(sum.applies, ['double', 'quadratic', 'alloc']);
	// its loop counts to 40: no collection to walk again
	assert.deepEqual(label.applies, ['double', 'alloc', 'cache']);
	for (const f of plan.functions) {
		for (const op of f.applies) {
			const out = rewrite(
				plan,
				f,
				make_mutant(f, op, () => 0),
				true
			);
			assert.equal(out.split('\n').length, WORK.split('\n').length);
		}
	}
	const q = rewrite(
		plan,
		sum,
		make_mutant(sum, 'quadratic', () => 0),
		false
	).split('\n')[4];
	assert.match(q, /for \(const x of xs\) \{for\(const \$hbm\$q of xs\)\{\}s \+= x;\}/);
	const hooked = rewrite(plan, label, null, true).split('\n')[21];
	assert.match(hooked, /return \$hbm\$tw\("m\.ts > label",\(seen\.get\(k\)!\)\)/);
	const cache = rewrite(
		plan,
		label,
		make_mutant(label, 'cache', () => 0),
		false
	).split('\n')[21];
	assert.match(cache, /if \(false\) return/);
});

test('twin: fingerprints are the same for equal values, differ for different ones, and ignore the run root', () => {
	const a = { b: [1, 2, { c: 'x' }], m: new Map([[1, 'a']]), s: new Set([1]) };
	assert.equal(fingerprint(a), fingerprint(structuredClone(a)));
	assert.notEqual(fingerprint(a), fingerprint({ ...a, b: [1, 2, { c: 'y' }] }));
	assert.equal(
		fingerprint('/tmp/lane-1/x.ts', ['/tmp/lane-1']),
		fingerprint('/tmp/lane-2/x.ts', ['/tmp/lane-2'])
	);
	const cyc: Record<string, unknown> = {};
	cyc.self = cyc;
	assert.equal(typeof fingerprint(cyc), 'string');
	const one = (print: string): TwinSummary => ({
		calls: 1,
		hash: print,
		head: [{ id: 'f', how: 'r', print }]
	});
	assert.equal(twin_difference(one('a'), one('a')), null);
	assert.match(twin_difference(one('a'), one('b')) ?? '', /call 1 returned a different value/);
});

test('sampling: stratified by key, at least one per stratum, the same for the same seed', () => {
	const items = [
		...Array.from({ length: 90 }, (_, i) => `a${i}`),
		...Array.from({ length: 10 }, (_, i) => `b${i}`)
	];
	const s1 = stratified_sample(items, (x) => x[0], 10, 7);
	const s2 = stratified_sample(items, (x) => x[0], 10, 7);
	assert.deepEqual([...s1], [...s2]);
	assert.equal(s1.size, 10);
	assert.equal([...s1].filter((x) => x.startsWith('a')).length, 9);
	assert.equal([...s1].filter((x) => x.startsWith('b')).length, 1);
	assert.notDeepEqual([...stratified_sample(items, (x) => x[0], 10, 8)], [...s1]);
});
