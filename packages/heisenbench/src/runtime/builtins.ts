import { builtin_call_name, builtin_cost } from '../prices.ts';
import type { BuiltinPrice } from '../prices.ts';
import { ANY_RECEIVER } from './index.ts';
import type { Runtime } from './index.ts';
import {
	KNOWN_CONSTRUCTORS,
	array_bytes,
	match_bytes,
	object_bytes,
	string_bytes,
	substring_bytes
} from '../layout.ts';

/*
 * Size-aware prices for engine built-ins (spec 2). While the measuring window is open each priced
 * built-in is replaced by a wrapper that runs the original and charges `base + k * f(n)` steps, where
 * n is the size that drives the built-in's work (array length, string length, output length...).
 *
 * The charge goes to the call site the transform announced right before the call (`R.site_last`),
 * when that site names the same built-in and the call runs on the receiver the site announced
 * (`R.rcv`). Anything else is free: built-ins that uncounted code calls (a dependency, Node's own
 * JavaScript), whatever counted code it was called from, and built-ins called by other built-ins.
 */

/** `from`: what the built-in's START (below) read before the call, for those that have one. */
type Size = (self: unknown, args: unknown[], result: unknown, from?: number) => number;
type Start = (self: unknown, args: unknown[]) => number;

// Originals captured at load: sizing must not go through the wrappers.
const object_keys = Object.keys;
const reflect_apply = Reflect.apply;
const is_array = Array.isArray;

function len(x: unknown): number {
	if (typeof x === 'string') return x.length;
	if (x != null && typeof x === 'object' && typeof (x as { length?: unknown }).length === 'number')
		return (x as { length: number }).length;
	return 0;
}

const this_len: Size = (self) => len(self);
const result_len: Size = (_self, _args, result) => len(result);
const arg0_len: Size = (_self, args) => len(args[0]);
const keys_len: Size = (_self, args) => (args[0] != null ? object_keys(args[0]).length : 0);
const assign_len: Size = (_self, args) => {
	let n = 0;
	for (let i = 1; i < args.length; i++)
		if (args[i] != null) n += object_keys(args[i] as object).length;
	return n;
};
const constant: Size = () => 0;
const join_len: Size = (self, _args, result) => len(self) + len(result);

// Originals for sizing a search whose result does not say where it stopped (`includes`).
const string_index_of = String.prototype.indexOf;
const array_index_of = Array.prototype.indexOf;

function position(v: unknown): number {
	const n = Number(v);
	return n === n ? Math.trunc(n) : 0;
}

/**
 * A forward string search walks from its start to the match (and over the needle), or to the end
 * when there is none, so a scanner hopping `indexOf(x, at)` along a string counts linear, not
 * quadratic. The start is `position`, clamped to the string as the engine clamps it.
 */
const string_search_len: Size = (self, args, result) => {
	const s = String(self);
	const from = Math.min(Math.max(0, position(args[1])), s.length);
	const at =
		typeof result === 'number' ? result : (reflect_apply(string_index_of, s, args) as number);
	return at >= 0 ? at - from + String(args[0]).length : s.length - from;
};

/** Where a regex search starts: `lastIndex` for a global or sticky regex, else 0. */
const regex_start: Start = (self) => {
	const re = self as RegExp;
	return re.global || re.sticky ? re.lastIndex : 0;
};

/**
 * A regex search walks from where it starts to the end of the match, or to the end of the input
 * when there is none, so a `while (re.exec(s))` tokenizer counts linear. A non-global `test`
 * does not say where it matched: the whole input.
 */
const regex_search_len: Size = (self, args, result, from = 0) => {
	const n = String(args[0]).length;
	const start = Math.min(Math.max(0, from), n);
	if (result === null || result === false) return n - start;
	if (result === true) {
		const re = self as RegExp;
		return re.global || re.sticky ? re.lastIndex - start : n;
	}
	const m = result as RegExpExecArray;
	return m.index + m[0].length - start;
};

