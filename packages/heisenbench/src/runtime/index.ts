import type { ModuleMeta } from '../meta.ts';
import { load_prices, builtin_names, n_log_n } from '../prices.ts';
import type { Prices } from '../prices.ts';
import { array_bytes, object_bytes, string_bytes } from '../layout.ts';
import { DisposeScope } from './dispose.ts';

/*
 * The counting runtime. Everything the instrumented code calls per block or per call lives here and
 * stays cheap: typed arrays indexed by numbers, no Map lookups on the per-block path, no regex.
 *
 * Function ids (fid) are global: a module's functions are numbered from its base. The shadow call
 * stack is an Int32Array of fids. Inclusive steps use per-fid "on stack" counts: a fid's inclusive
 * total grows by the steps run while it is anywhere on the stack, counted once even when recursive.
 * Async functions and generators get a frame object so their part of the stack can be saved on
 * await/yield and restored when they resume.
 */

const SYM = Symbol.for('heisenbench.runtime');
const ROOT = -1;
const NO_CALLER = -2;
export const EMPTY: readonly never[] = Object.freeze([]);

// Originals captured at load, before any wrapping, so the runtime never charges itself.
const object_keys = Object.keys;
const own_symbols = Object.getOwnPropertySymbols;
const is_enumerable = Object.prototype.propertyIsEnumerable;
const reflect_apply = Reflect.apply;
const is_array = Array.isArray;

/** A run counted more steps than its cap (Runtime.cap): it would not have ended on its own. */
export class StepCapError extends Error {
	override name = 'StepCapError';
	cap: number;
	steps: number;

	constructor(cap: number, steps: number) {
		super(`heisenbench: the run went past its step cap of ${cap} steps`);
		this.cap = cap;
		this.steps = steps;
	}
}

export interface ModuleRecord {
	meta: ModuleMeta;
	/** Block counts. */
	c: Float64Array;
	/** Per site: [2i] dynamic bytes, [2i+1] dynamic steps. */
	d: Float64Array;
	/** First fid of the module. */
	f: number;
	/** First built-in site id of the module. */
	b: number;
}

export interface AsyncFrame {
	fid: number;
	/** Stack depth below the frame when it was entered. */
	base: number;
	/** The stack (frame on top) saved at the last suspension. */
	chain: Int32Array | null;
	/** The stack the frame was resumed on top of; restored when it suspends or ends. */
	outer: Int32Array | null;
	running: boolean;
	resumed: boolean;
}

/*
 * Internal tables keyed by number are plain null-prototype dictionaries, not Maps: Map methods are
 * priced built-ins, and the runtime must never charge itself while the measuring window is open.
 */
export type Table = Record<string, number>;

export interface Snapshot {
	modules: Array<{ c: Float64Array; d: Float64Array }>;
	calls: Float64Array;
	incl: Float64Array;
	bsite_steps: Float64Array;
	bsite_calls: Float64Array;
	/** Estimated bytes of the results built-ins made, and how many of the calls made one. */
	bsite_bytes: Float64Array;
	bsite_allocs: Float64Array;
	/** Built-in size units per site (see BUILTIN_UNIT_SHIFT). */
	bunits: Table;
	/** `(caller + 1) * 2^26 + callee` -> count. Caller -1 is the root (uninstrumented code). */
	edges: Table;
	steps: number;
}

export function table(): Table {
	return Object.create(null) as Table;
}

export const EDGE_KEY_SHIFT = 2 ** 26;

/**
 * The receiver of a call site whose receiver the transform could not capture (`site_any`): the
 * wrapper then checks that its caller is the module that announced the site.
 */
export const ANY_RECEIVER: unique symbol = Symbol('heisenbench.any_receiver');
/** The receiver of a site whose `rcv` entry is gone: matches nothing, so nothing is charged. */
const NO_RECEIVER: unique symbol = Symbol('heisenbench.no_receiver');
/**
 * Receiver entries left behind by calls that threw between `rcv` and `site_last` are dropped
 * when this many pile up (a site always finds its own entry on top of any stale ones).
 */
const RECEIVER_LIMIT = 1 << 16;

