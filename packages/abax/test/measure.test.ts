import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Report } from '../src/report.ts';
import { run_child } from '../src/measure/spawn.ts';
import type { CaseResult } from '../src/measure/child.ts';
import type { TimeComparison, TimeStats } from '../src/measure/time.ts';
import { judge_time } from '../src/measure/time.ts';
import { render_time } from '../src/measure/markdown.ts';
import type { BytesResult } from '../src/measure/alloc.ts';
import { judge_growth } from '../src/measure/leak.ts';
import type { LeakResult } from '../src/measure/leak.ts';
import { temp_dir, write_files } from './helpers.ts';

const BENCH_API = fileURLToPath(new URL('../src/bench.ts', import.meta.url));

const LIB = `export function makes(n: number): number {
	const out: Array<{ a: number }> = [];
	for (let i = 0; i < n; i++) out.push({ a: i });
	return out.length;
}

export function elided(n: number): number {
	let s = 0;
	for (let i = 0; i < n; i++) {
		const p = { x: i, y: i + 1 };
		s += p.x + p.y;
	}
	return s;
}

function spin(n: number): number {
	let s = 0;
	for (let i = 0; i < n; i++) s = (s + i * 7) % 1013;
	return s;
}

export function slow(): number {
	return spin(20000);
}

export function fast(): number {
	return spin(200);
}
`;

function bench_file(body: string): string {
	return `import { bench } from ${JSON.stringify(BENCH_API)};\nimport * as lib from './lib.ts';\n${body}`;
}

test('time layer: tinybench latency, throughput and CPU per call on the plain build', async () => {
	const dir = temp_dir('abax-time-');
	write_files(dir, {
		'lib.ts': LIB,
		'lib.bench.ts': bench_file(
			`bench('slow', () => lib.slow());\nbench('fast', () => lib.fast());\nbench('private', () => lib.__abax.spin(10));\n`
		)
	});
	const r = await run_child<Array<CaseResult<TimeStats>>>({
		kind: 'time',
		roots: [dir],
		files: [['lib.bench.ts']],
		options: { time_ms: 60, warmup_ms: 20 }
	});
	assert.deepEqual(
		r.map((c) => [c.name, c.error]),
		[
			['slow', null],
			['fast', null],
			['private', null]
		]
	);
	const slow = r[0].result!;
	const fast = r[1].result!;
	assert.ok(slow.p50_ns > fast.p50_ns * 5, `slow ${slow.p50_ns} vs fast ${fast.p50_ns}`);
	assert.ok(slow.p99_ns >= slow.p50_ns);
	assert.ok(fast.throughput > slow.throughput);
	assert.ok(slow.cpu_ns !== null && slow.cpu_ns > 0 && slow.samples > 0);
});

test('CPU per call: batched past the clock tick, or no number at all; never 0', async () => {
	const dir = temp_dir('abax-cpu-');
	write_files(dir, {
		'lib.ts': LIB,
		'lib.bench.ts': bench_file(`bench('tiny', () => 1);
bench('tiny with a costly setup', (x) => x.n + 1, {
	setup: () => {
		let n = 0;
		for (let i = 0; i < 20000; i++) n += i;
		return { n };
	}
});
`)
	});
	const r = await run_child<Array<CaseResult<TimeStats>>>({
		kind: 'time',
		roots: [dir],
		files: [['lib.bench.ts']],
		options: { time_ms: 60, warmup_ms: 20 }
	});
	const [tiny, costly] = r.map((c) => c.result!);
	assert.ok(tiny.cpu_ns !== null && tiny.cpu_ns > 0, `tiny: ${tiny.cpu_ns}`);
	assert.ok(costly.cpu_ns === null || costly.cpu_ns > 0, `costly: ${costly.cpu_ns}`);
	const row = (cpu: number | null): TimeStats => ({ ...tiny, cpu_ns: cpu });
	const md = render_time({
		schema: 'abax-time/1',
		repeats: 2,
		node: process.version,
		cases: [
			{
				name: 'tiny with a costly setup',
				order: ['base', 'pr'],
				base: [row(null), row(380)],
				pr: [row(370), row(390)],
				verdicts: judge_time([row(null), row(380)], [row(370), row(390)])
			}
		],
		missing: { base: [], pr: [] },
		errors: []
	});
	assert.ok(md.includes('below resolution'), md);
	assert.ok(!/0–380/.test(md), md);
});

