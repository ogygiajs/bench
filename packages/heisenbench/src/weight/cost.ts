import { load_prices } from '../prices.ts';
import type { Prices } from '../prices.ts';
import { prices_step_ns, units_ns } from '../calibrate/weights.ts';
import type { FitSpread, Weights } from '../calibrate/weights.ts';
import type { Units } from '../units.ts';
import type { AppWeights, FunctionWeight, Traffic } from './weights.ts';

/*
 * What a finding costs on real traffic (README "Real traffic"):
 *
 *   extra ns per call × real calls per request × requests per day = CPU time per day
 *
 * The extra ns per call comes from the steps -> ns weights (calibrate/weights.ts) on the change's
 * units, or, for a number that has no units (a growth curve), from steps × the prices' step_ns.
 * There is no other conversion.
 *
 * There are two ways to price a change, and each holds under its own assumption:
 *
 *   per call    calls per request × Δns per call. The calls are counted: by the profile (V8
 *               precise coverage), or else in the app scenarios' server requests (the median of
 *               their units). Δns is the fit's absolute estimate, so the range is its absolute
 *               spread (measured / estimated over the calibration points, 10th to 90th
 *               percentile). It assumes the traffic's inputs cost per call what the bench's does.
 *   by time     the function's measured ns per request × Δns / its base ns per call in the bench:
 *               the change takes the same share of the function's real time as of its bench time.
 *               Both estimates are of the same code, so the fit's bias cancels and what is left is
 *               its relative spread (one estimate over another of the same code), times the
 *               sampling error of the measured time (90% interval of `samples`: ± 1.645 / √n).
 *               It assumes the change grows with the input the way the function's work does.
 *
 * With one way, that one. With both: when their ranges overlap, the narrower; when they do not
 * (the bench's input is unlike the traffic's, and the change does not grow like the function's
 * work: an O(n) pass added to an O(1) function), the estimate is their geometric mean, the range
 * spans both, and the result says how far apart they are.
 *
 * Requests per day are given, or read off the profiles: requests over their recording window,
 * which extrapolates the rate during recording to a day.
 */

export type WayFrom = 'counted' | 'app scenarios' | 'by time';

/** One way to price a change (see above). */
export interface CostWay {
	from: WayFrom;
	/** Calls per request (per call ways). */
	calls: number | null;
	/** The function's measured ns per request, and Δ over its base per call (the by-time way). */
	real_ns: number | null;
	ratio: number | null;
	ns: number;
	range: [number, number];
}

/** A real-cost estimate for one finding. */
export interface RealCost {
	/** `change`: what a change adds; `now`: what the function takes on the traffic as it is. */
	what: 'change' | 'now';
	/** The unit of traffic (`real request`). */
	unit: string;
	/** The ways the change was priced; the estimate is one of them, or both together. */
	ways: CostWay[];
	/** Both ways priced it and their ranges do not overlap: how many times apart they are. */
	disagree: number | null;
	/** ns per request: the estimate and its range. */
	ns: number;
	range: [number, number];
	requests_per_day: number;
	requests_per_day_from: 'given' | 'profiles';
	/** CPU seconds per day: the estimate and its range. */
	cpu_s_per_day: number;
	cpu_s_range: [number, number];
	/** How steps became ns: the weights fit, steps × step_ns, or none (a `now` cost was timed). */
	conversion: 'weights fit' | 'step_ns' | 'measured';
	/** A `now` cost: the counted calls per request, when the profile counted them. */
	calls?: number | null;
}

/** What a finding brings to the cost model. */
export interface CostInput {
	/** Δ per call (or per run of the measured unit, with `ref` in the same unit). */
	delta_steps: number;
	delta_units?: Units | null;
	/** The same function's base cost in the same unit: the by-time way. */
	ref_steps?: number | null;
	ref_units?: Units | null;
	/** `self`: the Δ is the function's own steps; `total`: with everything it calls. */
	kind: 'self' | 'total';
	/** The Δ is per call of the function (a call count applies to it). */
	per_call: boolean;
	/** Calls per server request the app scenarios counted (when the profile did not count). */
	app_calls?: number | null;
}

export interface CostContext {
	ns_weights: Weights | null;
	prices: Prices;
	/** Requests per day; read off the profiles when not given. */
	requests_per_day?: number;
}

export function cost_context(
	ns_weights: Weights | null,
	requests_per_day?: number,
	prices: Prices = load_prices().prices
): CostContext {
	return { ns_weights, prices, requests_per_day };
}

