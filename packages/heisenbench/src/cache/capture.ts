import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Runtime, Snapshot } from '../runtime/index.ts';
import { VIRTUAL_ROOT } from '../runtime/determinism.ts';
import { GENERATION } from '../loader/core.ts';

/*
 * What a case depended on, watched while it runs (incremental counting, cache/index.ts):
 *
 *   modules   every file the case's own fresh copies loaded, and every file loaded once for the
 *             whole process (CommonJS, which is cached by file name, and every module under
 *             `--state shared`): the load hook below sees `import` and `require`
 *   files     every file read, statted or listed through node:fs, inside the window or out of it
 *             (a fixture `setup` reads is an input of the case), by the case or while the bench
 *             files loaded; the real path of every module Node's resolver found
 *   ran       per counted module, the functions that ran a block: while the bench file loads,
 *             in `setup`, in the measured runs and in `teardown`
 *
 * What another case loaded or read is not this case's: with fresh module state, it reaches this
 * case only through global state, which no key sees (docs/how-counting-works.md). More than a
 * case needs is a key that misses more often, never one that hits wrongly.
 */

const SYM = Symbol.for('heisenbench.cache.capture');

/** `real`: where a path leads (Node's resolver asks for the real path of every module it finds). */
export type IoOp = 'read' | 'stat' | 'list' | 'real';

interface Watch {
	/** Modules loaded as a fresh copy (`?heisenbench_gen=`), in order: each case loads its own. */
	fresh: string[];
	/** Modules loaded once for the whole process (CommonJS, and everything under `--state shared`). */
	shared: Set<string>;
	/** `span`: the case it happened in (0: between cases, while the bench files load). */
	io: Array<{ op: IoOp; arg: unknown; cwd: string; span: number }>;
	span: number;
	busy: number;
}

const READS: Record<string, IoOp> = {
	readFileSync: 'read',
	readFile: 'read',
	openSync: 'read',
	open: 'read',
	createReadStream: 'read',
	existsSync: 'stat',
	exists: 'stat',
	statSync: 'stat',
	stat: 'stat',
	lstatSync: 'stat',
	lstat: 'stat',
	accessSync: 'stat',
	access: 'stat',
	realpathSync: 'real',
	realpath: 'real',
	readdirSync: 'list',
	readdir: 'list',
	opendirSync: 'list',
	opendir: 'list'
};

type Fn = (...args: unknown[]) => unknown;

function wrap(owner: Record<string, unknown>, name: string, op: IoOp, w: Watch): void {
	const orig = owner[name];
	if (typeof orig !== 'function') return;
	const fn = orig as Fn;
	const wrapped = function (this: unknown, ...args: unknown[]): unknown {
		if (w.busy === 0 && args.length > 0) {
			const io = w.io;
			io[io.length] = { op, arg: args[0], cwd: process.cwd(), span: w.span };
		}
		return Reflect.apply(fn, this, args);
	};
	// realpathSync.native and friends
	for (const k of Object.keys(fn))
		(wrapped as unknown as Record<string, unknown>)[k] = (fn as unknown as Record<string, unknown>)[
			k
		];
	owner[name] = wrapped;
}

/** The process-wide watch: installed once, before the bench files load. */
function watch(): Watch {
	const g = globalThis as unknown as Record<symbol, Watch | undefined>;
	const have = g[SYM];
	if (have) return have;
	const w: Watch = { fresh: [], shared: new Set(), io: [], span: 0, busy: 0 };
	g[SYM] = w;
	registerHooks({
		load(url, context, next) {
			// the loader reading a module's source is not the case reading a file: the module's
			// entry has its bytes
			w.busy++;
			let r: ReturnType<typeof next>;
			try {
				r = next(url, context);
			} finally {
				w.busy--;
			}
			if (url.startsWith('file:')) {
				const q = url.indexOf('?');
				const path = fileURLToPath(q === -1 ? url : url.slice(0, q));
				// CommonJS is cached by file name: loaded once, it serves every later case
				const cjs = typeof r.format === 'string' && r.format.startsWith('commonjs');
				if (!cjs && q !== -1 && url.includes(GENERATION, q)) w.fresh.push(path);
				else w.shared.add(path);
			}
			return r;
		}
	});
	const sync = fs as unknown as Record<string, unknown>;
	const promises = fs.promises as unknown as Record<string, unknown>;
	for (const [name, op] of Object.entries(READS)) {
		wrap(sync, name, op, w);
		wrap(promises, name, op, w);
	}
	syncBuiltinESMExports();
	return w;
}

