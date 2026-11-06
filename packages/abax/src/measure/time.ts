import { Bench } from 'tinybench';
import { judge } from '@bench/compare';
import type { Rule, Verdict } from '@bench/compare';
import type { BenchCase } from '../bench.ts';
import { is_async_case } from './cases.ts';

/*
 * The time layer (spec 6). Steps say what the code does; this says how long the engine takes to do
 * it. Every case runs on the plain build (nothing counted) under tinybench:
 *
 *   p50_ns / p99_ns  latency percentiles of one call (setup and teardown run outside the timing,
 *                    in tinybench's beforeEach / afterEach)
 *   throughput       calls per second (tinybench's mean)
 *   cpu_ns           process CPU (user + system, process.cpuUsage) per call over the timed phase,
 *                    minus the CPU of the case's setup/teardown alone over as many calls
 *
 * PR vs base: both builds are loaded in ONE process and take turns; the order flips on every
 * round (base first, then PR first, ...) so warm-up, GC debt and thermal drift land on both sides
 * alike. Each round gives one sample per metric and side; the samples are judged by the no-overlap
 * noise rule of @bench/compare (`judge`), the same rule the app benchmark uses.
 *
 * Two things keep identical code from being judged changed (an A/A run on a CI runner flagged
 * cases 3-8% apart, every sample of one side below every sample of the other):
 *
 * - Each round runs on fresh copies of both builds (`load`). One copy of a build keeps the code V8
 *   compiled for it, and its luck (inlining, code layout, which feedback came first) for every
 *   round: a steady offset between two copies of the same code that no number of repeats averages
 *   out. A fresh copy per round draws it again, so it shows up as spread instead.
 * - A metric that looks changed after the rounds is confirmed: as many rounds again, on fresh
 *   copies, and judged on all of them. With 57 cases and 4 metrics, 228 judgements a run, a 1 in
 *   126 chance per judgement is two false findings a run; confirming makes it 1 in 184756.
 */

export interface TimeStats {
	p50_ns: number;
	p99_ns: number;
	mean_ns: number;
	throughput: number;
	cpu_ns: number;
	samples: number;
}

export interface TimeOptions {
	/** Timed phase per measurement, in ms (default 300). */
	time_ms?: number;
	/** Warm-up phase per measurement, in ms (default 100). */
	warmup_ms?: number;
	/** Minimum timed calls per measurement (default 64). */
	iterations?: number;
}

export const TIME_RULES: Record<'p50_ns' | 'p99_ns' | 'throughput' | 'cpu_ns', Rule> = {
	p50_ns: { better: 'lower', floor: { pct: 3 } },
	p99_ns: { better: 'lower', floor: { pct: 5 } },
	throughput: { better: 'higher', floor: { pct: 3 } },
	cpu_ns: { better: 'lower', floor: { pct: 3 } }
};

export type TimeMetric = keyof typeof TIME_RULES;
export const TIME_METRICS = Object.keys(TIME_RULES) as TimeMetric[];

function cpu_us(): number {
	const u = process.cpuUsage();
	return u.user + u.system;
}

/** CPU (µs) of the case's setup + teardown alone, scaled to `runs` calls from a sample of them. */
async function setup_cpu_us(c: BenchCase, runs: number): Promise<number> {
	if (!c.setup && !c.teardown) return 0;
	const sample = Math.min(runs, 2000);
	const t0 = cpu_us();
	for (let i = 0; i < sample; i++) {
		const ctx = c.setup ? await c.setup() : undefined;
		if (c.teardown) await c.teardown(ctx);
	}
	return ((cpu_us() - t0) * runs) / sample;
}

/** Wall ms of one whole iteration (setup, call, teardown), averaged over a few. */
async function probe_ms(c: BenchCase): Promise<number> {
	const n = 16;
	const t0 = performance.now();
	for (let i = 0; i < n; i++) {
		const ctx = c.setup ? await c.setup() : undefined;
		await c.fn(ctx);
		if (c.teardown) await c.teardown(ctx);
	}
	return Math.max((performance.now() - t0) / n, 1e-6);
}

/** Time one case on the code as it is loaded (the plain build in a measure child). */
export async function time_case(c: BenchCase, o: TimeOptions = {}): Promise<TimeStats> {
	const async = await is_async_case(c);
	const bench = new Bench({
		time: o.time_ms ?? 300,
		warmupTime: o.warmup_ms ?? 100,
		iterations: o.iterations ?? 64,
		warmup: false,
		retainSamples: false,
		throws: true
	});
	let ctx: unknown;
	const hooks = {
		beforeEach: async () => {
			ctx = c.setup ? await c.setup() : undefined;
		},
		afterEach: async () => {
			if (c.teardown) await c.teardown(ctx);
		},
		async
	};
	// tinybench's time budget counts the timed call only; a cheap call with a costly setup would
	// run for ages. Each call then declares what one iteration really costs (setup + call +
	// teardown, from a probe), a constant object so the timed call allocates nothing extra.
	const cost = c.setup || c.teardown ? { overriddenIterationCost: await probe_ms(c) } : undefined;
	if (async) {
		bench.add(
			c.name,
			async () => {
				await c.fn(ctx);
				return cost;
			},
			hooks
		);
	} else {
		bench.add(
			c.name,
			() => {
				c.fn(ctx);
				return cost;
			},
			hooks
		);
	}
	const task = bench.tasks[0];
	await task.warmup();
	const t0 = cpu_us();
	await task.run();
	const cpu = cpu_us() - t0;
	const r = task.result;
	if (r.state === 'errored') throw r.error;
	if (r.state !== 'completed') throw new Error(`abax: timing ${c.name} ended ${r.state}`);
	const runs = Math.max(1, task.runs);
	const own = Math.max(0, cpu - (await setup_cpu_us(c, runs)));
	return {
		p50_ns: r.latency.p50 * 1e6,
		p99_ns: r.latency.p99 * 1e6,
		mean_ns: r.latency.mean * 1e6,
		throughput: r.throughput.mean,
		cpu_ns: (own * 1e3) / runs,
		samples: runs
	};
}

