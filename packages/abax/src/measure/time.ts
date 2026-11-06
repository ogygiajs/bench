import { Bench } from 'tinybench';
import { judge } from '@bench/compare';
import type { Rule, Verdict } from '@bench/compare';
import type { BenchCase } from '../bench.ts';
import { is_async_case } from './cases.ts';
import { pair_cases } from '../cases.ts';

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
	/** null: the calls used too little CPU for process.cpuUsage to read (CPU_RESOLUTION_US). */
	cpu_ns: number | null;
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

/** Wall time one CPU batch aims for: long against the clock's tick, short against the budget. */
const CPU_BATCH_MS = 10;
/** Contexts set up ahead of one batch, at most (they all live at once). */
const CPU_BATCH_CONTEXTS = 4096;
/** Calls per batch, at most (a case with no setup shares one undefined context). */
const CPU_BATCH_CALLS = 1_000_000;
/** Below this much CPU over all batches the reading is the clock's tick, not the code: no value. */
export const CPU_RESOLUTION_US = 20_000;

/**
 * CPU per call (ns), or null when the calls together used too little CPU to read (a cheap call
 * whose setup takes all the time). The calls run in batches whose setups ran before the batch's
 * CPU reading started, so nothing is subtracted: `process.cpuUsage` sees only the calls.
 */
async function cpu_per_call(
	c: BenchCase,
	async: boolean,
	mean_ns: number,
	budget_ms: number
): Promise<number | null> {
	const want = Math.ceil((CPU_BATCH_MS * 1e6) / Math.max(mean_ns, 1));
	const per_batch = Math.max(1, Math.min(c.setup ? CPU_BATCH_CONTEXTS : CPU_BATCH_CALLS, want));
	const end = performance.now() + budget_ms;
	let cpu = 0;
	let calls = 0;
	const ctxs: unknown[] = [];
	while (calls === 0 || performance.now() < end) {
		ctxs.length = 0;
		if (c.setup) for (let i = 0; i < per_batch; i++) ctxs.push(await c.setup());
		const t0 = cpu_us();
		if (async) {
			for (let i = 0; i < per_batch; i++) await c.fn(c.setup ? ctxs[i] : undefined);
		} else {
			for (let i = 0; i < per_batch; i++) c.fn(c.setup ? ctxs[i] : undefined);
		}
		cpu += cpu_us() - t0;
		calls += per_batch;
		if (c.teardown) for (let i = 0; i < per_batch; i++) await c.teardown(ctxs[i]);
	}
	ctxs.length = 0;
	return cpu < CPU_RESOLUTION_US ? null : (cpu * 1e3) / calls;
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
	await task.run();
	const r = task.result;
	if (r.state === 'errored') throw r.error;
	if (r.state !== 'completed') throw new Error(`abax: timing ${c.name} ended ${r.state}`);
	const runs = Math.max(1, task.runs);
	const mean_ns = r.latency.mean * 1e6;
	return {
		p50_ns: r.latency.p50 * 1e6,
		p99_ns: r.latency.p99 * 1e6,
		mean_ns,
		throughput: r.throughput.mean,
		cpu_ns: await cpu_per_call(c, async, mean_ns, (o.time_ms ?? 300) / 3),
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
		if ([...b, ...p].some((x) => x === null)) {
			// CPU below what the clock can read on some turn: shown as such, never judged.
			out[m] = { pr: 0, base: 0, diff: 0, regressed: false, improved: false, unjudged: true };
			continue;
		}
		const bn = b as number[];
		const pn = p as number[];
		out[m] = judge(TIME_RULES[m], pn[0] ?? 0, bn[0] ?? 0, pn, bn);
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
	const paired = pair_cases(base, pr);
	const out: TimeComparison = {
		schema: 'abax-time/1',
		repeats,
		node: process.version,
		cases: [],
		missing: {
			base: paired.only_pr.map((c) => c.name),
			pr: paired.only_base.map((c) => c.name)
		},
		errors: []
	};
	for (const [b, p] of paired.pairs) {
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

function median_of(xs: TimeStats[], m: 'p50_ns' | 'p99_ns' | 'throughput'): number {
	const s = xs.map((x) => x[m]).sort((a, b) => a - b);
	const h = s.length >> 1;
	return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

export function fmt_ns(ns: number): string {
	if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
	if (ns >= 1e3) return `${(ns / 1e3).toFixed(2)} µs`;
	return `${ns.toFixed(0)} ns`;
}
