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

/**
 * The sizes beside n that drive a built-in's work, each priced linearly (`terms`). One list for
 * every built-in; which ones a built-in has is in runtime/builtins.ts (SIZE_OF_TERMS):
 *
 *   parts      strings a `split` cuts
 *   matches    matches a `replace`, `replaceAll` or global `match` finds
 *   callbacks  calls a built-in makes into the code (a `replace` callback, `Array.from`'s mapFn)
 *   values     values `JSON.parse` builds or `JSON.stringify` visits
 *   items      elements a `join` turns into text (the ones that are not strings already)
 *
 * The order is fixed: it is the order of the runtime's unit slots (units.ts BUILTIN_TERMS).
 */
export const SIZE_TERMS = ['parts', 'matches', 'callbacks', 'values', 'items'] as const;

export type SizeTerm = (typeof SIZE_TERMS)[number];

export interface BuiltinPrice {
	model: BuiltinModel;
	base: number;
	k: number;
	/** Steps per unit of each size term (`{ "parts": 48 }`): `base + k f(n) + sum terms[t] * t`. */
	terms?: Partial<Record<SizeTerm, number>>;
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
	/**
	 * Joins (`a + b`, `s += x`, template literals) whose result has at least this many characters
	 * make a cons string and cost no characters; shorter ones are copied and cost `string_char` per
	 * character. Absent: V8's own threshold (layout.ts CONS_MIN). `null`: every join is copied and
	 * charged for its whole result, the pricing before cons strings (a candidate price file can
	 * bring it back, e.g. to check that `heisenbench audit` flags it).
	 */
	cons_min?: number | null;
}

function hash_of(prices: Prices): string {
	return createHash('sha256').update(JSON.stringify(prices)).digest('hex').slice(0, 16);
}

/**
 * Count with another price file: `HEISENBENCH_PRICES=<file>` replaces prices.json in this process
 * and every process it starts (the transform, the runtime and the report all read it from here).
 * For a calibration candidate or a price under audit; reports record its hash like any other.
 */
export const PRICES_ENV = 'HEISENBENCH_PRICES';

function read_prices(path: string | URL): { prices: Prices; hash: string } {
	const prices = JSON.parse(readFileSync(path, 'utf8')) as Prices;
	return { prices, hash: hash_of(prices) };
}

// `globalThis.process`: the runtime is also bundled into pages (app layer), which have no process.
const override = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
	?.env?.[PRICES_ENV];

/** The versioned price file (a JSON import, so a bundled runtime carries it along). */
const DEFAULT = override
	? read_prices(override)
	: { prices: default_prices as Prices, hash: hash_of(default_prices as Prices) };

/** The default prices, or another price file (e.g. a calibration candidate). */
export function load_prices(path?: string | URL): { prices: Prices; hash: string } {
	if (!path) return DEFAULT;
	return read_prices(path);
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

/**
 * Steps of one call of size `n`; `sizes` are its size terms, aligned with SIZE_TERMS (absent: 0).
 * The model's term comes first, then the size terms in SIZE_TERMS order: the order the units
 * reprice them in (units.ts), so a recount gives the same number.
 */
export function builtin_cost(p: BuiltinPrice, n: number, sizes?: ArrayLike<number> | null): number {
	let cost: number;
	switch (p.model) {
		case 'const':
			cost = p.base;
			break;
		case 'n':
			cost = p.base + p.k * n;
			break;
		case 'n_log_n':
			cost = p.base + p.k * n_log_n(n);
			break;
		case 'n2':
			cost = p.base + p.k * n * n;
			break;
	}
	const t = p.terms;
	if (t && sizes) {
		for (let i = 0; i < SIZE_TERMS.length; i++) {
			const per = t[SIZE_TERMS[i]];
			if (per !== undefined && sizes[i]) cost += per * sizes[i];
		}
	}
	return cost;
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
