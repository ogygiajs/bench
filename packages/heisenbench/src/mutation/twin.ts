/*
 * The twin check of the mutation layer (mutation/index.ts). A mutant must not change what the code
 * does, only how much work it does. Each function a mutant goes into is also hooked (operators.ts
 * `hooked`): every value it returns, every error it throws and, for a constructor, the object it
 * built, is handed to `globalThis[TWIN]` with the function's id. A recount child counting with the
 * twin on (blame/child.ts `twin`) fingerprints each one; the mutant and the hooked original are
 * counted on the same cases, and their fingerprints must be the same, call for call, or the mutant
 * changed behavior and is discarded.
 *
 * A fingerprint walks the value: primitives, arrays, plain objects and class instances (own data
 * properties in order; accessors are named, never read, so no code runs), Map and Set entries,
 * dates, regexps, typed arrays, functions by name and length, cycles by back reference. It reads
 * through the built-ins captured when this module loads, so the priced wrappers of the measuring
 * window never see it and the counts do not depend on it. The walk stops after MAX_NODES values,
 * the same way every time. The run root a recount child runs in is replaced by `<root>` in every
 * string, so a mutant counted in another scratch copy fingerprints the same.
 */

export const TWIN = Symbol.for('heisenbench.mutation.twin');

/** Values one fingerprint walks at most (the same prefix of a large value every time). */
export const MAX_NODES = 20_000;

const keys = Object.keys;
const get_proto = Object.getPrototypeOf;
const own_desc = Object.getOwnPropertyDescriptor;
const is_array = Array.isArray;
const map_entries = Map.prototype.entries;
const set_values = Set.prototype.values;
const date_time = Date.prototype.getTime;
const regexp_text = RegExp.prototype.toString;
const char_code = String.prototype.charCodeAt;
const replace_all = String.prototype.replaceAll;
const pad_start = String.prototype.padStart;
const apply = Reflect.apply;
const split_join = (s: string, a: string, b: string): string =>
	apply(replace_all, s, [a, b]) as string;
const typed_proto = get_proto(Uint8Array.prototype) as object;
const typed_length = own_desc(typed_proto, 'length')!.get!;
const typed_tag = own_desc(typed_proto, Symbol.toStringTag)!.get!;
const iter_next = (it: Iterator<unknown>): IteratorResult<unknown> => apply(it.next, it, []);

/** FNV-1a over 32 bits, twice with different seeds: 16 hex characters. */
class Hash {
	a = 0x811c9dc5;
	b = 0x01000193 ^ 0x5bd1e995;
	text(s: string): void {
		for (let i = 0; i < s.length; i++) {
			const c = apply(char_code, s, [i]) as number;
			this.a = Math.imul(this.a ^ c, 0x01000193) >>> 0;
			this.b = Math.imul(this.b ^ c, 0x0100019d) >>> 0;
		}
		this.a = Math.imul(this.a ^ 0xff, 0x01000193) >>> 0;
		this.b = Math.imul(this.b ^ 0xff, 0x0100019d) >>> 0;
	}
	hex(): string {
		const hex8 = (n: number) => apply(pad_start, n.toString(16), [8, '0']) as string;
		return hex8(this.a) + hex8(this.b);
	}
}