/** The same for an array search (a negative `fromIndex` counts back from the end). */
const array_search_len: Size = (self, args, result) => {
	const n = len(self);
	const p = position(args[1]);
	const from = p < 0 ? Math.max(0, n + p) : Math.min(p, n);
	const at =
		typeof result === 'number' ? result : (reflect_apply(array_index_of, self, args) as number);
	return at >= 0 ? at - from + 1 : n - from;
};
const result_keys: Size = (_self, _args, result) =>
	result != null && typeof result === 'object' ? object_keys(result).length : 0;

/** Values reachable from `v`, bounded so a huge graph cannot stall the measuring window. */
function graph_size(v: unknown): number {
	const seen = new Set<unknown>();
	const todo: unknown[] = [v];
	let n = 0;
	while (todo.length > 0 && n < 1_000_000) {
		const x = todo.pop();
		n++;
		if (x === null || typeof x !== 'object' || seen.has(x)) continue;
		seen.add(x);
		if (x instanceof Map) {
			for (const [k, val] of x) todo.push(k, val);
		} else if (x instanceof Set) {
			for (const val of x) todo.push(val);
		} else if (is_array(x)) {
			for (let i = 0; i < x.length; i++) todo.push(x[i]);
		} else {
			const keys = object_keys(x);
			for (let i = 0; i < keys.length; i++) todo.push((x as Record<string, unknown>)[keys[i]]);
		}
	}
	return n;
}

/** Estimated bytes of a graph a built-in built new (JSON.parse, structuredClone), bounded. */
function graph_bytes(v: unknown): number {
	const seen = new Set<unknown>();
	const todo: unknown[] = [v];
	let bytes = 0;
	let n = 0;
	while (todo.length > 0 && n < 1_000_000) {
		const x = todo.pop();
		n++;
		if (typeof x === 'string') {
			bytes += string_bytes(x.length);
			continue;
		}
		if (x === null || typeof x !== 'object' || seen.has(x)) continue;
		seen.add(x);
		if (x instanceof Map || x instanceof Set) {
			bytes += x instanceof Map ? KNOWN_CONSTRUCTORS.Map : KNOWN_CONSTRUCTORS.Set;
			for (const e of x instanceof Map ? x : x.values()) todo.push(e);
		} else if (is_array(x)) {
			bytes += array_bytes(x.length);
			for (let i = 0; i < x.length; i++) todo.push(x[i]);
		} else {
			const keys = object_keys(x);
			bytes += object_bytes(keys.length);
			for (let i = 0; i < keys.length; i++) todo.push((x as Record<string, unknown>)[keys[i]]);
		}
	}
	return bytes;
}

/** Built-ins whose string result is a substring of their input (layout.ts, substring_bytes). */
const SUBSTRINGS = new Set([
	'String.prototype.slice',
	'String.prototype.substring',
	'String.prototype.trim'
]);

/**
 * Estimated bytes of what a priced built-in allocated for its result (layout.ts): a new array or
 * string, plus what is new inside it (the strings `split` cuts, the pairs of `Object.entries`, a
 * match's captures, what `JSON.parse` and `structuredClone` build). Nothing for a result the call
 * already had (`sort` returns its array, `Object.assign` its target, `Map#set` the map) or a
 * primitive. Elements an array gets from elsewhere (`map`'s callback results) are counted where
 * they are made.
 */