const DEFAULT_SPREAD: FitSpread = {
	// before a weights file carried its spread: the committed calibration's (weights v2)
	absolute: [0.831, 1.443, 4.573],
	relative: [0.799, 1, 1.251],
	absolute_steps: [0.636, 3.808, 20.807],
	relative_steps: [0.485, 0.999, 2.061]
};

/** The unit of real traffic in a weights file, or null. */
export function traffic_unit(
	w: AppWeights | null
): { key: string; traffic: Traffic; units: number } | null {
	if (!w) return null;
	for (const [key, u] of Object.entries(w.units).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
		if (u.traffic) return { key, traffic: u.traffic, units: u.units };
	}
	return null;
}

/** The median calls per server request of a function over the app scenarios' units, or null. */
export function app_server_calls(w: AppWeights | null, key: string): number | null {
	const per = w?.functions[key];
	if (!w || !per) return null;
	const calls = Object.entries(per)
		.filter(([u, f]) => w.units[u]?.side === 'server' && !w.units[u].traffic && f.calls > 0)
		.map(([, f]) => f.calls)
		.sort((a, b) => a - b);
	if (calls.length === 0) return null;
	const h = calls.length >> 1;
	return calls.length % 2 ? calls[h] : (calls[h - 1] + calls[h]) / 2;
}

/** Requests per day: given, or the profiles' requests over their window. */
export function requests_per_day(
	t: Traffic,
	given?: number
): { n: number; from: 'given' | 'profiles' } | null {
	if (given !== undefined && given > 0) return { n: given, from: 'given' };
	if (t.window_ms > 0 && t.requests > 0)
		return { n: (t.requests / t.window_ms) * 86_400_000, from: 'profiles' };
	return null;
}

/** ns of a Δ: through the fit when its units are there, else steps × step_ns. */
function to_ns(
	steps: number,
	units: Units | null | undefined,
	ctx: CostContext
): { ns: number; conversion: 'weights fit' | 'step_ns' } | null {
	if (units && ctx.ns_weights)
		return { ns: units_ns(units, ctx.ns_weights, ctx.prices), conversion: 'weights fit' };
	const step = prices_step_ns(ctx.prices);
	return step === null ? null : { ns: steps * step, conversion: 'step_ns' };
}

/** 90% interval factor of a measured time from `samples` samples (none: taken as exact). */
function sampling_factor(samples: number | undefined): number {
	return samples && samples > 0 ? Math.exp(1.645 / Math.sqrt(samples)) : 1;
}

const ordered = (a: number, b: number): [number, number] => (a <= b ? [a, b] : [b, a]);

function way(
	from: WayFrom,
	ns: number,
	lo: number,
	hi: number,
	o: Partial<Pick<CostWay, 'calls' | 'real_ns' | 'ratio'>>
): CostWay {
	return {
		from,
		calls: o.calls ?? null,
		real_ns: o.real_ns ?? null,
		ratio: o.ratio ?? null,
		ns,
		range: ordered(ns * lo, ns * hi)
	};
}

/** One estimate from the ways (see the comment at the top). */
function combine(ways: CostWay[]): {
	ns: number;
	range: [number, number];
	disagree: number | null;
} {
	if (ways.length === 1) return { ns: ways[0].ns, range: ways[0].range, disagree: null };
	const [a, b] = ways;
	const overlap = a.range[0] <= b.range[1] && b.range[0] <= a.range[1];
	if (overlap) {
		const width = (w: CostWay) => Math.log(Math.abs(w.range[1] / w.range[0]));
		const best = width(b) < width(a) ? b : a;
		return { ns: best.ns, range: best.range, disagree: null };
	}
	const ns = Math.sign(a.ns) * Math.sqrt(Math.abs(a.ns * b.ns));
	const range = ordered(
		Math.min(a.range[0], b.range[0], a.range[1], b.range[1]),
		Math.max(a.range[0], b.range[0], a.range[1], b.range[1])
	);
	const far = Math.max(Math.abs(a.ns), Math.abs(b.ns)) / Math.min(Math.abs(a.ns), Math.abs(b.ns));
	return { ns, range, disagree: round_sig(far) };
}

