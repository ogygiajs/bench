import { OP_KINDS, SIZE_TERMS, builtin_cost } from './prices.ts';
import type { OpKind, Prices } from './prices.ts';
import type { SiteKind } from './meta.ts';

/*
 * Units: what a run did, before it is priced. Steps are units times prices; a report keeps the
 * units next to the steps (per function, per line, per block) so a price change can recount both
 * sides of a comparison exactly, without running anything again (recount.ts).
 *
 * Keys, all counts per run:
 *   <op kind>            ops executed (`call`, `prop_read`, ...), block count * the block's ops
 *   dyn.<price>          dynamic size units: characters built, keys spread, elements spread...
 *   bi.<key>.calls       calls of a priced built-in (`bi.Array.prototype.sort.calls`)
 *   bi.<key>.n           sum of its sizes; `.nlogn` sum of n log2 n; `.n2` sum of n^2
 *   bi.<key>.<term>      sum of a size term (prices.ts SIZE_TERMS: `.parts` of a split...)
 *
 * The built-in size terms cover every price model (const, n, n log n, n^2), so a calibration
 * that changes a built-in's model recounts exactly too. The size terms are kept for every
 * built-in that has them, priced or not, so a price that adds one recounts exactly, and the
 * audit can test one a price leaves out. Reports from before size terms were kept say so
 * (`Report.unit_terms` absent): they cannot be recounted with a price that uses one.
 */

export type Units = Record<string, number>;

export type DynamicPrice = keyof Prices['dynamic'];

/** The dynamic price that sizes each kind of dynamic site (null: the site has no size cost). */
export const DYNAMIC_PRICE: Record<SiteKind, DynamicPrice | null> = {
	string: 'string_char',
	spread_object: 'spread_key',
	spread_array: 'spread_element',
	spread_args: 'spread_element',
	rest: 'rest_element',
	arguments: 'arguments_element',
	object: null,
	array: null,
	closure: null,
	class: null,
	new: null,
	regexp: null,
	bound: null,
	promise: null,
	generator: null
};

export const BUILTIN_TERMS = ['calls', 'n', 'nlogn', 'n2', ...SIZE_TERMS] as const;

/** Where the size terms start in BUILTIN_TERMS (and in the runtime's slots of a built-in). */
export const SIZE_TERM_OFFSET = 4;

export function add_unit(u: Units, key: string, v: number): void {
	if (v !== 0) u[key] = (u[key] ?? 0) + v;
}

export function add_units(into: Units, from: Units, times = 1): void {
	for (const k of Object.keys(from)) add_unit(into, k, from[k] * times);
}

/** Steps of a set of units under a price file. */
export function price_units(u: Units, prices: Prices): number {
	let steps = 0;
	const builtins = new Map<string, number[]>();
	for (const k of Object.keys(u)) {
		const v = u[k];
		if (k.startsWith('dyn.')) {
			steps += v * (prices.dynamic[k.slice(4) as DynamicPrice] ?? 0);
		} else if (k.startsWith('bi.')) {
			const dot = k.lastIndexOf('.');
			const key = k.slice(3, dot);
			const term = BUILTIN_TERMS.indexOf(k.slice(dot + 1) as (typeof BUILTIN_TERMS)[number]);
			let t = builtins.get(key);
			if (!t) builtins.set(key, (t = Array.from({ length: BUILTIN_TERMS.length }, () => 0)));
			if (term >= 0) t[term] += v;
		} else {
			steps += v * (prices.ops[k as OpKind] ?? 0);
		}
	}
	for (const [key, t] of builtins) {
		const p = prices.builtins[key];
		if (!p) continue;
		steps += builtin_terms_cost(p, t);
	}
	return Math.round(steps * 1e6) / 1e6;
}

/**
 * Cost of `calls` calls with the given size sums (aligned with BUILTIN_TERMS): linear in the sums
 * for every model and every size term.
 */
export function builtin_terms_cost(p: Prices['builtins'][string], t: number[]): number {
	const [calls, n, nlogn, n2] = t;
	let cost: number;
	switch (p.model) {
		case 'const':
			cost = calls * builtin_cost(p, 0);
			break;
		case 'n':
			cost = calls * p.base + p.k * n;
			break;
		case 'n_log_n':
			cost = calls * p.base + p.k * nlogn;
			break;
		case 'n2':
			cost = calls * p.base + p.k * n2;
			break;
	}
	if (p.terms) {
		for (let i = 0; i < SIZE_TERMS.length; i++) {
			const per = p.terms[SIZE_TERMS[i]];
			const v = t[SIZE_TERM_OFFSET + i] ?? 0;
			if (per !== undefined && v) cost += per * v;
		}
	}
	return cost;
}

/** The size terms a price uses (`parts`...): a report that kept none of them cannot be recounted with it. */
export function priced_size_terms(prices: Prices): Set<string> {
	const out = new Set<string>();
	for (const p of Object.values(prices.builtins))
		for (const t of Object.keys(p.terms ?? {})) out.add(t);
	return out;
}

/** Sparse op units of an ops vector aligned with OP_KINDS, times `count`. */
export function op_units(ops: readonly number[], count = 1): Units {
	const u: Units = {};
	for (let i = 0; i < ops.length; i++) if (ops[i] !== 0) u[OP_KINDS[i]] = ops[i] * count;
	return u;
}
