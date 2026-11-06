import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { run_child } from '../src/measure/spawn.ts';
import type { CaseResult } from '../src/measure/child.ts';
import type { TimeComparison, TimeStats } from '../src/measure/time.ts';
import type { BytesResult } from '../src/measure/alloc.ts';
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
	assert.ok(slow.cpu_ns > 0 && slow.samples > 0);
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
	assert.deepEqual(work.order, ['base', 'pr', 'base', 'pr', 'base']);
	assert.equal(work.base.length, 5);
	assert.equal(work.verdicts.p50_ns.regressed, true);
	assert.equal(work.verdicts.throughput.regressed, true);
	assert.ok(work.verdicts.p50_ns.prSamples!.length === 5);
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
`
	});
	const r = await run_child<Array<CaseResult<LeakResult>>>({
		kind: 'leaks',
		roots: [dir],
		files: [['leaky.bench.ts']],
		options: { rounds: 5, calls: 2000 }
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
});
