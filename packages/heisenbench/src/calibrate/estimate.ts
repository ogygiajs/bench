import { load_prices } from '../prices.ts';
import type { CaseReport, Report } from '../report.ts';
import type { Estimate } from '../measure/types.ts';
import { case_units, family_key, load_weights, units_ns } from './weights.ts';
import type { Weights } from './weights.ts';
import { units_range, usable } from '../ranges/apply.ts';
import { load_ranges } from '../ranges/model.ts';
import type { RangesModel } from '../ranges/model.ts';

/*
 * Estimated ns next to steps: the case's units through the steps -> ns weights (weights.ts).
 * A case is time-led when the steps do not predict its time well: its family fitted below the
 * weights' R^2 threshold in calibration, or, when the time layer ran, the measured time is off the
 * estimate by more than 2x either way.
 *
 * With the range model (ranges.json), `model` is its estimate of the same call with a 10-90%
 * range. It is extra information: time-led and every verdict stay on the weights.
 */

/** Measured over estimated beyond this factor (either way) makes a case time-led. */
export const TIME_LED_RATIO = 2;

export function estimate_case(
	c: CaseReport,
	w: Weights,
	prices = load_prices().prices,
	ranges: RangesModel | null = null
): Estimate {
	const units = case_units(c);
	const ns = units_ns(units, w, prices, true);
	const r2 = w.families[family_key(c.file, c.name)]?.r2 ?? null;
	return {
		ns: Math.round(ns * 10) / 10,
		weights_version: w.version,
		r2,
		ratio: null,
		time_led: r2 !== null && r2 < w.time_led_below,
		...(ranges
			? {
					model: {
						...units_range(ranges, units, prices, {
							allocations: c.totals.allocations,
							bytes: c.totals.bytes,
							calls: c.totals.calls,
							node: process.version
						}),
						version: ranges.version
					}
				}
			: {})
	};
}

/** Put the measured time next to the estimate; a large gap makes the case time-led. */
export function with_measured(e: Estimate, measured_ns: number): Estimate {
	const ratio = e.ns > 0 ? Math.round((measured_ns / e.ns) * 1000) / 1000 : null;
	const off = ratio !== null && (ratio > TIME_LED_RATIO || ratio < 1 / TIME_LED_RATIO);
	return { ...e, ratio, time_led: e.time_led || off };
}

/** Add the estimate to every case that ran (no-op without a weights file). */
export function apply_estimates(
	report: Report,
	w: Weights | null = load_weights(),
	ranges: RangesModel | null = load_ranges()
): void {
	if (!w) return;
	const { prices, hash } = load_prices();
	const m = usable(ranges, hash) ? ranges : null;
	for (const c of report.cases) {
		if (c.error) continue;
		c.measure = { ...c.measure, estimate: estimate_case(c, w, prices, m) };
	}
}
