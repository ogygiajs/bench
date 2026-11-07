import { inspect } from 'node:util';

/*
 * Same behavior, value by value. Two results are the same when nothing a caller can observe tells
 * them apart: primitives by Object.is (NaN is NaN, -0 is not 0), arrays by length, holes and
 * elements, plain objects and class instances by their class name and their own keys in order (a
 * key set to undefined is not a missing key), Map and Set by their entries in order, Date by its
 * time, RegExp by source, flags and lastIndex, typed arrays and buffers by type and bytes, errors
 * by name and message. Functions and promises are the same when both sides have one (their
 * behavior is not a value). A class instance is compared by its class's name, not its identity:
 * the original and the candidate are two modules, and each makes instances of its own classes.
 *
 * `first_difference` names where the first difference is (`out.files[2]: "a.js" vs "b.js"`).
 */

type Pairs = Map<object, object>;

const OBJECT_PROTO = Object.prototype;

function preview(v: unknown): string {
	return inspect(v, { depth: 1, breakLength: Infinity, maxArrayLength: 6, maxStringLength: 80 });
}

function class_name(v: object): string {
	const p = Object.getPrototypeOf(v) as { constructor?: { name?: unknown } } | null;
	if (p === null) return 'null prototype';
	if (p === OBJECT_PROTO) return 'Object';
	const name = p.constructor?.name;
	return typeof name === 'string' ? name : 'anonymous class';
}

function key_text(k: string | symbol): string {
	return typeof k === 'symbol'
		? `[${String(k)}]`
		: /^[A-Za-z_$][\w$]*$/.test(k)
			? `.${k}`
			: `[${JSON.stringify(k)}]`;
}

function own_keys(v: object): Array<string | symbol> {
	return Reflect.ownKeys(v).filter((k) => Object.prototype.propertyIsEnumerable.call(v, k));
}

function bytes_of(v: ArrayBufferView | ArrayBuffer): Uint8Array {
	if (v instanceof ArrayBuffer) return new Uint8Array(v);
	return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

/** Where `a` and `b` first differ (a path from `at`, and the two values), or null when they are the same. */
export function first_difference(a: unknown, b: unknown, at = 'out'): string | null {
	return diff(a, b, at, new Map());
}

function diff(a: unknown, b: unknown, at: string, seen: Pairs): string | null {
	if (Object.is(a, b)) return null;
	const ta = typeof a;
	const tb = typeof b;
	if (ta !== tb || a === null || b === null || (ta !== 'object' && ta !== 'function')) {
		if (ta === 'number' && tb === 'number' && a === 0 && b === 0)
			return `${at}: ${Object.is(a, -0) ? '-0' : '0'} vs ${Object.is(b, -0) ? '-0' : '0'}`;
		return `${at}: ${preview(a)} vs ${preview(b)}`;
	}
	if (ta === 'function') return null;
	const x = a as object;
	const y = b as object;
	const paired = seen.get(x);
	if (paired !== undefined) return paired === y ? null : `${at}: a shared value vs a separate one`;
	seen.set(x, y);
	const cx = class_name(x);
	const cy = class_name(y);
	if (cx !== cy) return `${at}: ${cx} vs ${cy}`;
	if (x instanceof Promise || y instanceof Promise) return null;
	if (Array.isArray(x)) {
		const ys = y as unknown[];
		if (x.length !== ys.length) return `${at}.length: ${x.length} vs ${ys.length}`;
		for (let i = 0; i < x.length; i++) {
			const hx = i in x;
			if (hx !== i in ys)
				return `${at}[${i}]: ${hx ? 'a value' : 'a hole'} vs ${hx ? 'a hole' : 'a value'}`;
			const d = diff(x[i], ys[i], `${at}[${i}]`, seen);
			if (d) return d;
		}
		return extra_keys(x, y, at, seen, true);
	}
	if (x instanceof Date) {
		const t = (y as Date).getTime();
		return Object.is(x.getTime(), t) ? null : `${at}: ${preview(x)} vs ${preview(y)}`;
	}
	if (x instanceof RegExp) {
		const r = y as RegExp;
		if (x.source !== r.source || x.flags !== r.flags || x.lastIndex !== r.lastIndex)
			return `${at}: ${preview(x)} vs ${preview(y)}`;
		return null;
	}
	if (ArrayBuffer.isView(x) || x instanceof ArrayBuffer) {
		const bx = bytes_of(x as ArrayBufferView);
		const by = bytes_of(y as ArrayBufferView);
		if (bx.length !== by.length) return `${at}: ${bx.length} bytes vs ${by.length}`;
		for (let i = 0; i < bx.length; i++)
			if (bx[i] !== by[i]) return `${at}: byte ${i} is ${bx[i]} vs ${by[i]}`;
		return null;
	}
	if (x instanceof Map) {
		const my = y as Map<unknown, unknown>;
		if (x.size !== my.size) return `${at}.size: ${x.size} vs ${my.size}`;
		const ex = [...x];
		const ey = [...my];
		for (let i = 0; i < ex.length; i++) {
			const dk = diff(ex[i][0], ey[i][0], `${at} key ${i}`, seen);
			if (dk) return dk;
			const dv = diff(ex[i][1], ey[i][1], `${at}.get(${preview(ex[i][0])})`, seen);
			if (dv) return dv;
		}
		return null;
	}
	if (x instanceof Set) {
		const sy = y as Set<unknown>;
		if (x.size !== sy.size) return `${at}.size: ${x.size} vs ${sy.size}`;
		const ex = [...x];
		const ey = [...sy];
		for (let i = 0; i < ex.length; i++) {
			const d = diff(ex[i], ey[i], `${at} entry ${i}`, seen);
			if (d) return d;
		}
		return null;
	}
	if (x instanceof Error) {
		const e = y as Error;
		if (x.name !== e.name || x.message !== e.message)
			return `${at}: ${x.name}: ${x.message} vs ${e.name}: ${e.message}`;
	}
	if (x instanceof Number || x instanceof String || x instanceof Boolean) {
		const d = diff(x.valueOf(), (y as { valueOf(): unknown }).valueOf(), at, seen);
		if (d) return d;
	}
	return extra_keys(x, y, at, seen, false);
}

/** Own enumerable keys, in order (array indexes left out for arrays). */
function extra_keys(x: object, y: object, at: string, seen: Pairs, array: boolean): string | null {
	const skip = (k: string | symbol) => array && typeof k === 'string' && /^\d+$/.test(k);
	const kx = own_keys(x).filter((k) => !skip(k));
	const ky = own_keys(y).filter((k) => !skip(k));
	const sy = new Set(ky);
	for (const k of kx) if (!sy.has(k)) return `${at}${key_text(k)}: present vs missing`;
	const sx = new Set(kx);
	for (const k of ky) if (!sx.has(k)) return `${at}${key_text(k)}: missing vs present`;
	for (let i = 0; i < kx.length; i++)
		if (kx[i] !== ky[i])
			return `${at}: keys in another order (${kx.map(String).join(', ')} vs ${ky.map(String).join(', ')})`;
	for (const k of kx) {
		const d = diff(
			(x as Record<string | symbol, unknown>)[k],
			(y as Record<string | symbol, unknown>)[k],
			`${at}${key_text(k)}`,
			seen
		);
		if (d) return d;
	}
	return null;
}

/** A short text of a value for a report. */
export function show(v: unknown, depth = 3): string {
	return inspect(v, { depth, breakLength: 100, maxArrayLength: 12, maxStringLength: 200 });
}