function priced(
	what: RealCost['what'],
	unit: string,
	rpd: { n: number; from: 'given' | 'profiles' },
	est: { ns: number; range: [number, number]; disagree: number | null },
	ways: CostWay[],
	conversion: RealCost['conversion']
): RealCost {
	const day = rpd.n / 1e9;
	return {
		what,
		unit,
		ways: ways.map((w) => ({
			...w,
			calls: w.calls === null ? null : round_sig(w.calls),
			real_ns: w.real_ns === null ? null : round_sig(w.real_ns),
			ratio: w.ratio === null ? null : round_sig(w.ratio),
			ns: round_sig(w.ns),
			range: [round_sig(w.range[0]), round_sig(w.range[1])]
		})),
		disagree: est.disagree,
		ns: round_sig(est.ns),
		range: [round_sig(est.range[0]), round_sig(est.range[1])],
		requests_per_day: round_sig(rpd.n),
		requests_per_day_from: rpd.from,
		cpu_s_per_day: round_sig(est.ns * day),
		cpu_s_range: [round_sig(est.range[0] * day), round_sig(est.range[1] * day)],
		conversion
	};
}

/**
 * The real cost of one change, or null when the function is not in the traffic, or nothing
 * says how often it runs there.
 */
export function real_cost(
	w: FunctionWeight | undefined,
	unit: { key: string; traffic: Traffic },
	input: CostInput,
	ctx: CostContext
): RealCost | null {
	if (!w || input.delta_steps === 0) return null;
	const rpd = requests_per_day(unit.traffic, ctx.requests_per_day);
	if (!rpd) return null;
	const spread = ctx.ns_weights?.fit.spread ?? DEFAULT_SPREAD;
	// one conversion for the change and its base: the fit when both have units
	const has_ref = !!input.ref_steps && input.ref_steps > 0;
	const units_ok = !!input.delta_units && (!has_ref || !!input.ref_units);
	const delta = to_ns(input.delta_steps, units_ok ? input.delta_units : null, ctx);
	if (!delta) return null;
	const fit = delta.conversion === 'weights fit';
	const ways: CostWay[] = [];
	const counted = w.calls_counted && w.calls > 0 ? w.calls : null;
	const calls = counted ?? (input.app_calls && input.app_calls > 0 ? input.app_calls : null);
	if (input.per_call && calls !== null) {
		const [p10, , p90] = fit ? spread.absolute : spread.absolute_steps;
		ways.push(
			way(counted !== null ? 'counted' : 'app scenarios', delta.ns * calls, p10, p90, { calls })
		);
	}
	const real_ns = input.kind === 'self' ? w.self_ns : w.total_ns;
	const ref = has_ref ? to_ns(input.ref_steps!, fit ? input.ref_units : null, ctx) : null;
	if (real_ns !== undefined && real_ns > 0 && ref && ref.ns > 0) {
		const [p10, , p90] = fit ? spread.relative : spread.relative_steps;
		const s = sampling_factor(w.samples);
		const ratio = delta.ns / ref.ns;
		ways.push(way('by time', real_ns * ratio, p10 / s, p90 * s, { real_ns, ratio }));
	}
	if (ways.length === 0) return null;
	return priced('change', unit.key, rpd, combine(ways), ways, delta.conversion);
}

/**
 * What a function takes on the traffic now (a growth finding's exposure): its measured self or
 * total ns per request, with the sampling range only. No conversion: it was timed.
 */
export function exposure_cost(
	w: FunctionWeight | undefined,
	unit: { key: string; traffic: Traffic },
	kind: 'self' | 'total',
	ctx: CostContext
): RealCost | null {
	const ns = kind === 'self' ? w?.self_ns : w?.total_ns;
	if (!w || !ns) return null;
	const rpd = requests_per_day(unit.traffic, ctx.requests_per_day);
	if (!rpd) return null;
	const s = sampling_factor(w.samples);
	const range = ordered(ns / s, ns * s);
	return {
		...priced('now', unit.key, rpd, { ns, range, disagree: null }, [], 'measured'),
		calls: w.calls_counted ? w.calls : null
	};
}

/**
 * Several changes' costs on one traffic as one (blame: the functions one hunk changed): the
 * estimates add, and so do the ends of their ranges. Null when there are none, or when they are
 * not on the same unit and rate.
 */
export function sum_costs(costs: readonly RealCost[]): RealCost | null {
	if (costs.length === 0) return null;
	const [first] = costs;
	if (costs.some((c) => c.unit !== first.unit || c.requests_per_day !== first.requests_per_day))
		return null;
	if (costs.length === 1) return first;
	let ns = 0;
	let lo = 0;
	let hi = 0;
	for (const c of costs) {
		ns += c.ns;
		lo += c.range[0];
		hi += c.range[1];
	}
	const conversions = new Set(costs.map((c) => c.conversion));
	return priced(
		first.what,
		first.unit,
		{ n: first.requests_per_day, from: first.requests_per_day_from },
		{ ns, range: ordered(lo, hi), disagree: null },
		[],
		conversions.size === 1 ? first.conversion : 'weights fit'
	);
}

