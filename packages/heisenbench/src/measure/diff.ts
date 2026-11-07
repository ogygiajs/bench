import { load_prices } from '../prices.ts';
import type { CaseReport, Report } from '../report.ts';
import type { DiffResult } from '../diff/index.ts';
import { load_weights, units_ns } from '../calibrate/weights.ts';
import type { LeakResult } from './leak.ts';

/*
 * What the plain-build layers change in a PR vs base diff:
 *
 * - Elided allocations: a finding that adds allocations in a function whose REAL bytes did not
 *   grow with them (the engine elides the new object) is marked `elided`. It stays in the result,
 *   but it is not a memory regression and the comment lists it apart.
 * - Leaks: a case that leaks on the PR and not on the base.
 * - Time-led cases: the steps -> ns estimate does not hold for them; read the time layer.
 * - Estimated ns per changed function, from the weights (next to the step delta).
 */

export interface LeakFinding {
	case: string;
	pr: LeakResult;
	/** The base leaked too (the leak is not new). */
	base_leaked: boolean;
}

export interface MeasureDiff {
	leaks: LeakFinding[];
	time_led: string[];
	/** Estimated ns delta per changed function: `case > function id` -> ns. */
	ns: Record<string, number>;
	weights_version: number | null;
}

/** Real bytes grew by less than this share of the estimated growth: the engine elided it. */
const ELIDED_SHARE = 0.25;
/** Sampling noise allowance on real bytes per call. */
const REAL_NOISE = 16;

function real_bytes(c: CaseReport | undefined, id: string): number | null {
	const m = c?.measure?.bytes;
	if (!m) return null;
	return m.functions.find((f) => f.id === id)?.real ?? 0;
}

/** Cases by name; a name two files share is left out (its findings cannot say which file). */
function by_unique_name(cases: CaseReport[]): Map<string, CaseReport> {
	const out = new Map<string, CaseReport>();
	const seen = new Set<string>();
	for (const c of cases) {
		if (seen.has(c.name)) out.delete(c.name);
		else out.set(c.name, c);
		seen.add(c.name);
	}
	return out;
}

export function measure_diff(d: DiffResult, base: Report, pr: Report): MeasureDiff {
	const base_cases = by_unique_name(base.cases);
	const pr_cases = by_unique_name(pr.cases);
	for (const ch of d.changes) {
		if (ch.delta.bytes <= 0 || ch.findings.length === 0) continue;
		const id = `${ch.module} > ${ch.function}`;
		const pr_real = real_bytes(pr_cases.get(ch.case), id);
		if (pr_real === null) continue;
		const base_id = ch.base ? ch.base.id : id;
		const base_real = real_bytes(base_cases.get(ch.case), base_id) ?? 0;
		const real_delta = pr_real - base_real;
		if (real_delta >= ch.delta.bytes * ELIDED_SHARE + REAL_NOISE) continue;
		for (const f of ch.findings) if (f.delta.allocations > 0 || f.delta.bytes > 0) f.elided = true;
	}
	const leaks: LeakFinding[] = [];
	const time_led: string[] = [];
	for (const c of pr.cases) {
		const l = c.measure?.leak;
		if (l?.leaked) {
			const b = base_cases.get(c.name)?.measure?.leak;
			leaks.push({ case: c.name, pr: l, base_leaked: b?.leaked ?? false });
		}
		if (c.measure?.estimate?.time_led) time_led.push(c.name);
	}
	const w = load_weights();
	const ns: Record<string, number> = {};
	if (w) {
		const prices = load_prices().prices;
		for (const ch of d.changes) {
			const a = ch.pr?.units ? units_ns(ch.pr.units, w, prices) : 0;
			const b = ch.base?.units ? units_ns(ch.base.units, w, prices) : 0;
			if (a !== b) ns[`${ch.case} > ${ch.module} > ${ch.function}`] = Math.round((a - b) * 10) / 10;
		}
	}
	return { leaks, time_led, ns, weights_version: w?.version ?? null };
}
