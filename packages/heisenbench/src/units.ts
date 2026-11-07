import { OP_KINDS, builtin_cost } from './prices.ts';
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
 *
 * The built-in size terms cover every price model (const, n, n log n, n^2), so a calibration
 * that changes a built-in's model recounts exactly too.
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

export const BUILTIN_TERMS = ['calls', 'n', 'nlogn', 'n2'] as const;

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
			if (!t) builtins.set(key, (t = [0, 0, 0, 0]));
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

/** Cost of `calls` calls with the given size sums: linear in the sums for every model. */
export function builtin_terms_cost(p: Prices['builtins'][string], t: number[]): number {
	const [calls, n, nlogn, n2] = t;
	switch (p.model) {
		case 'const':
			return calls * builtin_cost(p, 0);
		case 'n':
			return calls * p.base + p.k * n;
		case 'n_log_n':
			return calls * p.base + p.k * nlogn;
		case 'n2':
			return calls * p.base + p.k * n2;
	}
}

/** Sparse op units of an ops vector aligned with OP_KINDS, times `count`. */
export function op_units(ops: readonly number[], count = 1): Units {
	const u: Units = {};
	for (let i = 0; i < ops.length; i++) if (ops[i] !== 0) u[OP_KINDS[i]] = ops[i] * count;
	return u;
}