export interface TimeCase {
	name: string;
	/** Which side ran first in each repeat. */
	order: Array<'base' | 'pr'>;
	base: TimeStats[];
	pr: TimeStats[];
	verdicts: Record<TimeMetric, Verdict>;
	/** Rounds run more to confirm a metric that looked changed (the verdicts are over all). */
	confirmed?: number;
}

export interface TimeComparison {
	schema: 'abax-time/1';
	repeats: number;
	node: string;
	cases: TimeCase[];
	/** Cases only one side has. */
	missing: { base: string[]; pr: string[] };
	errors: Array<{ name: string; side: 'base' | 'pr'; error: string }>;
}

export function judge_time(base: TimeStats[], pr: TimeStats[]): Record<TimeMetric, Verdict> {
	const out = {} as Record<TimeMetric, Verdict>;
	for (const m of TIME_METRICS) {
		const b = base.map((s) => s[m]);
		const p = pr.map((s) => s[m]);
		out[m] = judge(TIME_RULES[m], p[0] ?? 0, b[0] ?? 0, p, b);
	}
	return out;
}

export interface CompareOptions extends TimeOptions {
	/** Rounds (default 5). */
	repeats?: number;
	/** Rounds more for a case with a metric that looks changed (default: `repeats`; 0: none). */
	confirm?: number;
	/**
	 * Fresh copies of one side's cases for a round (`round` counts from 0). Without it every round
	 * runs on the lists given.
	 */
	load?: (side: 'base' | 'pr', round: number) => Promise<BenchCase[]>;
	log?: (line: string) => void;
}

function changed(v: Record<TimeMetric, Verdict>): boolean {
	return TIME_METRICS.some((m) => v[m].regressed || v[m].improved);
}

/**
 * PR vs base, in this process: `repeats` rounds over every case (each round on fresh copies of
 * both sides, when `load` is given); in each round both sides are timed, the side that goes first
 * alternating. A case with a metric that looks changed gets `confirm` rounds more. Cases are
 * matched by name.
 */
export async function compare_time(
	base: BenchCase[],
	pr: BenchCase[],
	o: CompareOptions = {}
): Promise<TimeComparison> {
	const repeats = o.repeats ?? 5;
	const confirm = o.confirm ?? repeats;
	const by_name = new Map(pr.map((c) => [c.name, c]));
	const base_names = new Set(base.map((c) => c.name));
	const out: TimeComparison = {
		schema: 'abax-time/1',
		repeats,
		node: process.version,
		cases: [],
		missing: {
			base: pr.filter((c) => !base_names.has(c.name)).map((c) => c.name),
			pr: base.filter((c) => !by_name.has(c.name)).map((c) => c.name)
		},
		errors: []
	};
	const names = base.filter((c) => by_name.has(c.name)).map((c) => c.name);
	const cases = new Map<string, TimeCase>();
	for (const name of names) {
		cases.set(name, { name, order: [], base: [], pr: [], verdicts: {} as TimeCase['verdicts'] });
	}
	const failed = new Set<string>();
	let round = 0;
	const run_round = async (only: readonly string[]): Promise<void> => {
		const r = round++;
		const lists = {
			base: o.load ? await o.load('base', r) : base,
			pr: o.load ? await o.load('pr', r) : pr
		};
		const find = (side: 'base' | 'pr', name: string): BenchCase | undefined =>
			lists[side].find((c) => c.name === name);
		const first: 'base' | 'pr' = r % 2 === 0 ? 'base' : 'pr';
		for (const name of only) {
			if (failed.has(name)) continue;
			const tc = cases.get(name)!;
			tc.order.push(first);
			for (const side of first === 'base' ? (['base', 'pr'] as const) : (['pr', 'base'] as const)) {
				try {
					const c = find(side, name);
					if (!c) throw new Error(`abax: ${name} is gone from a fresh copy of ${side}`);
					tc[side].push(await time_case(c, o));
				} catch (e) {
					out.errors.push({ name, side, error: e instanceof Error ? e.message : String(e) });
					failed.add(name);
					break;
				}
			}
		}
	};
	for (let r = 0; r < repeats; r++) await run_round(names);
	for (const tc of cases.values())
		if (!failed.has(tc.name)) tc.verdicts = judge_time(tc.base, tc.pr);
	const doubt = names.filter((n) => !failed.has(n) && changed(cases.get(n)!.verdicts));
	for (let r = 0; r < confirm && doubt.length > 0; r++) await run_round(doubt);
	for (const name of names) {
		if (failed.has(name)) continue;
		const tc = cases.get(name)!;
		if (doubt.includes(name)) {
			tc.verdicts = judge_time(tc.base, tc.pr);
			tc.confirmed = confirm;
		}
		o.log?.(
			`time    ${name}  p50 ${fmt_ns(median_of(tc.base, 'p50_ns'))} -> ${fmt_ns(median_of(tc.pr, 'p50_ns'))}${tc.confirmed ? ` (confirmed over ${tc.base.length} rounds)` : ''}`
		);
		out.cases.push(tc);
	}
	return out;
}

function median_of(xs: TimeStats[], m: TimeMetric): number {
	const s = xs.map((x) => x[m]).sort((a, b) => a - b);
	const h = s.length >> 1;
	return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

export function fmt_ns(ns: number): string {
	if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
	if (ns >= 1e3) return `${(ns / 1e3).toFixed(2)} µs`;
	return `${ns.toFixed(0)} ns`;
}