/**
 * Built-in size units: `site * BUILTIN_UNIT_SHIFT + key id` -> 4 slots at `key * 4`:
 * calls, sum n, sum n log2 n (n when n <= 1, like builtin_cost), sum n^2.
 */
export const BUILTIN_UNIT_SHIFT = 512;

function add_units(t: Table, key: number, n: number): void {
	const k = key * 4;
	t[k] = (t[k] ?? 0) + 1;
	t[k + 1] = (t[k + 1] ?? 0) + n;
	t[k + 2] = (t[k + 2] ?? 0) + n_log_n(n);
	t[k + 3] = (t[k + 3] ?? 0) + n * n;
}

function grow_f64(a: Float64Array, n: number): Float64Array {
	if (a.length >= n) return a;
	const b = new Float64Array(Math.max(n, a.length * 2));
	b.set(a);
	return b;
}

function grow_i32(a: Int32Array, n: number, fill: number): Int32Array {
	if (a.length >= n) return a;
	const b = new Int32Array(Math.max(n, a.length * 2));
	b.fill(fill, a.length);
	b.set(a);
	return b;
}

export class Runtime {
	prices: Prices;
	names: string[];
	name_ids: Map<string, number>;

	modules: ModuleRecord[] = [];
	/** Running total of steps (blocks + dynamic costs). Shared with every module. */
	s = new Float64Array(1);

	fn_count = 0;
	fn_module: Int32Array = new Int32Array(64);
	calls: Float64Array = new Float64Array(64);
	incl: Float64Array = new Float64Array(64);
	start: Float64Array = new Float64Array(64);
	on_stack: Int32Array = new Int32Array(64);
	last_caller: Int32Array = new Int32Array(64).fill(NO_CALLER);
	last_count: Float64Array = new Float64Array(64);
	edges = table();

	bsite_count = 0;
	bsite_name: Int32Array = new Int32Array(64);
	bsite_steps: Float64Array = new Float64Array(64);
	bsite_calls: Float64Array = new Float64Array(64);
	bsite_bytes: Float64Array = new Float64Array(64);
	bsite_allocs: Float64Array = new Float64Array(64);
	/** Built-in keys (`Array.prototype.sort`...); a key's id is its index. */
	bkeys: string[];
	/** Built-in size units per site; see BUILTIN_UNIT_SHIFT. */
	bunits = table();

	stack: Int32Array = new Int32Array(1024);
	depth = 0;
	/** Built-in site announced by the call about to happen (-1: none). */
	site = -1;
	/**
	 * The receiver that site's call was made on (or the function, for `f()` and `f.call()`), or
	 * ANY_RECEIVER with `rx_url` naming the module that made the call.
	 */
	rx: unknown = NO_RECEIVER;
	rx_url = '';
	/** Receivers announced by `rcv`, waiting for their site (`site_last`): a stack keyed by site. */
	rx_site: Int32Array = new Int32Array(64);
	rx_val: unknown[] = [];
	rx_n = 0;
	/** Stack depth at which a built-in wrapper is running (-1: none); nested built-ins are free. */
	bdepth = -1;
	/**
	 * Step cap of the current run: past it, the next function entry or loop iteration throws a
	 * StepCapError (and so does every one after it, so no catch keeps the run going). Infinity
	 * unless the caller sets one (the slow-input search does, per input).
	 */
	cap = Infinity;

	price_spread_key: number;
	price_spread_element: number;
	price_string_char: number;
	price_rest_element: number;
	price_arguments_element: number;

	constructor(prices?: Prices) {
		this.prices = prices ?? load_prices().prices;
		this.names = builtin_names(this.prices);
		this.name_ids = new Map(this.names.map((n, i) => [n, i]));
		this.bkeys = Object.keys(this.prices.builtins);
		const d = this.prices.dynamic;
		this.price_spread_key = d.spread_key;
		this.price_spread_element = d.spread_element;
		this.price_string_char = d.string_char;
		this.price_rest_element = d.rest_element;
		this.price_arguments_element = d.arguments_element;
	}

	// ------------------------------------------------------------ registration

