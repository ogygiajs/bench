import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * The deterministic environment of the measuring window (spec 3).
 *
 * - Clock: Date, Date.now, performance.now and process.hrtime read a virtual clock that advances a
 *   fixed step per read, from a fixed epoch.
 * - Randomness: Math.random, crypto.getRandomValues / randomUUID / randomBytes / randomInt come from
 *   one seeded generator.
 * - Timers: setTimeout / setInterval / setImmediate go to a fake loop run in (due time, creation
 *   order) by `settle()`, which also moves the virtual clock to each timer's due time.
 * - IO: the warm-up run records fs reads and fetch responses; measured runs replay them. Anything
 *   not recorded, any write, and any socket (http, https, net) throws inside the window.
 * - FinalizationRegistry callbacks are queued and only run at fixed points (`drain_finalizers`,
 *   outside the window); WeakRefs made inside the window hold their target, so deref never changes.
 *
 * Code here runs while instrumented code is on the stack, so it avoids the priced built-ins
 * (no sort/splice/slice/map/Map/Set): their wrappers would charge the measured function.
 */

const require = createRequire(import.meta.url);

type Fn = (...args: never[]) => unknown;
type Obj = Record<string, unknown>;

export type IoMode = 'record' | 'replay';

export class AbaxIoError extends Error {
	override name = 'AbaxIoError';
}

interface Patch {
	owner: Obj;
	prop: string;
	desc: PropertyDescriptor | undefined;
}

interface FakeTimer {
	id: number;
	due: number;
	seq: number;
	fn: Fn;
	args: unknown[];
	interval: number;
	active: boolean;
}

export interface DeterminismOptions {
	seed?: number;
	/** Virtual epoch in ms (default 2024-01-01T00:00:00Z). */
	epoch?: number;
	/** Virtual ms each clock read advances (default 1). */
	step?: number;
	/** Fake-loop iteration cap per settle (default 100000): runaway intervals end the run. */
	max_timer_runs?: number;
	/**
	 * The run root. Inside the window `process.cwd()` (and `PWD`) name it as VIRTUAL_ROOT, so code
	 * that slices or compares the working directory counts the same in every checkout. File reads
	 * of VIRTUAL_ROOT paths go to the root.
	 */
	root?: string;
}

/** Where the run root appears to be inside the measuring window: the same on every machine. */
export const VIRTUAL_ROOT = sep === '\\' ? 'C:\\abax\\root' : '/abax/root';

/** `real` (under `root`) as the window shows it, or null when it is outside the root. */
export function virtual_path(real: string, root: string): string | null {
	if (real === root) return VIRTUAL_ROOT;
	const prefix = root.endsWith(sep) ? root : root + sep;
	return real.startsWith(prefix) ? VIRTUAL_ROOT + sep + real.slice(prefix.length) : null;
}

/** A path argument as the real file system knows it (VIRTUAL_ROOT paths moved to `root`). */
export function real_path(p: unknown, root: string): unknown {
	const s = p instanceof URL && p.protocol === 'file:' ? fileURLToPath(p) : p;
	if (typeof s !== 'string') return p;
	if (s === VIRTUAL_ROOT) return root;
	if (s.startsWith(VIRTUAL_ROOT + sep)) return join(root, s.slice(VIRTUAL_ROOT.length + 1));
	return p;
}

const RealDate = Date;
const real_set_immediate = setImmediate;
const real_fetch = globalThis.fetch;
const RealFinalizationRegistry = FinalizationRegistry;

export class Determinism {
	readonly seed: number;
	readonly epoch: number;
	readonly step: number;
	readonly max_timer_runs: number;
	readonly root: string | null;

	#patches: Patch[] = [];
	#open = false;
	#mode: IoMode = 'record';
	#now = 0;
	#rng = new Uint32Array(4);
	#timers: FakeTimer[] = [];
	#timer_seq = 0;
	/** Recorded IO. A null-prototype dictionary: Map methods are priced built-ins. */
	#io: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	#finalizers: Array<() => void> = [];

	constructor(o: DeterminismOptions = {}) {
		this.seed = o.seed ?? 0xabac;
		this.epoch = o.epoch ?? 1_704_067_200_000;
		this.step = o.step ?? 1;
		this.max_timer_runs = o.max_timer_runs ?? 100_000;
		this.root = o.root === undefined ? null : resolve(o.root);
	}

	get is_open(): boolean {
		return this.#open;
	}

