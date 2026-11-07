import type { BenchCase } from '../bench.ts';
import { scale_input } from '../growth/scale.ts';
import { time_case } from '../measure/time.ts';
import type { TimeOptions } from '../measure/time.ts';

/*
 * The audit's timing side, in a measure child on the plain build: every case at every growth size,
 * its input made the same way the growth layer makes it (the case's own `scale`, else the generic
 * scaler), so the time at each size goes with the steps the growth layer counted at that size.
 */

export interface SizeTimes {
	sizes: number[];
	/** Mean ns per call at each size. */
	mean_ns: number[];
	/**
	 * Median ns of one call at each size: what the audit fits. On a machine busy with other work
	 * the process waits for a core for whole scheduler slices, which the mean of a slice of calls
	 * takes in (1x read 3x slow in one slice and not in the next, on 16 cores running 48 other
	 * processes), while one call rarely spans such a wait, so the median call does not see it. It
	 * leaves out GC pauses rarer than every other call, at every size alike.
	 */
	p50_ns: number[];
}

export interface AuditTimeOptions extends TimeOptions {
	sizes: number[];
}

/** `c` with its input made `k` times bigger in setup (outside the timing). */
export function scaled_case(c: BenchCase, k: number): BenchCase {
	const own = c.scale;
	return {
		...c,
		setup: async () => {
			const ctx = c.setup ? await c.setup() : undefined;
			return own ? own(ctx, k) : scale_input(ctx, k);
		}
	};
}

/**
 * Passes over the sizes in one round. A round's time budget per size is split into this many
 * slices, timed in turns (1x, 10x, 100x, 1x, 10x, ...), and each size keeps the median slice: a
 * burst of other work on a shared machine lands in one slice of one size and is dropped, instead
 * of bending that size's time and with it the round's verdict.
 */
export const PASSES = 3;

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const h = s.length >> 1;
	return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

export async function time_sizes(c: BenchCase, o: AuditTimeOptions): Promise<SizeTimes> {
	const means: number[][] = o.sizes.map(() => []);
	const p50s: number[][] = o.sizes.map(() => []);
	const slice = Math.max(1, Math.round((o.time_ms ?? 300) / PASSES));
	for (let pass = 0; pass < PASSES; pass++) {
		// The first pass warms each size up; later passes find the code compiled.
		const warmup_ms = pass === 0 ? o.warmup_ms : Math.min(o.warmup_ms ?? 100, 10);
		for (let i = 0; i < o.sizes.length; i++) {
			const t = await time_case(scaled_case(c, o.sizes[i]), { ...o, time_ms: slice, warmup_ms });
			means[i].push(t.mean_ns);
			p50s[i].push(t.p50_ns);
		}
	}
	return { sizes: o.sizes, mean_ns: means.map(median), p50_ns: p50s.map(median) };
}