/** Four significant digits: estimates read the same from the same inputs on any machine. */
export function round_sig(n: number): number {
	if (n === 0 || !Number.isFinite(n)) return n;
	return Number(n.toPrecision(4));
}

/** The unit CPU seconds per day read best in: [seconds per unit, its name]. */
function cpu_unit(s: number): [number, string] {
	const a = Math.abs(s);
	if (a >= 3600) return [3600, 'CPU-hours/day'];
	if (a >= 60) return [60, 'CPU-minutes/day'];
	if (a >= 1) return [1, 'CPU-seconds/day'];
	return [1e-3, 'CPU-ms/day'];
}

function fmt(v: number): string {
	return Math.abs(v) >= 10 ? Math.round(v).toString() : Number(v.toPrecision(2)).toString();
}

/** `12 CPU-minutes/day`: CPU seconds per day in the unit that reads best. */
export function cpu_day_text(s: number): string {
	const [div, name] = cpu_unit(s);
	return `${fmt(s / div)} ${name}`;
}

/** `range 8–18`, in the estimate's unit; bounds far apart each in their own unit. */
export function cpu_range_text(c: RealCost): string {
	const [lo, hi] = c.cpu_s_range;
	const [div] = cpu_unit(c.cpu_s_per_day);
	if (cpu_unit(lo)[0] === div && cpu_unit(hi)[0] === div)
		return `range ${fmt(lo / div)}–${fmt(hi / div)}`;
	return `range ${cpu_day_text(lo).replace('/day', '')} to ${cpu_day_text(hi).replace('/day', '')}`;
}

function rate_text(n: number): string {
	return n >= 1e6
		? `${round_sig(n / 1e6)}M`
		: n >= 1e3
			? `${round_sig(n / 1e3)}K`
			: `${round_sig(n)}`;
}

/** `≈ 12 CPU-minutes/day at 1M requests/day (range 8–18)` */
export function cost_text(c: RealCost): string {
	const from = c.requests_per_day_from === 'profiles' ? ' (the profiles’ rate)' : '';
	return `≈ ${cpu_day_text(c.cpu_s_per_day)} at ${rate_text(c.requests_per_day)} requests/day${from} (${cpu_range_text(c)})`;
}

/** A time per request: `0.20 ms`, `4.3 µs`. */
export function ns_text(ns: number): string {
	const a = Math.abs(ns);
	if (a >= 1e6) return `${fmt(ns / 1e6)} ms`;
	if (a >= 1e3) return `${fmt(ns / 1e3)} µs`;
	return `${fmt(ns)} ns`;
}

function calls_words(n: number): string {
	const v = n >= 100 ? Math.round(n).toString() : Number(n.toPrecision(2)).toString();
	return `${v} call${v === '1' ? '' : 's'}/request`;
}

/** How one way priced it: `40 calls/request`, `0.20 ms/request of real self time × 38`. */
export function way_text(w: CostWay): string {
	if (w.from === 'by time') return `${ns_text(w.real_ns!)}/request of real time × ${fmt(w.ratio!)}`;
	return `${calls_words(w.calls!)}${w.from === 'app scenarios' ? ' (app scenarios)' : ''}`;
}

/** The ways behind an estimate, for the table: one way, or both and how far apart. */
export function calls_text(c: RealCost): string {
	if (c.what === 'now')
		return c.calls ? calls_words(c.calls) : `${ns_text(c.ns)}/request of real time`;
	if (c.ways.length === 1) return way_text(c.ways[0]);
	const both = c.ways.map(way_text).join(' or ');
	return c.disagree === null
		? both
		: `${both}: ${fmt(c.disagree)}x apart, the bench's input is unlike the traffic's`;
}

/** "82% of sampled self time mapped to counted functions; top unmatched: ..." */
export function coverage_line(w: AppWeights | null): string | null {
	const t = traffic_unit(w)?.traffic;
	if (!t) return null;
	const pct = t.sampled_ms > 0 ? Math.round((t.mapped_ms / t.sampled_ms) * 1000) / 10 : 0;
	const top = t.unmatched
		.slice(0, 3)
		.map((u) => `${u.frame} (${u.self_ms.toFixed(1)} ms, ${u.reason})`)
		.join(', ');
	return `${pct}% of sampled self time mapped to counted functions (${t.mapped_ms.toFixed(1)} of ${t.sampled_ms.toFixed(1)} ms)${top ? `; top unmatched: ${top}` : ''}`;
}