	/** Recorded IO, for inspection (keys: `fs.readFileSync ["path","utf8"]`, `fetch GET url`). */
	get recorded(): Readonly<Record<string, unknown>> {
		return this.#io;
	}

	// -------------------------------------------------------------- clock + random

	now(): number {
		const t = this.#now;
		this.#now += this.step;
		return t;
	}

	/** sfc32: small, fast, seedable, and identical on every platform. */
	random_u32(): number {
		const s = this.#rng;
		const t = (((s[0] + s[1]) >>> 0) + s[3]) >>> 0;
		s[3] = (s[3] + 1) >>> 0;
		s[0] = s[1] ^ (s[1] >>> 9);
		s[1] = (s[2] + (s[2] << 3)) >>> 0;
		s[2] = (s[2] << 21) | (s[2] >>> 11);
		s[2] = (s[2] + t) >>> 0;
		return t;
	}

	random(): number {
		return this.random_u32() / 4294967296;
	}

	fill_random(bytes: Uint8Array): void {
		for (let i = 0; i < bytes.length; i += 4) {
			let v = this.random_u32();
			for (let j = 0; j < 4 && i + j < bytes.length; j++) {
				bytes[i + j] = v & 0xff;
				v >>>= 8;
			}
		}
	}

	uuid(): string {
		const b = new Uint8Array(16);
		this.fill_random(b);
		b[6] = (b[6] & 0x0f) | 0x40;
		b[8] = (b[8] & 0x3f) | 0x80;
		let hex = '';
		for (let i = 0; i < 16; i++) {
			hex += (b[i] < 16 ? '0' : '') + b[i].toString(16);
			if (i === 3 || i === 5 || i === 7 || i === 9) hex += '-';
		}
		return hex;
	}

	reset(): void {
		this.#now = 0;
		this.#rng[0] = this.seed;
		this.#rng[1] = 0x9e3779b9;
		this.#rng[2] = 0x243f6a88;
		this.#rng[3] = 1;
		for (let i = 0; i < 12; i++) this.random_u32();
		this.#timers.length = 0;
		this.#timer_seq = 0;
	}

	// -------------------------------------------------------------- window

	open(mode: IoMode): void {
		if (this.#open) throw new Error('abax: measuring window already open');
		this.reset();
		this.#mode = mode;
		this.#open = true;
		try {
			this.#patch_clock();
			this.#patch_random();
			this.#patch_timers();
			this.#patch_io();
			this.#patch_weak();
			this.#patch_paths();
			syncBuiltinESMExports();
		} catch (e) {
			this.close();
			throw e;
		}
	}

	close(): void {
		if (!this.#open) return;
		for (let i = this.#patches.length - 1; i >= 0; i--) {
			const p = this.#patches[i];
			if (p.desc && !p.desc.configurable) p.owner[p.prop] = p.desc.value;
			else if (p.desc) Object.defineProperty(p.owner, p.prop, p.desc);
			else delete p.owner[p.prop];
		}
		this.#patches.length = 0;
		this.#open = false;
		syncBuiltinESMExports();
	}

	#set(owner: Obj, prop: string, value: unknown): void {
		const desc = Object.getOwnPropertyDescriptor(owner, prop);
		if (desc && !desc.configurable) {
			// A frozen binding (node:crypto getRandomValues is one): assign when writable, else leave it.
			if (!desc.writable) return;
			this.#patches.push({ owner, prop, desc: { ...desc } });
			owner[prop] = value;
			return;
		}
		this.#patches.push({ owner, prop, desc });
		Object.defineProperty(owner, prop, {
			value,
			writable: true,
			configurable: true,
			enumerable: desc ? desc.enumerable : false
		});
	}

	#patch_clock(): void {
		const now = (): number => this.now();
		const epoch = this.epoch;
		function FrozenDate(this: unknown, ...args: unknown[]): unknown {
			if (!new.target) return new RealDate(epoch + now()).toString();
			const a = args.length === 0 ? [epoch + now()] : args;
			return Reflect.construct(RealDate, a, new.target);
		}
		Object.setPrototypeOf(FrozenDate, RealDate);
		FrozenDate.prototype = RealDate.prototype;
		Object.defineProperty(FrozenDate, 'now', {
			value: () => epoch + Math.floor(now()),
			writable: true,
			configurable: true
		});
		this.#set(globalThis as unknown as Obj, 'Date', FrozenDate);
		this.#set(performance as unknown as Obj, 'now', now);
		const hrtime = (prev?: [number, number]): [number, number] => {
			const ns = Math.round(now() * 1e6);
			let s = Math.floor(ns / 1e9);
			let n = ns - s * 1e9;
			if (prev) {
				s -= prev[0];
				n -= prev[1];
				if (n < 0) {
					s--;
					n += 1e9;
				}
			}
			return [s, n];
		};
		Object.defineProperty(hrtime, 'bigint', {
			value: () => BigInt(Math.round(now() * 1e6))
		});
		this.#set(process as unknown as Obj, 'hrtime', hrtime);
	}

