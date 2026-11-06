/*
 * The generic input scaler (spec 9). `scale_input(ctx, k)` returns a copy of a case's input about k
 * times bigger, growing every collection once (a collection inside a grown one is copied, not grown
 * again, so the input grows linearly in k, never as k^depth):
 *
 * - arrays: the elements repeated k times (deep copies, so no two elements share identity)
 * - strings: repeated k times
 * - Map / Set: entries repeated k times, keys made distinct (`key~2`, number keys shifted)
 * - chains (an object whose property holds an object with the same keys, like a linked list or a
 *   nested path): made k times deeper
 * - plain objects: each property scaled; numbers, booleans, functions and class instances stay
 *
 * A case whose input does not grow this way (a size given as a number, an input that must stay
 * valid) declares its own: `bench(name, fn, { setup, scale: (ctx, k) => ... })`.
 */

type Obj = Record<string, unknown>;

function is_plain(v: unknown): v is Obj {
	if (v === null || typeof v !== 'object') return false;
	const p = Object.getPrototypeOf(v);
	return p === Object.prototype || p === null;
}

/** Deep copy of arrays, plain objects, Map, Set and Date; anything else is shared. */
export function clone<T>(v: T, seen = new Map<unknown, unknown>()): T {
	if (v === null || typeof v !== 'object') return v;
	const hit = seen.get(v);
	if (hit !== undefined) return hit as T;
	if (Array.isArray(v)) {
		const out: unknown[] = [];
		seen.set(v, out);
		for (let i = 0; i < v.length; i++) out.push(clone(v[i], seen));
		return out as T;
	}
	if (v instanceof Map) {
		const out = new Map();
		seen.set(v, out);
		for (const [k, x] of v) out.set(clone(k, seen), clone(x, seen));
		return out as T;
	}
	if (v instanceof Set) {
		const out = new Set();
		seen.set(v, out);
		for (const x of v) out.add(clone(x, seen));
		return out as T;
	}
	if (v instanceof Date) return new Date(v.getTime()) as T;
	if (is_plain(v)) {
		const out: Obj = Object.create(Object.getPrototypeOf(v)) as Obj;
		seen.set(v, out);
		for (const key of Object.keys(v)) out[key] = clone(v[key], seen);
		return out as T;
	}
	return v;
}

function same_keys(a: Obj, b: Obj): boolean {
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
	return true;
}

/** The property that links an object to a next object of the same shape, if any. */
function chain_key(o: Obj): string | null {
	for (const key of Object.keys(o)) {
		const v = o[key];
		if (is_plain(v) && v !== o && same_keys(o, v)) return key;
	}
	return null;
}

function rekey(key: unknown, j: number, span: number): unknown {
	if (j === 0) return key;
	if (typeof key === 'string') return `${key}~${j}`;
	if (typeof key === 'number') return key + j * span;
	return clone(key);
}

function key_span(keys: Iterable<unknown>): number {
	let max = 0;
	for (const k of keys)
		if (typeof k === 'number' && Number.isFinite(k)) max = Math.max(max, Math.abs(k));
	return Math.floor(max) + 1;
}

function deepen(head: Obj, key: string, k: number): Obj {
	const nodes: Obj[] = [];
	const seen = new Set<Obj>();
	let cur: unknown = head;
	while (is_plain(cur) && !seen.has(cur) && (nodes.length === 0 || same_keys(head, cur))) {
		seen.add(cur);
		nodes.push(cur);
		cur = cur[key];
	}
	const tail = cur;
	let first: Obj | null = null;
	let last: Obj | null = null;
	for (let j = 0; j < k; j++) {
		for (const n of nodes) {
			const copy: Obj = {};
			for (const p of Object.keys(n)) copy[p] = p === key ? undefined : clone(n[p]);
			if (last) last[key] = copy;
			else first = copy;
			last = copy;
		}
	}
	if (last) last[key] = clone(tail);
	return first ?? head;
}

function scale(v: unknown, k: number, inside: boolean): unknown {
	if (inside || k === 1) return clone(v);
	if (typeof v === 'string') return v.repeat(k);
	if (Array.isArray(v)) {
		const out: unknown[] = [];
		for (let j = 0; j < k; j++) for (let i = 0; i < v.length; i++) out.push(clone(v[i]));
		return out;
	}
	if (v instanceof Map) {
		const out = new Map();
		const span = key_span(v.keys());
		for (let j = 0; j < k; j++) for (const [key, x] of v) out.set(rekey(key, j, span), clone(x));
		return out;
	}
	if (v instanceof Set) {
		const out = new Set();
		const span = key_span(v);
		for (let j = 0; j < k; j++) for (const x of v) out.add(rekey(x, j, span));
		return out;
	}
	if (is_plain(v)) {
		const link = chain_key(v);
		if (link !== null) return deepen(v, link, k);
		const out: Obj = Object.create(Object.getPrototypeOf(v)) as Obj;
		for (const key of Object.keys(v)) out[key] = scale(v[key], k, false);
		return out;
	}
	return v;
}

/** A copy of `v` about `k` times bigger (k a whole number >= 1). */
export function scale_input<T>(v: T, k: number): T {
	return scale(v, Math.max(1, Math.round(k)), false) as T;
}

/** Size of an input: string chars + array elements + map/set entries + object keys, recursively. */
export function input_size(v: unknown, seen = new Set<unknown>()): number {
	if (typeof v === 'string') return v.length;
	if (v === null || typeof v !== 'object') return 1;
	if (seen.has(v)) return 0;
	seen.add(v);
	let n = 0;
	if (Array.isArray(v)) {
		n += v.length;
		for (const x of v) n += input_size(x, seen);
	} else if (v instanceof Map) {
		n += v.size;
		for (const [key, x] of v) n += input_size(key, seen) + input_size(x, seen);
	} else if (v instanceof Set) {
		n += v.size;
		for (const x of v) n += input_size(x, seen);
	} else if (is_plain(v)) {
		const keys = Object.keys(v);
		n += keys.length;
		for (const key of keys) n += input_size((v as Obj)[key], seen);
	} else {
		n += 1;
	}
	return n;
}