export function result_bytes(key: string, self: unknown, args: unknown[], result: unknown): number {
	if (result === self || result === args[0] || result == null) return 0;
	if (typeof result === 'string') {
		return SUBSTRINGS.has(key) ? substring_bytes(result.length) : string_bytes(result.length);
	}
	if (typeof result !== 'object') return 0;
	switch (key) {
		case 'JSON.parse':
		case 'structuredClone':
			return graph_bytes(result);
		case 'Object.fromEntries':
			return object_bytes(object_keys(result).length);
	}
	if (!is_array(result)) return 0;
	const list = result as unknown[];
	let bytes = array_bytes(list.length);
	switch (key) {
		case 'String.prototype.split':
			for (let i = 0; i < list.length; i++) bytes += substring_bytes(len(list[i]));
			break;
		case 'RegExp.prototype.exec':
		case 'String.prototype.match': {
			// a match (exec, match without /g) or the list of whole matches (match with /g)
			const is_match = typeof (result as { index?: unknown }).index === 'number';
			if (is_match) bytes += match_bytes(list.length) - array_bytes(list.length);
			for (let i = 0; i < list.length; i++)
				if (typeof list[i] === 'string') bytes += substring_bytes((list[i] as string).length);
			break;
		}
		case 'Object.entries':
			bytes += list.length * array_bytes(2);
			break;
	}
	return bytes;
}

/** What drives each built-in's work. Anything priced but not listed is sized by `this.length`. */
const SIZES: Record<string, Size> = {
	'Array.prototype.slice': result_len,
	'Array.prototype.flat': result_len,
	'Array.prototype.concat': result_len,
	'Array.prototype.join': join_len,
	'Array.from': result_len,
	'String.prototype.slice': result_len,
	'String.prototype.substring': result_len,
	'String.prototype.repeat': result_len,
	'String.prototype.padStart': result_len,
	'String.prototype.padEnd': result_len,
	'String.prototype.indexOf': string_search_len,
	'String.prototype.includes': string_search_len,
	'Array.prototype.indexOf': array_search_len,
	'Array.prototype.includes': array_search_len,
	'String.prototype.startsWith': arg0_len,
	'String.prototype.endsWith': arg0_len,
	'RegExp.prototype.exec': regex_search_len,
	'RegExp.prototype.test': regex_search_len,
	'JSON.stringify': result_len,
	'JSON.parse': arg0_len,
	structuredClone: (_self, args) => graph_size(args[0]),
	'Object.keys': keys_len,
	'Object.values': keys_len,
	'Object.entries': keys_len,
	'Object.assign': assign_len,
	'Object.fromEntries': result_keys,
	'Map.prototype.get': constant,
	'Map.prototype.set': constant,
	'Map.prototype.has': constant,
	'Map.prototype.delete': constant,
	'Set.prototype.add': constant,
	'Set.prototype.has': constant,
	'Set.prototype.delete': constant
};

/** Built-ins whose size depends on state the call changes: read before the call. */
const STARTS: Record<string, Start> = {
	'RegExp.prototype.exec': regex_start,
	'RegExp.prototype.test': regex_start
};

/**
 * The size a priced built-in is charged for (what calibration fits its curve against). `from` is
 * what its START read before the call (a regex's `lastIndex`); 0 when it has none.
 */
export function builtin_size(
	key: string,
	self: unknown,
	args: unknown[],
	result: unknown,
	from = 0
): number {
	return (SIZES[key] ?? this_len)(self, args, result, from);
}

type Frames = Array<{ getFileName(): string | null | undefined }>;
const capture_stack = (Error as { captureStackTrace?: (o: object, f: Function) => void })
	.captureStackTrace;
const frames_of = (_e: Error, frames: Frames): Frames => frames;

/**
 * The script that called `fn` (the URL of an ES module), from V8's structured stack. Only for the
 * call sites whose receiver the transform cannot capture (`site_any`): it costs a stack capture.
 */
function caller_url(fn: Function): string | null {
	if (!capture_stack) return null;
	const E = Error as unknown as { prepareStackTrace?: unknown; stackTraceLimit: number };
	const prepare = E.prepareStackTrace;
	const limit = E.stackTraceLimit;
	E.prepareStackTrace = frames_of;
	E.stackTraceLimit = 1;
	try {
		const holder: { stack?: Frames } = {};
		capture_stack(holder, fn);
		const frames = holder.stack;
		return frames && frames.length > 0 ? (frames[0].getFileName() ?? null) : null;
	} finally {
		E.prepareStackTrace = prepare;
		E.stackTraceLimit = limit;
	}
}