export interface Observed {
	/** Absolute paths of every file loaded so far. */
	loaded: string[];
	/** Every fs read so far, as absolute paths. */
	io: Array<{ op: IoOp; path: string }>;
	/** Absolute file of each counted module -> paths of the functions that ran. */
	ran: Map<string, Set<string>>;
}

function path_of(arg: unknown, cwd: string, root: string): string | null {
	let p: string | null = null;
	if (typeof arg === 'string') p = arg;
	else if (arg instanceof URL) p = arg.protocol === 'file:' ? fileURLToPath(arg) : null;
	else if (Buffer.isBuffer(arg)) p = arg.toString('utf8');
	if (p === null) return null;
	if (p.startsWith('file:')) p = fileURLToPath(p);
	const base = cwd === VIRTUAL_ROOT ? root : cwd;
	if (p === VIRTUAL_ROOT || p.startsWith(VIRTUAL_ROOT + '/'))
		p = root + p.slice(VIRTUAL_ROOT.length);
	return isAbsolute(p) ? resolve(p) : resolve(base, p);
}

let spans = 0;

export class Capture {
	readonly root: string;
	readonly rt: Runtime;
	/** Each case runs on fresh copies of its modules (the default; `--state shared` is false). */
	readonly fresh: boolean;
	#w: Watch;
	#ran = new Map<string, Set<string>>();
	/** Where the current case's fresh loads start. */
	#from = 0;

	constructor(rt: Runtime, root: string, fresh: boolean) {
		this.rt = rt;
		this.root = root;
		this.fresh = fresh;
		this.#w = watch();
	}

	/** Reads of the cache itself are not the case's. */
	quiet<T>(f: () => T): T {
		this.#w.busy++;
		try {
			return f();
		} finally {
			this.#w.busy--;
		}
	}

	/**
	 * A case starts: the counters start from zero, so what ran before it (the previous case's
	 * teardown) is not taken for its own. The measured window resets them again; nothing counted
	 * here reaches a report.
	 */
	begin_case(): void {
		this.#ran = new Map();
		this.#from = this.#w.fresh.length;
		this.#w.span = ++spans;
		this.rt.reset();
	}

	#add(index: number, c: Float64Array): void {
		const m = this.rt.modules[index];
		if (!m) return;
		let set: Set<string> | undefined;
		const blocks = m.meta.blocks;
		const fns = m.meta.functions;
		for (let k = 0; k < c.length; k++) {
			if (c[k] === 0) continue;
			if (!set) {
				set = this.#ran.get(m.meta.file);
				if (!set) this.#ran.set(m.meta.file, (set = new Set()));
			}
			set.add(fns[blocks[k].fn].path);
		}
	}

	/** What ran since the last reset (loading the bench file, setup): before the window resets it. */
	before_window(): void {
		this.rt.modules.forEach((m, i) => this.#add(i, m.c));
	}

	/** What the window ran. */
	after_window(snap: Snapshot): void {
		snap.modules.forEach((m, i) => this.#add(i, m.c));
	}

	/**
	 * What the case that just ran depended on: the modules its fresh copies loaded (all of them,
	 * when cases share one copy) and every module loaded once for the process; what it read, and
	 * what was read outside any case (while the bench files loaded). The case ends here.
	 */
	observed(): Observed {
		const w = this.#w;
		const loaded = [...new Set([...w.shared, ...w.fresh.slice(this.fresh ? this.#from : 0)])];
		const span = w.span;
		w.span = 0;
		const seen = new Set<string>();
		const io: Observed['io'] = [];
		for (const r of w.io) {
			if (r.span !== 0 && r.span !== span) continue;
			const path = path_of(r.arg, r.cwd, this.root);
			if (path === null) continue;
			const k = `${r.op}\0${path}`;
			if (seen.has(k)) continue;
			seen.add(k);
			io.push({ op: r.op, path });
		}
		const ran = new Map<string, Set<string>>();
		for (const [f, s] of this.#ran) ran.set(f, new Set(s));
		return { loaded, io, ran };
	}
}
