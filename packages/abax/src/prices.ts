import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import default_prices from '../prices.json' with { type: 'json' };

/** Every op kind the transform prices. A block's ops vector is indexed by this list. */
export const OP_KINDS = [
	'call',
	'new',
	'prop_read',
	'prop_write',
	'arith',
	'compare',
	'logical',
	'branch',
	'assign',
	'unary',
	'update',
	'template',
	'concat',
	'iter_init',
	'iter_step',
	'forin_step',
	'await',
	'yield',
	'throw',
	'alloc',
	'alloc_word'
] as const;

export type OpKind = (typeof OP_KINDS)[number];

export const OP_INDEX: Record<OpKind, number> = Object.fromEntries(
	OP_KINDS.map((k, i) => [k, i])
) as Record<OpKind, number>;

export type BuiltinModel = 'const' | 'n' | 'n_log_n' | 'n2';

export interface BuiltinPrice {
	model: BuiltinModel;
	base: number;
	k: number;
}

export interface Prices {
	version: number;
	ops: Record<OpKind, number>;
	dynamic: {
		spread_key: number;
		spread_element: number;
		string_char: number;
		rest_element: number;
		arguments_element: number;
	};
	builtins: Record<string, BuiltinPrice>;
}

function hash_of(prices: Prices): string {
	return createHash('sha256').update(JSON.stringify(prices)).digest('hex').slice(0, 16);
}

/** The versioned price file (a JSON import, so a bundled runtime carries it along). */
const DEFAULT = { prices: default_prices as Prices, hash: hash_of(default_prices as Prices) };

/** The default prices, or another price file (e.g. a calibration candidate). */
export function load_prices(path?: string | URL): { prices: Prices; hash: string } {
	if (!path) return DEFAULT;
	const prices = JSON.parse(readFileSync(path, 'utf8')) as Prices;
	return { prices, hash: hash_of(prices) };
}

/** Price vector aligned with OP_KINDS. */
export function op_price_vector(prices: Prices): Float64Array {
	const v = new Float64Array(OP_KINDS.length);
	for (let i = 0; i < OP_KINDS.length; i++) v[i] = prices.ops[OP_KINDS[i]] ?? 0;
	return v;
}

/**
 * n log2 n (n itself up to 1), to the nearest 1/64: a binary fraction, so a price times it and a
 * sum of those are exact in any order (a recount from units equals the runtime's count to the bit).
 */
export function n_log_n(n: number): number {
	return n > 1 ? Math.round(n * Math.log2(n) * 64) / 64 : n;
}

export function builtin_cost(p: BuiltinPrice, n: number): number {
	switch (p.model) {
		case 'const':
			return p.base;
		case 'n':
			return p.base + p.k * n;
		case 'n_log_n':
			return p.base + p.k * n_log_n(n);
		case 'n2':
			return p.base + p.k * n * n;
	}
}

/**
 * The method or function name a call site must use for a priced built-in to be attributed to it:
 * `Array.prototype.sort` -> `sort`, `JSON.parse` -> `parse`, `structuredClone` -> `structuredClone`.
 */
export function builtin_call_name(key: string): string {
	const dot = key.lastIndexOf('.');
	return dot === -1 ? key : key.slice(dot + 1);
}

/** Sorted, de-duplicated call names; a name's id is its index here (shared by transform and runtime). */
export function builtin_names(prices: Prices): string[] {
	return [...new Set(Object.keys(prices.builtins).map(builtin_call_name))].sort();
}