/** A deterministic fingerprint of `value`, with `roots` replaced by `<root>` in its strings. */
export function fingerprint(value: unknown, roots: readonly string[] = []): string {
	const h = new Hash();
	const seen = new Map<object, number>();
	let nodes = 0;
	const str = (s: string): string => {
		let out = s;
		for (const r of roots) if (r !== '') out = split_join(out, r, '<root>');
		return out;
	};
	const walk = (v: unknown): void => {
		if (++nodes > MAX_NODES) {
			if (nodes === MAX_NODES + 1) h.text('…');
			return;
		}
		const t = typeof v;
		if (v === null) return h.text('null');
		if (t === 'undefined') return h.text('u');
		if (t === 'string') return h.text('s' + str(v as string));
		if (t === 'number') return h.text('n' + (Object.is(v, -0) ? '-0' : String(v)));
		if (t === 'boolean' || t === 'bigint') return h.text(t[0] + String(v));
		if (t === 'symbol') return h.text('y' + String((v as symbol).description));
		if (t === 'function') {
			const f = v as { name?: unknown; length?: unknown };
			return h.text(`f${typeof f.name === 'string' ? f.name : ''}/${String(f.length)}`);
		}
		const o = v as object;
		const at = seen.get(o);
		if (at !== undefined) return h.text('@' + at);
		seen.set(o, seen.size);
		if (is_array(o)) {
			h.text('[' + o.length);
			for (let i = 0; i < o.length; i++) {
				const d = own_desc(o, i);
				if (d && 'value' in d) walk(d.value);
				else h.text(d ? 'get' : 'hole');
			}
			return h.text(']');
		}
		if (o instanceof Map) {
			h.text('Map' + o.size);
			const it = apply(map_entries, o, []) as Iterator<[unknown, unknown]>;
			for (let r = iter_next(it); !r.done; r = iter_next(it)) {
				const [k, val] = r.value as [unknown, unknown];
				walk(k);
				walk(val);
			}
			return;
		}
		if (o instanceof Set) {
			h.text('Set' + o.size);
			const it = apply(set_values, o, []) as Iterator<unknown>;
			for (let r = iter_next(it); !r.done; r = iter_next(it)) walk(r.value);
			return;
		}
		if (o instanceof Date) return h.text('Date' + String(apply(date_time, o, [])));
		if (o instanceof RegExp) return h.text('RegExp' + String(apply(regexp_text, o, [])));
		if (ArrayBuffer.isView(o) && !(o instanceof DataView)) {
			const n = apply(typed_length, o, []) as number;
			h.text(String(apply(typed_tag, o, [])) + n);
			const a = o as unknown as ArrayLike<number | bigint>;
			for (let i = 0; i < n && nodes <= MAX_NODES; i++, nodes++) h.text(String(a[i]));
			return;
		}
		if (o instanceof Promise) return h.text('Promise');
		if (o instanceof Error) h.text('Error' + str(String(o.message)));
		const proto = get_proto(o) as { constructor?: { name?: unknown } } | null;
		const name = proto?.constructor?.name;
		h.text('{' + (typeof name === 'string' ? name : ''));
		for (const k of keys(o)) {
			h.text(k);
			const d = own_desc(o, k);
			if (d && 'value' in d) walk(d.value);
			else h.text('get');
		}
		h.text('}');
	};
	walk(value);
	return h.hex();
}

export interface TwinRecord {
	/** The hooked function's id. */
	id: string;
	/** `r` returned, `t` threw, `c` a constructor's object. */
	how: string;
	print: string;
}

/** Calls kept one by one (to say where two runs differ); past them only the running hash. */
export const KEPT_CALLS = 2000;

/** What one counted tree's hooked calls gave. */
export interface TwinSummary {
	calls: number;
	/** A hash over every call's record, in order. */
	hash: string;
	/** The first KEPT_CALLS records. */
	head: TwinRecord[];
}

/**
 * Install the hook. `record` false: the hook only passes values through (a hooked tree counted
 * without the check, or grown). Returns what was recorded so far.
 */
export function install_twin(roots: readonly string[], record: boolean): () => TwinSummary {
	const head: TwinRecord[] = [];
	const all = new Hash();
	let calls = 0;
	const hook = record
		? (id: string, v: unknown, how = 'r'): unknown => {
				const rec = { id, how, print: fingerprint(v, roots) };
				all.text(`${id}\u0000${how}\u0000${rec.print}`);
				if (calls++ < KEPT_CALLS) head.push(rec);
				return v;
			}
		: (_id: string, v: unknown): unknown => v;
	(globalThis as unknown as Record<symbol, unknown>)[TWIN] = hook;
	return () => ({ calls, hash: all.hex(), head });
}

/** Where two twin runs first differ (null: the same calls, the same values). */
export function twin_difference(a: TwinSummary, b: TwinSummary): string | null {
	if (a.calls === b.calls && a.hash === b.hash) return null;
	const n = Math.min(a.head.length, b.head.length);
	for (let i = 0; i < n; i++) {
		const x = a.head[i];
		const y = b.head[i];
		if (x.id !== y.id || x.how !== y.how || x.print !== y.print) {
			const what = (r: TwinRecord) =>
				r.how === 't' ? 'threw' : r.how === 'c' ? 'built a different object' : 'returned';
			return x.how !== y.how
				? `call ${i + 1} ${what(x)} on the original and ${what(y)} with the mutant`
				: `call ${i + 1} ${what(y) === 'returned' ? 'returned a different value' : what(y)} with the mutant`;
		}
	}
	if (a.calls !== b.calls)
		return `the function ran ${a.calls} time(s) on the original and ${b.calls} with the mutant`;
	return `a call after the first ${KEPT_CALLS} gave a different value with the mutant`;
}
