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
	/** Mean ns per call at each size (the mean, as calibration uses: a fast call's p50 is a tick). */
	mean_ns: number[];
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

export async function time_sizes(c: BenchCase, o: AuditTimeOptions): Promise<SizeTimes> {
	const out: SizeTimes = { sizes: o.sizes, mean_ns: [], p50_ns: [] };
	for (const k of o.sizes) {
		const t = await time_case(scaled_case(c, k), o);
		out.mean_ns.push(t.mean_ns);
		out.p50_ns.push(t.p50_ns);
	}
	return out;
}
