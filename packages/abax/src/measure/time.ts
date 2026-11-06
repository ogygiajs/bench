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
 * PR vs base: both builds are loaded in ONE process and take turns, case by case; the order flips
 * on every repeat (base first, then PR first, ...) so warm-up, GC debt and thermal drift land on
 * both sides alike. Each repeat gives one sample per metric and side; the samples are judged by
 * the no-overlap noise rule of @bench/compare (`judge`), the same rule the app benchmark uses.
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

/** CPU (µs) of the case's setup + teardown alone, `runs` times. */
async function setup_cpu_us(c: BenchCase, runs: number): Promise<number> {
	if (!c.setup && !c.teardown) return 0;
	const t0 = cpu_us();
	for (let i = 0; i < runs; i++) {
		const ctx = c.setup ? await c.setup() : undefined;
		if (c.teardown) await c.teardown(ctx);
	}
	return cpu_us() - t0;
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
	if (async) {
		bench.add(
			c.name,
			async () => {
				await c.fn(ctx);
			},
			hooks
		);
	} else {
		bench.add(
			c.name,
			() => {
				c.fn(ctx);
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

/**
 * PR vs base, in this process: per case, `repeats` rounds; each round times both sides, the side
 * that goes first alternating. Cases are matched by name.
 */
export async function compare_time(
	base: BenchCase[],
	pr: BenchCase[],
	o: TimeOptions & { repeats?: number; log?: (line: string) => void } = {}
): Promise<TimeComparison> {
	const repeats = o.repeats ?? 5;
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
	for (const b of base) {
		const p = by_name.get(b.name);
		if (!p) continue;
		const tc: TimeCase = {
			name: b.name,
			order: [],
			base: [],
			pr: [],
			verdicts: {} as TimeCase['verdicts']
		};
		let failed = false;
		for (let r = 0; r < repeats && !failed; r++) {
			const first: 'base' | 'pr' = r % 2 === 0 ? 'base' : 'pr';
			tc.order.push(first);
			for (const side of first === 'base' ? (['base', 'pr'] as const) : (['pr', 'base'] as const)) {
				try {
					tc[side].push(await time_case(side === 'base' ? b : p, o));
				} catch (e) {
					out.errors.push({
						name: b.name,
						side,
						error: e instanceof Error ? e.message : String(e)
					});
					failed = true;
					break;
				}
			}
		}
		if (failed) continue;
		tc.verdicts = judge_time(tc.base, tc.pr);
		o.log?.(
			`time    ${b.name}  p50 ${fmt_ns(median_of(tc.base, 'p50_ns'))} -> ${fmt_ns(median_of(tc.pr, 'p50_ns'))}`
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