	#patch_random(): void {
		const random = (): number => this.random();
		const uuid = (): string => this.uuid();
		const fill = (view: ArrayBufferView): void =>
			this.fill_random(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
		this.#set(Math as unknown as Obj, 'random', random);
		const get_random_values = <T extends ArrayBufferView | null>(view: T): T => {
			if (view) fill(view);
			return view;
		};
		const web = globalThis.crypto as unknown as Obj | undefined;
		if (web) {
			this.#set(web, 'getRandomValues', get_random_values);
			this.#set(web, 'randomUUID', uuid);
		}
		const node_crypto = require('node:crypto') as Obj;
		this.#set(node_crypto, 'randomUUID', uuid);
		this.#set(node_crypto, 'getRandomValues', get_random_values);
		this.#set(node_crypto, 'randomBytes', (size: number, cb?: (e: null, b: Buffer) => void) => {
			const b = Buffer.alloc(size);
			fill(b);
			if (cb) {
				queueMicrotask(() => cb(null, b));
				return undefined;
			}
			return b;
		});
		this.#set(node_crypto, 'randomFillSync', <T extends ArrayBufferView>(view: T): T => {
			fill(view);
			return view;
		});
		this.#set(node_crypto, 'randomInt', (a: number, b?: number) => {
			const lo = b === undefined ? 0 : a;
			const hi = b === undefined ? a : b;
			return lo + Math.floor(random() * (hi - lo));
		});
	}

	// -------------------------------------------------------------- fake event loop

	#add_timer(fn: Fn, delay: unknown, args: unknown[], interval: boolean): FakeTimer {
		const ms = Math.max(1, Number(delay) || 0);
		const t: FakeTimer = {
			id: ++this.#timer_seq,
			due: this.#now + ms,
			seq: this.#timer_seq,
			fn,
			args,
			interval: interval ? ms : 0,
			active: true
		};
		this.#insert(t);
		return t;
	}

	/** Keep the queue ordered by (due, seq) with plain loops (no priced built-ins). */
	#insert(t: FakeTimer): void {
		const q = this.#timers;
		let i = q.length;
		q.push(t);
		while (i > 0 && (q[i - 1].due > t.due || (q[i - 1].due === t.due && q[i - 1].seq > t.seq))) {
			q[i] = q[i - 1];
			i--;
		}
		q[i] = t;
	}

	#shift(): FakeTimer | undefined {
		const q = this.#timers;
		if (q.length === 0) return undefined;
		const first = q[0];
		for (let i = 1; i < q.length; i++) q[i - 1] = q[i];
		q.length--;
		return first;
	}

	#handle(t: FakeTimer): object {
		const reschedule = (): void => {
			t.due = this.#now + Math.max(1, t.interval);
		};
		return {
			ref() {
				return this;
			},
			unref() {
				return this;
			},
			hasRef() {
				return true;
			},
			refresh() {
				reschedule();
				return this;
			},
			close() {
				t.active = false;
				return this;
			},
			[Symbol.toPrimitive]() {
				return t.id;
			},
			__abax_timer: t
		};
	}

	#clear(h: unknown): void {
		if (h && typeof h === 'object' && '__abax_timer' in h) {
			(h as { __abax_timer: FakeTimer }).__abax_timer.active = false;
			return;
		}
		const q = this.#timers;
		for (let i = 0; i < q.length; i++) if (q[i].id === h) q[i].active = false;
	}

	#patch_timers(): void {
		const set_timeout = (fn: Fn, delay?: unknown, ...args: unknown[]) =>
			this.#handle(this.#add_timer(fn, delay, args, false));
		const set_interval = (fn: Fn, delay?: unknown, ...args: unknown[]) =>
			this.#handle(this.#add_timer(fn, delay, args, true));
		const set_immediate = (fn: Fn, ...args: unknown[]) => {
			const t = this.#add_timer(fn, 0, args, false);
			t.due = this.#now;
			return this.#handle(t);
		};
		const clear = (h: unknown) => this.#clear(h);
		const timers = require('node:timers') as Obj;
		for (const owner of [globalThis as unknown as Obj, timers]) {
			this.#set(owner, 'setTimeout', set_timeout);
			this.#set(owner, 'setInterval', set_interval);
			this.#set(owner, 'setImmediate', set_immediate);
			this.#set(owner, 'clearTimeout', clear);
			this.#set(owner, 'clearInterval', clear);
			this.#set(owner, 'clearImmediate', clear);
		}
	}

	/**
	 * Run every pending fake timer in order, draining microtasks between them, until the queue is
	 * empty and `done()` says the measured work finished. Work that waits on nothing the fake loop
	 * controls (a real socket, a never-resolved promise) ends the run after `idle_limit` turns.
	 */
	async settle(
		done: () => boolean = () => true,
		idle_limit = 1000
	): Promise<{ timers: number; runaway: boolean; stuck: boolean }> {
		let runs = 0;
		let idle = 0;
		for (;;) {
			await new Promise<void>((resolve) => real_set_immediate(resolve));
			const t = this.#shift();
			if (!t) {
				if (done()) return { timers: runs, runaway: false, stuck: false };
				if (++idle > idle_limit) return { timers: runs, runaway: false, stuck: true };
				continue;
			}
			idle = 0;
			if (!t.active) continue;
			if (++runs > this.max_timer_runs) {
				this.#timers.length = 0;
				return { timers: runs, runaway: true, stuck: false };
			}
			if (t.due > this.#now) this.#now = t.due;
			if (t.interval > 0) {
				t.due = this.#now + t.interval;
				t.seq = ++this.#timer_seq;
				this.#insert(t);
			} else {
				t.active = false;
			}
			Reflect.apply(t.fn, undefined, t.args);
		}
	}

	// -------------------------------------------------------------- IO record / replay

	#io_key(name: string, args: unknown[]): string {
		let key = name;
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			if (typeof a === 'function') continue;
			key += ' ' + (a instanceof URL ? a.href : JSON.stringify(a));
		}
		return key;
	}

	#patch_io(): void {
		const io = this.#io;
		const key_of = (name: string, args: unknown[]): string => this.#io_key(name, args);
		const recording = (): boolean => this.#mode === 'record';
		const fs = require('node:fs') as Obj;
		const fsp = fs.promises as Obj;
		const reads = new Set(['readFileSync', 'existsSync', 'readdirSync']);
		const copy = (v: unknown): unknown => (Buffer.isBuffer(v) ? Buffer.from(v) : v);
		const blocked = (name: string) => () => {
			throw new AbaxIoError(`abax: ${name} inside the measuring window`);
		};
		// A read that failed while recording (a missing file) fails the same way when replayed.
		const failed = (e: unknown): { abax_io_error: unknown } => ({ abax_io_error: e });
		const replay = (key: string): unknown => {
			if (!(key in io)) throw new AbaxIoError(`abax: unrecorded ${key}`);
			const v = io[key];
			if (v !== null && typeof v === 'object' && 'abax_io_error' in v)
				throw (v as { abax_io_error: unknown }).abax_io_error;
			return copy(v);
		};
		const root = this.root;
		// Paths under VIRTUAL_ROOT (built from process.cwd() in the window) read the real root.
		const real = (args: unknown[]): unknown[] => {
			if (root === null || args.length === 0) return args;
			const out = [real_path(args[0], root)];
			for (let i = 1; i < args.length; i++) out.push(args[i]);
			return out;
		};
		for (const name of Object.keys(fs)) {
			const orig = fs[name];
			if (typeof orig !== 'function' || name[0] < 'a' || name[0] > 'z') continue;
			if (name === 'promises') continue;
			if (reads.has(name)) {
				this.#set(fs, name, (...args: unknown[]) => {
					const key = key_of(`fs.${name}`, args);
					if (recording()) {
						let v: unknown;
						try {
							v = Reflect.apply(orig as Fn, fs, real(args) as never[]);
						} catch (e) {
							io[key] = failed(e);
							throw e;
						}
						io[key] = copy(v);
						return v;
					}
					return replay(key);
				});
			} else if (name === 'readFile') {
				this.#set(fs, name, (...args: unknown[]) => {
					const cb = args[args.length - 1] as (e: unknown, v?: unknown) => void;
					const rest: unknown[] = [];
					for (let i = 0; i < args.length - 1; i++) rest.push(args[i]);
					const key = key_of('fs.readFile', rest);
					if (recording()) {
						return Reflect.apply(orig as Fn, fs, [
							...real(rest),
							(e: unknown, v: unknown) => {
								io[key] = e ? failed(e) : copy(v);
								cb(e, v);
							}
						] as never[]);
					}
					let v: unknown;
					try {
						v = replay(key);
					} catch (e) {
						queueMicrotask(() => cb(e));
						return undefined;
					}
					queueMicrotask(() => cb(null, v));
					return undefined;
				});
			} else if (!recording()) {
				this.#set(fs, name, blocked(`fs.${name}`));
			}
		}
		const read_file = fsp.readFile as Fn;
		this.#set(fsp, 'readFile', async (...args: unknown[]) => {
			const key = key_of('fs.readFile', args);
			if (recording()) {
				let v: unknown;
				try {
					v = await Reflect.apply(read_file, fsp, real(args) as never[]);
				} catch (e) {
					io[key] = failed(e);
					throw e;
				}
				io[key] = copy(v);
				return v;
			}
			return replay(key);
		});
		if (this.#mode === 'replay') {
			for (const name of Object.keys(fsp)) {
				if (name === 'readFile' || typeof fsp[name] !== 'function') continue;
				this.#set(fsp, name, async () => blocked(`fs.promises.${name}`)());
			}
		}
		if (typeof real_fetch === 'function') {
			this.#set(
				globalThis as unknown as Obj,
				'fetch',
				async (input: unknown, init?: RequestInit) => {
					const req = new Request(input as RequestInfo, init);
					const key = `fetch ${req.method} ${req.url}`;
					if (recording()) {
						const res = await real_fetch(req);
						const body = await res.clone().arrayBuffer();
						io[key] = {
							status: res.status,
							statusText: res.statusText,
							headers: [...res.headers],
							body
						};
						return res;
					}
					const rec = io[key] as
						| {
								status: number;
								statusText: string;
								headers: Array<[string, string]>;
								body: ArrayBuffer;
						  }
						| undefined;
					if (!rec) throw new AbaxIoError(`abax: unrecorded ${key}`);
					return new Response(rec.status === 204 ? null : rec.body.slice(0), {
						status: rec.status,
						statusText: rec.statusText,
						headers: rec.headers
					});
				}
			);
		}
		for (const mod of ['node:http', 'node:https', 'node:net', 'node:tls']) {
			const m = require(mod) as Obj;
			for (const name of ['request', 'get', 'connect', 'createConnection']) {
				if (typeof m[name] === 'function') this.#set(m, name, blocked(`${mod} ${name}`));
			}
		}
	}

	// -------------------------------------------------------------- paths

	/** The working directory as VIRTUAL_ROOT (when it is inside the run root). */
	#patch_paths(): void {
		if (this.root === null) return;
		const cwd = virtual_path(process.cwd(), this.root);
		if (cwd === null) return;
		this.#set(process as unknown as Obj, 'cwd', () => cwd);
		if (process.env.PWD !== undefined) this.#set(process.env as unknown as Obj, 'PWD', cwd);
	}

	// -------------------------------------------------------------- weak references

	#patch_weak(): void {
		const pending = this.#finalizers;
		class AbaxWeakRef<T extends WeakKey> {
			#target: T;
			constructor(target: T) {
				this.#target = target;
			}
			deref(): T {
				return this.#target;
			}
			get [Symbol.toStringTag](): string {
				return 'WeakRef';
			}
		}
		class AbaxFinalizationRegistry<H> {
			#inner: FinalizationRegistry<H>;
			constructor(cb: (held: H) => void) {
				this.#inner = new RealFinalizationRegistry<H>((held) => {
					pending.push(() => cb(held));
				});
			}
			register(target: WeakKey, held: H, token?: WeakKey): void {
				this.#inner.register(target, held, token);
			}
			unregister(token: WeakKey): boolean {
				return this.#inner.unregister(token);
			}
			get [Symbol.toStringTag](): string {
				return 'FinalizationRegistry';
			}
		}
		this.#set(globalThis as unknown as Obj, 'WeakRef', AbaxWeakRef);
		this.#set(globalThis as unknown as Obj, 'FinalizationRegistry', AbaxFinalizationRegistry);
	}

	/** Run finalizer callbacks queued so far. Called by the runner between runs, never inside. */
	drain_finalizers(): number {
		const list = this.#finalizers.splice(0);
		for (const f of list) f();
		return list.length;
	}
}
