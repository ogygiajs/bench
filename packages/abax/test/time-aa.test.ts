import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run_child } from '../src/measure/spawn.ts';
import { TIME_METRICS, judge_time } from '../src/measure/time.ts';
import type { TimeComparison, TimeStats } from '../src/measure/time.ts';
import { temp_dir, write_files } from './helpers.ts';

/*
 * A/A: identical code on both sides is never judged changed. Found on a CI runner: cases 3-8%
 * apart with every sample of one side below every sample of the other, on code the PR did not
 * touch. One copy of a build keeps its compiled code (and its luck) for every round, so the gap
 * between two copies was steady and the no-overlap rule took it for a change.
 */

/** sfc32-ish: a seeded stream in [0, 1). */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	let b = 0x9e3779b9;
	let c = 0x243f6a88;
	let d = 1;
	return () => {
		const t = (((a + b) >>> 0) + d) >>> 0;
		d = (d + 1) >>> 0;
		a = b ^ (b >>> 9);
		b = (c + (c << 3)) >>> 0;
		c = (c << 21) | (c >>> 11);
		c = (c + t) >>> 0;
		return t / 4294967296;
	};
}

function stats(ns: number): TimeStats {
	return {
		p50_ns: ns,
		p99_ns: ns * 1.5,
		mean_ns: ns,
		throughput: 1e9 / ns,
		cpu_ns: ns,
		samples: 100
	};
}

/**
 * One side's samples: per round, a copy of the code (its own bias, up to ±`bias`) and noise (up
 * to ±`noise`). `fresh`: a new copy each round; otherwise one copy for every round.
 */
function side(
	r: () => number,
	rounds: number,
	o: { shift: number; bias: number; noise: number; fresh: boolean }
): TimeStats[] {
	let copy = (r() * 2 - 1) * o.bias;
	return Array.from({ length: rounds }, () => {
		if (o.fresh) copy = (r() * 2 - 1) * o.bias;
		return stats(1000 * (1 + o.shift + copy + (r() * 2 - 1) * o.noise));
	});
}

/** The rule as compare_time runs it: 5 rounds, and 5 more when a metric looks changed. */
function judged(
	r: () => number,
	o: { shift: number; bias: number; noise: number; fresh: boolean }
): boolean {
	const bo = { ...o, shift: 0 };
	let b = side(r, 5, bo);
	let p = side(r, 5, o);
	const changed = (bs: TimeStats[], ps: TimeStats[]) => {
		const v = judge_time(bs, ps);
		return TIME_METRICS.some((m) => v[m].regressed || v[m].improved);
	};
	if (!changed(b, p)) return false;
	// the confirming rounds: on fresh copies when the run uses them, else the same two copies
	const more = o.fresh ? o : { ...o, bias: 0 };
	b = [...b, ...side(r, 5, { ...more, shift: 0 })];
	p = [...p, ...side(r, 5, more)];
	return changed(b, p);
}

test('A/A: copies of the same code drawn fresh each round, and confirmed, are not judged changed', () => {
	const r = rng(42);
	const trials = 4000;
	// a copy bias of up to 8%, noise of 1%: what the CI runner showed
	const aa = { shift: 0, bias: 0.08, noise: 0.01, fresh: true };
	let false_findings = 0;
	for (let i = 0; i < trials; i++) if (judged(r, aa)) false_findings++;
	assert.ok(
		false_findings <= trials / 1000,
		`${false_findings} of ${trials} A/A cases judged changed`
	);

	// one copy per side for every round (before): the bias is steady and taken for a change
	const r2 = rng(42);
	let steady = 0;
	for (let i = 0; i < 400; i++) {
		const b = side(r2, 5, { shift: 0, bias: 0.08, noise: 0.01, fresh: false });
		const p = side(r2, 5, { shift: 0, bias: 0.08, noise: 0.01, fresh: false });
		const v = judge_time(b, p);
		if (TIME_METRICS.some((m) => v[m].regressed || v[m].improved)) steady++;
	}
	assert.ok(
		steady > 100,
		`with one copy for all rounds, ${steady} of 400 A/A cases were judged changed`
	);

	// and a real change still shows: 30% slower on a fresh-copy bias of 8%
	const r3 = rng(7);
	let found = 0;
	for (let i = 0; i < 400; i++)
		if (judged(r3, { shift: 0.3, bias: 0.08, noise: 0.01, fresh: true })) found++;
	assert.ok(found > 380, `a 30% slowdown found ${found} of 400 times`);
});

const BENCH_API = fileURLToPath(new URL('../src/bench.ts', import.meta.url));

test('A/A on two copies of a tree: no case is judged changed', async () => {
	const base = temp_dir('abax-aa-base-');
	const cases = Array.from(
		{ length: 6 },
		(_, i) =>
			`bench('work ${i}', ({ xs }) => lib.work(xs, ${i}), { setup: () => ({ xs: Array.from({ length: ${200 + i * 100} }, (_, j) => j) }) });`
	);
	write_files(base, {
		'lib.ts': `export function work(xs: number[], k: number): number {
	let s = 0;
	for (const x of xs) s += (x * 31 + k) % 7;
	return s + xs.map((x) => x + k).filter((x) => x % 3 === 0).length;
}
`,
		'lib.bench.ts': [
			`import { bench } from ${JSON.stringify(BENCH_API)};`,
			"import * as lib from './lib.ts';",
			...cases,
			''
		].join('\n')
	});
	const pr = temp_dir('abax-aa-pr-');
	cpSync(base, pr, { recursive: true });
	const t = await run_child<TimeComparison>({
		kind: 'time_ab',
		roots: [base, pr],
		files: [['lib.bench.ts'], ['lib.bench.ts']],
		options: { repeats: 5, time_ms: 40, warmup_ms: 15 }
	});
	assert.equal(t.cases.length, 6);
	const flagged = t.cases.filter((c) =>
		TIME_METRICS.some((m) => c.verdicts[m].regressed || c.verdicts[m].improved)
	);
	assert.deepEqual(
		flagged.map(
			(c) =>
				`${c.name}: ${JSON.stringify(c.base.map((s) => Math.round(s.p50_ns)))} vs ${JSON.stringify(c.pr.map((s) => Math.round(s.p50_ns)))}`
		),
		[]
	);
});