interface Installed {
	owner: Record<string, unknown>;
	prop: string;
	desc: PropertyDescriptor;
}

function resolve_owner(key: string): { owner: Record<string, unknown>; prop: string } | null {
	const parts = key.split('.');
	let owner: unknown = globalThis;
	for (let i = 0; i < parts.length - 1; i++) {
		if (owner == null) return null;
		owner = (owner as Record<string, unknown>)[parts[i]];
	}
	if (owner == null || (typeof owner !== 'object' && typeof owner !== 'function')) return null;
	return { owner: owner as Record<string, unknown>, prop: parts[parts.length - 1] };
}

function make_wrapper(
	rt: Runtime,
	orig: (...args: unknown[]) => unknown,
	key: string,
	name_id: number,
	key_id: number,
	price: BuiltinPrice,
	size: Size,
	start: Start | null
): (...args: unknown[]) => unknown {
	const wrapper = function (this: unknown, ...args: unknown[]): unknown {
		const d = rt.depth;
		const site = rt.site;
		rt.site = -1;
		// Charged only when counted code called this built-in at the site it announced, on the
		// receiver it announced: never for calls uncounted code makes (see Runtime.rcv).
		if (site < 0 || d === 0 || rt.bdepth === d || rt.bsite_name[site] !== name_id)
			return reflect_apply(orig, this, args);
		const rx = rt.rx;
		const prev = rt.bdepth;
		rt.bdepth = d;
		try {
			if (rx === ANY_RECEIVER ? caller_url(wrapper) !== rt.rx_url : this !== rx && rx !== wrapper)
				return reflect_apply(orig, this, args);
			const from = start === null ? 0 : start(this, args);
			const result = reflect_apply(orig, this, args);
			// Sizing and charging run with the guard still up: nothing they touch is charged again.
			const n = size(this, args, result, from);
			const bytes = result_bytes(key, this, args, result);
			rt.charge(site, builtin_cost(price, n), key_id, n, bytes);
			return result;
		} finally {
			rt.bdepth = prev;
		}
	};
	Object.defineProperty(wrapper, 'name', { value: orig.name });
	Object.defineProperty(wrapper, 'length', { value: orig.length });
	return wrapper;
}

export class Builtins {
	#rt: Runtime;
	#installed: Installed[] = [];
	#wrappers: Array<{ owner: Record<string, unknown>; prop: string; desc: PropertyDescriptor }> = [];

	constructor(rt: Runtime) {
		this.#rt = rt;
		for (const [key, price] of Object.entries(rt.prices.builtins)) {
			const at = resolve_owner(key);
			if (!at) continue;
			const desc = Object.getOwnPropertyDescriptor(at.owner, at.prop);
			if (!desc || typeof desc.value !== 'function') continue;
			const name_id = rt.name_ids.get(builtin_call_name(key));
			if (name_id === undefined) continue;
			const key_id = rt.bkeys.indexOf(key);
			const wrapper = make_wrapper(
				rt,
				desc.value,
				key,
				name_id,
				key_id,
				price,
				SIZES[key] ?? this_len,
				STARTS[key] ?? null
			);
			this.#installed.push({ owner: at.owner, prop: at.prop, desc });
			this.#wrappers.push({ owner: at.owner, prop: at.prop, desc: { ...desc, value: wrapper } });
		}
	}

	get runtime(): Runtime {
		return this.#rt;
	}

	install(): void {
		for (const w of this.#wrappers) Object.defineProperty(w.owner, w.prop, w.desc);
	}

	uninstall(): void {
		for (const o of this.#installed) Object.defineProperty(o.owner, o.prop, o.desc);
	}
}