test('time PR vs base: turns alternate, judged by the no-overlap rule', async () => {
	const base = temp_dir('abax-tab-');
	const pr = temp_dir('abax-tpr-');
	const body = `bench('work', () => lib.slow());\nbench('same', () => lib.fast());\n`;
	write_files(base, { 'lib.ts': LIB, 'lib.bench.ts': bench_file(body) });
	// The PR makes `slow` five times slower and leaves `fast` as it is.
	write_files(pr, {
		'lib.ts': LIB.replace('spin(20000)', 'spin(100000)'),
		'lib.bench.ts': bench_file(body)
	});
	const r = await run_child<TimeComparison>({
		kind: 'time_ab',
		roots: [base, pr],
		files: [['lib.bench.ts'], ['lib.bench.ts']],
		options: { time_ms: 60, warmup_ms: 20, repeats: 5 }
	});
	assert.equal(r.errors.length, 0);
	const work = r.cases.find((c) => c.name === 'work')!;
	// five rounds, then five more to confirm what looked changed: the order keeps alternating
	assert.deepEqual(work.order, [
		'base',
		'pr',
		'base',
		'pr',
		'base',
		'pr',
		'base',
		'pr',
		'base',
		'pr'
	]);
	assert.equal(work.confirmed, 5);
	assert.equal(work.base.length, 10);
	assert.equal(work.verdicts.p50_ns.regressed, true);
	assert.equal(work.verdicts.throughput.regressed, true);
	assert.ok(work.verdicts.p50_ns.prSamples!.length === 10);
	// the case that did not change had no reason to be confirmed
	const same = r.cases.find((c) => c.name === 'same')!;
	assert.equal(same.base.length, 5);
});

test('real bytes: sampled V8 allocations per function; escape analysis shows as zero', async () => {
	const dir = temp_dir('abax-bytes-');
	write_files(dir, {
		'lib.ts': LIB,
		'lib.bench.ts': bench_file(
			`bench('makes', () => lib.makes(16));\nbench('elided', () => lib.elided(16));\n`
		)
	});
	const r = await run_child<Array<CaseResult<BytesResult>>>({
		kind: 'bytes',
		roots: [dir],
		files: [['lib.bench.ts']],
		options: { warm: 3000, runs: 2000 }
	});
	const makes = r.find((c) => c.name === 'makes')!.result!;
	const f = makes.functions.find((x) => x.id === 'lib.ts > makes');
	assert.ok(f, JSON.stringify(makes));
	// 16 objects of 16 B and the array with its growing backing store
	assert.ok(f.bytes > 16 * 16, `makes allocates ${f.bytes} B per call`);
	assert.equal(f.line, 1);
	const elided = r.find((c) => c.name === 'elided')!.result!;
	const e = elided.functions.find((x) => x.id === 'lib.ts > elided');
	assert.ok(!e || e.bytes < 16, `elided allocates ${e?.bytes} B per call`);
});

const LEAKY = `const seen: Array<{ at: number }> = [];

export function remember(n: number): number {
	seen.push({ at: n });
	return seen.length;
}

function make_memo() {
	const cache = new Map<number, { v: number }>();
	return (k: number) => {
		let hit = cache.get(k);
		if (!hit) {
			hit = { v: k * 2 };
			cache.set(k, hit);
		}
		return hit.v;
	};
}

const memo = make_memo();
let next = 0;

export function memoized(): number {
	return memo(next++);
}

export function tidy(n: number): number {
	const local: Array<{ at: number }> = [];
	for (let i = 0; i < n; i++) local.push({ at: i });
	return local.length;
}

const bounded = make_memo();

export function bounded_memo(): number {
	return bounded(next++ % 8);
}
`;

test('leaks: growth across rounds, heap snapshot diff, retainer chain to the source line', async () => {
	const dir = temp_dir('abax-leak-');
	write_files(dir, {
		'leaky.ts': LEAKY,
		'leaky.bench.ts': `import { bench } from ${JSON.stringify(BENCH_API)};
import * as m from './leaky.ts';
bench('array push', () => m.remember(1));
bench('closure cache', () => m.memoized());
bench('no leak', () => m.tidy(8));
bench('bounded cache', () => m.bounded_memo());
const kept: Array<{ at: number }> = [];
bench('held by the bench file', () => kept.push({ at: m.tidy(1) }));
`
	});
	const r = await run_child<Array<CaseResult<LeakResult>>>({
		kind: 'leaks',
		roots: [dir],
		files: [['leaky.bench.ts']],
		options: { calls: 1000 }
	});
	const by = (n: string) => {
		const c = r.find((x) => x.name === n)!;
		assert.equal(c.error, null, c.error ?? '');
		return c.result!;
	};
	const push = by('array push');
	assert.equal(push.leaked, true, JSON.stringify(push));
	assert.equal(push.retained!.type, 'Object');
	assert.deepEqual(push.source, {
		module: 'leaky.ts',
		function: 'remember',
		variable: 'seen',
		line: 1
	});
	const cache = by('closure cache');
	assert.equal(cache.leaked, true, JSON.stringify(cache));
	assert.equal(cache.source?.variable, 'cache');
	assert.equal(cache.source?.line, 9);
	assert.equal(cache.source?.function, 'make_memo > <anonymous>');
	assert.ok(cache.chain!.some((s) => s.edge_type === 'context' && s.edge === 'cache'));
	assert.equal(by('no leak').leaked, false);
	assert.equal(by('bounded cache').leaked, false);
	// The heap grows linearly, but no variable of a source module holds the objects.
	const harness = by('held by the bench file');
	assert.equal(harness.grows, true, JSON.stringify(harness));
	assert.equal(harness.leaked, false, JSON.stringify(harness));
	assert.equal(harness.source, null);
});