	module(meta: ModuleMeta): {
		c: Float64Array;
		d: Float64Array;
		f: number;
		b: number;
		s: Float64Array;
		r: Runtime;
	} {
		const rec: ModuleRecord = {
			meta,
			c: new Float64Array(meta.blocks.length),
			d: new Float64Array(meta.sites.length * 2),
			f: this.fn_count,
			b: this.bsite_count
		};
		const index = this.modules.length;
		this.modules.push(rec);
		const n = this.fn_count + meta.functions.length;
		this.fn_module = grow_i32(this.fn_module, n, 0);
		this.calls = grow_f64(this.calls, n);
		this.incl = grow_f64(this.incl, n);
		this.start = grow_f64(this.start, n);
		this.on_stack = grow_i32(this.on_stack, n, 0);
		this.last_caller = grow_i32(this.last_caller, n, NO_CALLER);
		this.last_count = grow_f64(this.last_count, n);
		this.fn_module.fill(index, this.fn_count, n);
		this.fn_count = n;
		const m = this.bsite_count + meta.bsites.length;
		this.bsite_name = grow_i32(this.bsite_name, m, -1);
		this.bsite_steps = grow_f64(this.bsite_steps, m);
		this.bsite_calls = grow_f64(this.bsite_calls, m);
		this.bsite_bytes = grow_f64(this.bsite_bytes, m);
		this.bsite_allocs = grow_f64(this.bsite_allocs, m);
		for (let i = 0; i < meta.bsites.length; i++) {
			this.bsite_name[this.bsite_count + i] = this.name_ids.get(meta.bsites[i].name) ?? -1;
		}
		this.bsite_count = m;
		return { c: rec.c, d: rec.d, f: rec.f, b: rec.b, s: this.s, r: this };
	}

	// ------------------------------------------------------------ call stack

	/** The run went past the step cap. */
	over(): never {
		throw new StepCapError(this.cap, this.s[0]);
	}

	enter(fid: number): number {
		if (this.s[0] > this.cap) this.over();
		const d = this.depth;
		const caller = d > 0 ? this.stack[d - 1] : ROOT;
		// A site announces the call made right after it: a counted function was called instead.
		this.site = -1;
		this.calls[fid]++;
		if (this.last_caller[fid] === caller) {
			this.last_count[fid]++;
		} else {
			if (this.last_count[fid] > 0) this.flush_edge(fid);
			this.last_caller[fid] = caller;
			this.last_count[fid] = 1;
		}
		if (this.on_stack[fid]++ === 0) this.start[fid] = this.s[0];
		if (d === this.stack.length) {
			const bigger = new Int32Array(d * 2);
			bigger.set(this.stack);
			this.stack = bigger;
		}
		this.stack[d] = fid;
		this.depth = d + 1;
		return d;
	}

	exit(token: number): void {
		const stack = this.stack;
		const on = this.on_stack;
		const now = this.s[0];
		for (let i = this.depth - 1; i >= token; i--) {
			const f = stack[i];
			if (--on[f] === 0) this.incl[f] += now - this.start[f];
		}
		this.depth = token;
	}

	flush_edge(fid: number): void {
		const key = (this.last_caller[fid] + 1) * EDGE_KEY_SHIFT + fid;
		this.edges[key] = (this.edges[key] ?? 0) + this.last_count[fid];
		this.last_count[fid] = 0;
	}

	/** Replace the stack with `target`, keeping the common prefix (no calls or edges counted). */
	switch_to(target: Int32Array): void {
		const stack = this.stack;
		let p = 0;
		const limit = Math.min(this.depth, target.length);
		while (p < limit && stack[p] === target[p]) p++;
		this.exit(p);
		const now = this.s[0];
		if (target.length > this.stack.length) {
			const bigger = new Int32Array(target.length * 2);
			bigger.set(this.stack.subarray(0, this.depth));
			this.stack = bigger;
		}
		for (let i = p; i < target.length; i++) {
			const f = target[i];
			if (this.on_stack[f]++ === 0) this.start[f] = now;
			this.stack[i] = f;
		}
		this.depth = target.length;
	}

	enter_async(fid: number): AsyncFrame {
		const base = this.depth;
		this.enter(fid);
		return { fid, base, chain: null, outer: null, running: true, resumed: false };
	}

	suspend<T>(fr: AsyncFrame, v: T): T {
		if (!fr.running) return v;
		fr.chain = this.stack.slice(0, this.depth);
		fr.running = false;
		if (fr.resumed) this.switch_to(fr.outer!);
		else this.exit(fr.base);
		return v;
	}

	resume<T>(fr: AsyncFrame, v: T): T {
		if (fr.running) return v;
		fr.outer = this.stack.slice(0, this.depth);
		fr.resumed = true;
		fr.running = true;
		this.switch_to(fr.chain!);
		return v;
	}

	/** The disposal scope of a block with `await using` (dispose.ts). */
	scope(): DisposeScope {
		return new DisposeScope();
	}

	resume_if(fr: AsyncFrame): void {
		if (!fr.running) this.resume(fr, undefined);
	}

	exit_async(fr: AsyncFrame): void {
		if (!fr.running) this.resume(fr, undefined);
		if (fr.resumed) this.switch_to(fr.outer!);
		else this.exit(fr.base);
		fr.running = false;
	}

	/** `for await` source: suspends the frame whenever the loop head awaits. */
	for_await(fr: AsyncFrame, iterable: unknown): AsyncIterable<unknown> {
		const pause = (): void => {
			this.suspend(fr, undefined);
		};
		const src = iterable as {
			[Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
			[Symbol.iterator]?: () => Iterator<unknown>;
		};
		let it: AsyncIterator<unknown>;
		const get_async = src[Symbol.asyncIterator];
		if (typeof get_async === 'function') {
			it = get_async.call(src);
		} else {
			const sync = (src[Symbol.iterator] as () => Iterator<unknown>).call(src);
			it = {
				next: (v?: unknown) => {
					const r = sync.next(v);
					return Promise.resolve(r.value).then((value) => ({ value, done: r.done }));
				},
				return: (v?: unknown) => {
					if (typeof sync.return === 'function') sync.return(v);
					return Promise.resolve({ value: v, done: true as const });
				}
			};
		}
		return {
			[Symbol.asyncIterator]: () => ({
				next(v?: unknown) {
					const p = it.next(v);
					pause();
					return p;
				},
				return(v?: unknown) {
					const p =
						typeof it.return === 'function'
							? it.return(v)
							: Promise.resolve({ value: v, done: true as const });
					pause();
					return p;
				}
			})
		};
	}

	// ------------------------------------------------------------ expression blocks

	/** Optional chain: count the block that runs only when the object is not nullish. */
	opt<T>(c: Float64Array, i: number, price: number, v: T): T {
		if (v != null) {
			c[i]++;
			this.s[0] += price;
		}
		return v;
	}

	/** Optional call with no arguments: counted as a spread of nothing. */
	z(c: Float64Array, i: number, price: number): readonly never[] {
		c[i]++;
		this.s[0] += price;
		return EMPTY;
	}

	/*
	 * Built-in call sites. A priced built-in is charged only when counted code called it directly:
	 * the transform announces the site right before the call (`site_last`, after every argument)
	 * and the receiver the call is made on (`rcv`, where the receiver is evaluated). The wrapper
	 * charges when the site names it and it runs on that receiver. A same-named method of
	 * uncounted code (undici's `headers.get`, a dependency's `join`) that calls the built-in on
	 * another object is not charged, and neither is anything uncounted code calls on its own.
	 */

	/** `R.rcv(k, x).slice(...)`: the receiver of site k, kept until the site is announced. */
	rcv<T>(k: number, x: T): T {
		if (x == null) return x;
		let n = this.rx_n;
		if (n === RECEIVER_LIMIT) n = 0;
		if (n === this.rx_site.length) this.rx_site = grow_i32(this.rx_site, n + 1, 0);
		this.rx_site[n] = k;
		this.rx_val[n] = x;
		this.rx_n = n + 1;
		return x;
	}

	/** The newest receiver kept for site k, removed from the stack. */
	take_rx(k: number): unknown {
		const sites = this.rx_site;
		const vals = this.rx_val;
		for (let i = this.rx_n - 1; i >= 0; i--) {
			if (sites[i] !== k) continue;
			const v = vals[i];
			const n = this.rx_n - 1;
			for (let j = i; j < n; j++) {
				sites[j] = sites[j + 1];
				vals[j] = vals[j + 1];
			}
			vals[n] = undefined;
			this.rx_n = n;
			return v;
		}
		return NO_RECEIVER;
	}

	site_last<T>(k: number, v: T): T {
		this.rx = this.take_rx(k);
		this.site = k;
		return v;
	}

	site_zero(k: number): readonly never[] {
		this.rx = this.take_rx(k);
		this.site = k;
		return EMPTY;
	}

	/**
	 * A site whose receiver could not be captured without changing the code's meaning (inside an
	 * optional chain, after an `await` in the arguments, on `super`): the wrapper checks its caller.
	 */
	site_any<T>(k: number, url: string, v: T): T {
		this.rx = ANY_RECEIVER;
		this.rx_url = url;
		this.site = k;
		return v;
	}

	site_any_zero(k: number, url: string): readonly never[] {
		this.rx = ANY_RECEIVER;
		this.rx_url = url;
		this.site = k;
		return EMPTY;
	}

	// ------------------------------------------------------------ dynamic costs (spec 2 + 4)

	// Per dynamic site, d[2i] holds bytes and d[2i+1] the size units (characters, keys, elements):
	// the report prices units with the site kind's dynamic price, so a price change can recount.

	str(d: Float64Array, i: number, v: string): string {
		const n = v.length;
		d[2 * i] += string_bytes(n);
		d[2 * i + 1] += n;
		this.s[0] += n * this.price_string_char;
		return v;
	}

	spread_obj<T>(d: Float64Array, i: number, o: T): T {
		let n = 0;
		if (o != null) {
			n = object_keys(o).length;
			// Object spread copies own enumerable symbol keys too.
			if (typeof o === 'object' || typeof o === 'function') {
				const syms = own_symbols(o);
				for (let k = 0; k < syms.length; k++) if (reflect_apply(is_enumerable, o, [syms[k]])) n++;
			}
		}
		d[2 * i] += 4 * n;
		d[2 * i + 1] += n;
		this.s[0] += n * this.price_spread_key;
		return o;
	}

	spread_iter(d: Float64Array, i: number, x: Iterable<unknown>): Iterable<unknown> {
		let out: unknown[];
		if (is_array(x)) out = x as unknown[];
		else {
			// Not iterable: the spread itself throws, with the language's own message for where it
			// is (a call's arguments and an array literal word it differently).
			const it = x == null ? undefined : (x as { [Symbol.iterator]?: unknown })[Symbol.iterator];
			if (typeof it !== 'function') return x;
			out = [...x];
		}
		const n = out.length;
		d[2 * i] += 4 * n;
		d[2 * i + 1] += n;
		this.s[0] += n * this.price_spread_element;
		return out;
	}

	rest(d: Float64Array, i: number, n: number): void {
		d[2 * i] += array_bytes(n);
		d[2 * i + 1] += n;
		this.s[0] += n * this.price_rest_element;
	}

	args(d: Float64Array, i: number, n: number): void {
		d[2 * i] += object_bytes(1) + (n > 0 ? 8 + 4 * n : 0);
		d[2 * i + 1] += n;
		this.s[0] += n * this.price_arguments_element;
	}

	// ------------------------------------------------------------ built-ins

	/**
	 * Charge a priced built-in call to its site (called by the wrappers in builtins.ts, which
	 * check that counted code made the call at that site). `key_id` is the built-in's index in
	 * `bkeys` and `n` its size: the size terms are kept per site so a report can be recounted with
	 * other prices (units.ts). `bytes`: the estimated size of what the call allocated for its
	 * result (builtins.ts, result_bytes), 0 for none.
	 */
	charge(site: number, cost: number, key_id = -1, n = 0, bytes = 0): void {
		this.s[0] += cost;
		this.bsite_steps[site] += cost;
		this.bsite_calls[site]++;
		if (bytes > 0) {
			this.bsite_bytes[site] += bytes;
			this.bsite_allocs[site]++;
		}
		if (key_id >= 0) add_units(this.bunits, site * BUILTIN_UNIT_SHIFT + key_id, n);
	}

	// ------------------------------------------------------------ measuring

	reset(): void {
		for (const m of this.modules) {
			m.c.fill(0);
			m.d.fill(0);
		}
		this.s[0] = 0;
		this.calls.fill(0);
		this.incl.fill(0);
		this.start.fill(0);
		this.on_stack.fill(0);
		this.last_caller.fill(NO_CALLER);
		this.last_count.fill(0);
		this.edges = table();
		this.bsite_steps.fill(0);
		this.bsite_calls.fill(0);
		this.bsite_bytes.fill(0);
		this.bsite_allocs.fill(0);
		this.bunits = table();
		this.depth = 0;
		this.rx = NO_RECEIVER;
		for (let i = 0; i < this.rx_n; i++) this.rx_val[i] = undefined;
		this.rx_n = 0;
		this.site = -1;
		this.bdepth = -1;
	}

	snapshot(): Snapshot {
		for (let f = 0; f < this.fn_count; f++) {
			if (this.last_count[f] > 0) this.flush_edge(f);
			this.last_caller[f] = NO_CALLER;
		}
		if (this.depth > 0) this.exit(0);
		return {
			modules: this.modules.map((m) => ({ c: m.c.slice(), d: m.d.slice() })),
			calls: this.calls.slice(0, this.fn_count),
			incl: this.incl.slice(0, this.fn_count),
			bsite_steps: this.bsite_steps.slice(0, this.bsite_count),
			bsite_calls: this.bsite_calls.slice(0, this.bsite_count),
			bsite_bytes: this.bsite_bytes.slice(0, this.bsite_count),
			bsite_allocs: this.bsite_allocs.slice(0, this.bsite_count),
			bunits: { ...this.bunits },
			edges: { ...this.edges },
			steps: this.s[0]
		};
	}
}

function same_table(a: Table, b: Table): boolean {
	const ka = Object.keys(a);
	if (ka.length !== Object.keys(b).length) return false;
	for (const k of ka) if (a[k] !== b[k]) return false;
	return true;
}

export function get_runtime(): Runtime {
	const g = globalThis as unknown as Record<symbol, Runtime | undefined>;
	let rt = g[SYM];
	if (!rt) {
		rt = new Runtime();
		g[SYM] = rt;
	}
	return rt;
}

/** True when two snapshots hold exactly the same counts (the double-run self-check). */
export function same_counts(a: Snapshot, b: Snapshot): boolean {
	if (a.steps !== b.steps) return false;
	const eq = (x: Float64Array, y: Float64Array): boolean => {
		if (x.length !== y.length) return false;
		for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
		return true;
	};
	const n = Math.min(a.modules.length, b.modules.length);
	for (let i = 0; i < n; i++) {
		if (!eq(a.modules[i].c, b.modules[i].c) || !eq(a.modules[i].d, b.modules[i].d)) return false;
	}
	for (let i = n; i < a.modules.length; i++) if (a.modules[i].c.some((v) => v !== 0)) return false;
	for (let i = n; i < b.modules.length; i++) if (b.modules[i].c.some((v) => v !== 0)) return false;
	const m = Math.min(a.calls.length, b.calls.length);
	if (!eq(a.calls.subarray(0, m), b.calls.subarray(0, m))) return false;
	if (!eq(a.incl.subarray(0, m), b.incl.subarray(0, m))) return false;
	const k = Math.min(a.bsite_steps.length, b.bsite_steps.length);
	if (!eq(a.bsite_steps.subarray(0, k), b.bsite_steps.subarray(0, k))) return false;
	if (!eq(a.bsite_bytes.subarray(0, k), b.bsite_bytes.subarray(0, k))) return false;
	return same_table(a.edges, b.edges) && same_table(a.bunits, b.bunits);
}