test('leak growth: above the A/A noise and linear in calls at N, 2N, 4N and 8N', () => {
	const at = (per_call: number[], start = 1e7) => [
		start,
		...per_call.map((p, i) => start + p * 1000 * [1, 2, 4, 8][i])
	];
	// a leak of 40 B a call, a backing store doubling on the way
	assert.equal(judge_growth(at([44, 38, 39, 39]), 1000, 4).grows, true);
	// a Map cache: its table doubles after the first N calls
	assert.equal(judge_growth(at([32, 89, 61, 75]), 1000, 4).grows, true);
	// noise: up 20 KB, then down
	const noisy = judge_growth([1e7, 1e7 + 20_000, 1e7 - 1_000, 1e7 + 18_000, 1e7 + 30_000], 1000, 4);
	assert.equal(noisy.grows, false);
	assert.equal(noisy.threshold, 5.13);
	// a cache that fills once in the first round: 30 KB, then flat
	assert.equal(
		judge_growth([1e7, 1e7 + 30_000, 1e7 + 30_000, 1e7 + 30_000, 1e7 + 30_000], 1000, 4).grows,
		false
	);
	// steady growth below the floor
	assert.equal(judge_growth(at([3, 3, 3, 3]), 1000, 4).grows, false);
	// growth that speeds up (code compiled late), not linear
	assert.equal(judge_growth(at([1, 2, 6, 12]), 1000, 4).grows, false);
});

test('CLI: abax run --measure all, abax time, abax diff --time', async () => {
	const run = promisify(execFile);
	const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
	const base = temp_dir('abax-cli-base-');
	const pr = temp_dir('abax-cli-pr-');
	const body = `bench('work', () => lib.slow());\nbench('alloc', () => lib.makes(8));\n`;
	write_files(base, { 'lib.ts': LIB, 'lib.bench.ts': bench_file(body) });
	write_files(pr, {
		'lib.ts': LIB.replace('spin(20000)', 'spin(100000)'),
		'lib.bench.ts': bench_file(body)
	});
	const node = (args: string[], cwd: string) =>
		run(process.execPath, ['--no-warnings', cli, ...args], { cwd, maxBuffer: 1 << 26 });
	const quick = ['--time-ms', '40'];
	await node(
		['run', 'lib.bench.ts', '--root', base, '--out', 'r.json', '--measure', 'all', ...quick],
		base
	);
	await node(
		['run', 'lib.bench.ts', '--root', pr, '--out', 'r.json', '--measure', 'time', ...quick],
		pr
	);
	const report = JSON.parse(readFileSync(join(base, 'r.json'), 'utf8')) as Report;
	const alloc = report.cases.find((c) => c.name === 'alloc')!;
	assert.ok(alloc.measure?.time && alloc.measure.time.p50_ns > 0);
	assert.ok(
		alloc.measure?.bytes && alloc.measure.bytes.functions.some((f) => f.id === 'lib.ts > makes')
	);
	assert.equal(alloc.measure?.leak?.leaked, false);
	assert.ok(alloc.measure?.estimate && alloc.measure.estimate.ns > 0);
	assert.ok(alloc.measure.estimate.ratio !== null, 'measured time next to the estimate');

	const time_json = join(pr, 'time.json');
	await node(
		[
			'time',
			'lib.bench.ts',
			'--base',
			base,
			'--pr',
			pr,
			'--repeats',
			'5',
			'--out',
			time_json,
			'--md',
			join(pr, 'time.md'),
			...quick
		],
		pr
	);
	const t = JSON.parse(readFileSync(time_json, 'utf8')) as TimeComparison;
	assert.equal(t.cases.find((c) => c.name === 'work')!.verdicts.p50_ns.regressed, true);
	const md = readFileSync(join(pr, 'time.md'), 'utf8');
	assert.ok(md.includes('#### Time') && md.includes('`work`') && md.includes('⚠️'), md);

	const { stdout } = await node(
		['diff', join(base, 'r.json'), join(pr, 'r.json'), '--time', time_json],
		pr
	);
	assert.ok(stdout.includes('### Abax: steps per function'));
	assert.ok(stdout.includes('#### Time'));
	assert.ok(stdout.includes('≈'), 'estimated ns next to the step delta');
});
