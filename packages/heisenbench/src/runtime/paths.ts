import { createRequire, syncBuiltinESMExports } from 'node:module';
import Module from 'node:module';
import { dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GENERATION } from '../loader/core.ts';
import { OWN_DIR } from '../own.ts';
import { VIRTUAL_ROOT, real_path, virtual_path } from './determinism.ts';

/*
 * Where the counted code lives, as it sees it: under VIRTUAL_ROOT, on every machine and at every
 * depth. Code that splits, joins, slices or matches its own path does work per character and per
 * directory, so a count made from the real path depends on where the checkout is
 * (`heisenbench@0.0.0`'s transform writes its runtime's URL into every module it makes: one
 * function counted 1,496 more steps under a 182-character root than under a 46-character one).
 *
 * Every path the counted world can read names the root as VIRTUAL_ROOT
 * (`file:///heisenbench/root/src/lib.ts`), without the fresh-copy query (`?heisenbench_gen=N`):
 *
 *   import.meta   url, filename, dirname and what resolve() returns (the transform rewrites
 *                 `import.meta` in counted modules and bench files to the module's `meta()`)
 *   CommonJS      __filename, __dirname, and require.resolve
 *   createRequire of a virtual path or URL: a require whose resolve answers virtual paths
 *   stacks        every `error.stack` (Error.prepareStackTrace)
 *   cwd           process.cwd() called from a module of the root (inside the measuring window
 *                 always: Determinism)
 *   fs            a virtual path in reads the real file; what realpath, readdir and a failed call
 *                 say about it comes back virtual
 *
 * and every way back to the disk maps a virtual path to the real one: fs, import() and require of
 * a virtual URL or path (the loader's resolve hook), createRequire. A real path in stays real: code
 * that got one elsewhere (process.argv, os.tmpdir()) gets real answers.
 *
 * Installed once per process, for one root, by the counting loader (register_heisenbench), before
 * any counted module loads. Paths outside the root keep their real form, the query dropped.
 *
 * Code here runs while counted code is on the stack (a getter of import.meta, a stack being
 * formatted), so its hot path avoids the priced built-ins, as the runtime does.
 */

type Fn = (...args: unknown[]) => unknown;
type Obj = Record<string, unknown>;

export const PATHS = Symbol.for('heisenbench.paths');

/** What counted code reaches through `globalThis[Symbol.for('heisenbench.paths')]`. */
export interface PathsService {
	root: string;
	/** A module's `import.meta`, as the counted world shows it (one object per module). */
	meta(real: ImportMeta): ImportMeta;
	/** A CommonJS module's `__filename` or `__dirname`. */
	path(real: string): string;
	/** A CommonJS module's `require`, whose resolve answers virtual paths. */
	require(real: NodeJS.Require): NodeJS.Require;
}

let installed: PathsService | null = null;

/** The service, once installed. */
export function paths(): PathsService | null {
	return installed;
}

const VIRTUAL_URL = pathToFileURL(VIRTUAL_ROOT).href;

/** `s` without the fresh-copy query (`?heisenbench_gen=N`, or `&heisenbench_gen=N` after another). */
export function drop_generation(s: string): string {
	let at = s.indexOf(GENERATION);
	while (at > 0) {
		const before = s[at - 1];
		let end = at + GENERATION.length;
		while (end < s.length && s.charCodeAt(end) >= 48 && s.charCodeAt(end) <= 57) end++;
		if (before === '?' || before === '&') {
			// `?gen&x=1` keeps `?x=1`; `?a=1&gen` keeps `?a=1`
			const keep_q = before === '?' && s[end] === '&';
			s = s.slice(0, at - 1) + (keep_q ? '?' : '') + s.slice(keep_q ? end + 1 : end);
			at = s.indexOf(GENERATION, at - 1);
		} else {
			at = s.indexOf(GENERATION, end);
		}
	}
	return s;
}

/** A real file URL as the counted world sees it: under the virtual root when it is in `root`. */
export function virtual_url(url: string, root: string): string {
	const u = drop_generation(url);
	if (!u.startsWith('file:')) return u;
	const q = first_of(u, '?', '#');
	let file: string;
	try {
		file = fileURLToPath(q === -1 ? u : u.slice(0, q));
	} catch {
		return u;
	}
	const v = virtual_path(file, root);
	if (v === null) return u;
	return pathToFileURL(v).href + (q === -1 ? '' : u.slice(q));
}

/** A virtual file URL (or path) as the disk knows it; anything else unchanged. */
export function real_url(url: string, root: string): string {
	if (url.startsWith(VIRTUAL_URL)) {
		const q = first_of(url, '?', '#');
		const file = real_path(fileURLToPath(q === -1 ? url : url.slice(0, q)), root) as string;
		return pathToFileURL(file).href + (q === -1 ? '' : url.slice(q));
	}
	if (url === VIRTUAL_ROOT || url.startsWith(VIRTUAL_ROOT + sep))
		return real_path(url, root) as string;
	return url;
}

function first_of(s: string, a: string, b: string): number {
	const i = s.indexOf(a);
	const j = s.indexOf(b);
	return i === -1 ? j : j === -1 ? i : Math.min(i, j);
}

/** `text` (a stack, an error message) with the root's real path and URL named virtually. */
export function virtual_text(text: string, root: string): string {
	let s = drop_generation(text);
	const url = pathToFileURL(root).href;
	if (s.includes(url)) s = s.split(url + '/').join(VIRTUAL_URL + '/');
	if (s.includes(root + sep)) s = s.split(root + sep).join(VIRTUAL_ROOT + sep);
	return s;
}

function is_virtual(p: unknown): boolean {
	if (typeof p === 'string')
		return p === VIRTUAL_ROOT || p.startsWith(VIRTUAL_ROOT + sep) || p.startsWith(VIRTUAL_URL);
	return p instanceof URL && p.href.startsWith(VIRTUAL_URL);
}

/** Every argument of an fs call that names a path (the first; both of a copy, rename or link). */
const TWO_PATHS = new Set([
	'copyFile',
	'copyFileSync',
	'cp',
	'cpSync',
	'rename',
	'renameSync',
	'link',
	'linkSync',
	'symlink',
	'symlinkSync'
]);

/** Calls whose answer is a path (or a list of entries with one). */
const ANSWERS_PATHS = new Set([
	'realpath',
	'realpathSync',
	'readdir',
	'readdirSync',
	'opendir',
	'opendirSync',
	'mkdtemp',
	'mkdtempSync'
]);

/** One counting root's paths service and the patches that keep it. */
function make_service(root: string, own: (file: string) => boolean): PathsService {
	const virtual = (v: unknown): unknown => {
		if (typeof v === 'string') return virtual_path(v, root) ?? v;
		if (Buffer.isBuffer(v)) return v;
		if (Array.isArray(v)) {
			for (let i = 0; i < v.length; i++) v[i] = virtual(v[i]);
			return v;
		}
		if (v !== null && typeof v === 'object') {
			// a Dirent (readdir withFileTypes) or a Dir (opendir)
			const o = v as Obj;
			for (const k of ['parentPath', 'path'])
				if (typeof o[k] === 'string' && Object.getOwnPropertyDescriptor(o, k)?.writable)
					o[k] = virtual_path(o[k] as string, root) ?? o[k];
		}
		return v;
	};
	const virtual_error = (e: unknown): unknown => {
		if (e === null || typeof e !== 'object') return e;
		const o = e as Obj;
		for (const k of ['path', 'dest'])
			if (typeof o[k] === 'string') o[k] = virtual_path(o[k] as string, root) ?? o[k];
		if (typeof o.message === 'string') o.message = virtual_text(o.message, root);
		if (typeof o.stack === 'string') o.stack = virtual_text(o.stack, root);
		return e;
	};
	const metas = new WeakMap<object, ImportMeta>();

	const service: PathsService = {
		root,
		meta(real) {
			const hit = metas.get(real);
			if (hit) return hit;
			const url = virtual_url(real.url, root);
			let out: ImportMeta = real;
			if (url !== real.url) {
				const o = Object.create(null) as Obj;
				for (const k of Reflect.ownKeys(real))
					Object.defineProperty(o, k, Object.getOwnPropertyDescriptor(real, k)!);
				o.url = url;
				if (url.startsWith('file:')) {
					const file = fileURLToPath(url);
					if (typeof real.filename === 'string') o.filename = file;
					if (typeof real.dirname === 'string') o.dirname = dirname(file);
				}
				const resolve = real.resolve;
				if (typeof resolve === 'function')
					o.resolve = (specifier: string, parent?: string | URL) =>
						virtual_url(
							parent === undefined
								? resolve(real_url(specifier, root))
								: resolve(real_url(specifier, root), real_url(String(parent), root)),
							root
						);
				out = o as unknown as ImportMeta;
			}
			metas.set(real, out);
			return out;
		},
		path(real) {
			return virtual_path(real, root) ?? real;
		},
		require(real) {
			return virtual_require(real, root);
		}
	};

	// ---- fs: virtual paths in read the disk; answers about them come back virtual
	const fs = createRequire(import.meta.url)('node:fs') as Obj;
	const wrap = (owner: Obj, name: string, promised: boolean): void => {
		const orig = owner[name];
		if (typeof orig !== 'function' || name[0] < 'a' || name[0] > 'z') return;
		const fn = orig as Fn;
		const two = TWO_PATHS.has(name);
		const answers = ANSWERS_PATHS.has(name);
		const wrapped = function (this: unknown, ...args: unknown[]): unknown {
			const v0 = args.length > 0 && is_virtual(args[0]);
			const v1 = two && args.length > 1 && is_virtual(args[1]);
			if (!v0 && !v1) return Reflect.apply(fn, this, args);
			if (v0) args[0] = real_path(args[0], root);
			if (v1) args[1] = real_path(args[1], root);
			const last = args.length - 1;
			if (!promised && last >= 0 && typeof args[last] === 'function') {
				const cb = args[last] as Fn;
				args[last] = (e: unknown, ...rest: unknown[]) =>
					Reflect.apply(cb, undefined, [virtual_error(e), ...(answers ? rest.map(virtual) : rest)]);
				return Reflect.apply(fn, this, args);
			}
			let r: unknown;
			try {
				r = Reflect.apply(fn, this, args);
			} catch (e) {
				throw virtual_error(e);
			}
			if (promised && r instanceof Promise)
				return r.then(
					(x) => (answers ? virtual(x) : x),
					(e) => {
						throw virtual_error(e);
					}
				);
			return answers ? virtual(r) : r;
		};
		// realpathSync.native and the like; promisify.custom
		for (const k of Reflect.ownKeys(fn)) {
			if (k === 'length' || k === 'name' || k === 'prototype') continue;
			const d = Object.getOwnPropertyDescriptor(fn, k)!;
			Object.defineProperty(wrapped, k, d);
		}
		Object.defineProperty(wrapped, 'name', { value: fn.name });
		Object.defineProperty(wrapped, 'length', { value: fn.length });
		owner[name] = wrapped;
		if (typeof (fn as unknown as Obj).native === 'function') {
			const native = { native: (fn as unknown as Obj).native } as Obj;
			wrap(native, 'native', promised);
			(wrapped as unknown as Obj).native = native.native;
		}
	};
	const promises = fs.promises as Obj;
	for (const name of Object.keys(fs)) if (name !== 'promises') wrap(fs, name, false);
	for (const name of Object.keys(promises)) wrap(promises, name, true);

	// ---- createRequire of a virtual path: the real module's require, answering virtually
	const mod = Module as unknown as Obj;
	const create_require = mod.createRequire as (p: string | URL) => NodeJS.Require;
	mod.createRequire = function createRequire(p: string | URL): NodeJS.Require {
		if (!is_virtual(p)) return create_require(p);
		const real = create_require(p instanceof URL ? real_url(p.href, root) : real_url(p, root));
		return virtual_require(real, root);
	};

	// ---- stacks: formatted, then named virtually
	const E = Error as unknown as { prepareStackTrace?: Fn };
	const prepare = E.prepareStackTrace;
	E.prepareStackTrace = function prepareStackTrace(error: unknown, frames: unknown): unknown {
		const s = prepare ? prepare(error, frames) : default_stack(error, frames as unknown[]);
		return typeof s === 'string' ? virtual_text(s, root) : s;
	};

	// ---- the working directory, for the code of the root (Determinism shows it in the window)
	const proc = process as unknown as Obj;
	const real_cwd = process.cwd;
	proc.cwd = function cwd(): string {
		const c = Reflect.apply(real_cwd, process, []) as string;
		const file = caller_of(cwd);
		if (file === null) return c;
		const path = file.startsWith('file:') ? safe_path(file) : file;
		if (path === null || path.startsWith(OWN_DIR) || own(path)) return c;
		if (virtual_path(path, root) === null) return c;
		return virtual_path(c, root) ?? c;
	};

	syncBuiltinESMExports();
	return service;
}

function safe_path(url: string): string | null {
	try {
		const q = url.indexOf('?');
		return fileURLToPath(q === -1 ? url : url.slice(0, q));
	} catch {
		return null;
	}
}

/** V8's own stack format, for a process where nothing set Error.prepareStackTrace. */
function default_stack(error: unknown, frames: unknown[]): string {
	let s = String(error);
	for (const f of frames) s += `\n    at ${String(f)}`;
	return s;
}

type Frames = Array<{ getFileName(): string | null | undefined }>;
const frames_of = (_e: unknown, frames: Frames): Frames => frames;

const capture = (Error as { captureStackTrace?: (o: object, f?: Function) => void })
	.captureStackTrace;

/**
 * The file of the nearest frame below `fn` that is not Node's own (`node:path` resolving a
 * relative path calls process.cwd for the code that called it), or null.
 */
function caller_of(fn: Function): string | null {
	if (!capture) return null;
	const E = Error as unknown as { prepareStackTrace?: unknown; stackTraceLimit: number };
	const prepare = E.prepareStackTrace;
	const limit = E.stackTraceLimit;
	E.prepareStackTrace = frames_of;
	E.stackTraceLimit = 12;
	try {
		const holder: { stack?: Frames } = {};
		capture(holder, fn);
		const frames = holder.stack ?? [];
		for (let i = 0; i < frames.length; i++) {
			const f = frames[i].getFileName();
			if (!f || f.startsWith('node:')) continue;
			return f;
		}
		return null;
	} finally {
		E.prepareStackTrace = prepare;
		E.stackTraceLimit = limit;
	}
}

/** A require that takes virtual paths and whose resolve answers them. */
function virtual_require(real: NodeJS.Require, root: string): NodeJS.Require {
	const to_real = (id: string): string => (typeof id === 'string' ? real_url(id, root) : id);
	const to_virtual = (p: string): string => virtual_path(p, root) ?? p;
	const req = function require(id: string): unknown {
		return real(to_real(id));
	} as NodeJS.Require;
	const resolve = function resolve(id: string, o?: { paths?: string[] }): string {
		const options =
			o?.paths === undefined ? o : { ...o, paths: o.paths.map((p) => real_url(p, root)) };
		return to_virtual(real.resolve(to_real(id), options));
	} as NodeJS.RequireResolve;
	resolve.paths = (id: string) => {
		const list = real.resolve.paths(id);
		return list === null ? null : list.map(to_virtual);
	};
	req.resolve = resolve;
	// the cache is keyed by real paths: a virtual key reads and deletes the real entry
	req.cache = new Proxy(real.cache, {
		get: (t, k) => Reflect.get(t, typeof k === 'string' ? real_url(k, root) : k),
		has: (t, k) => Reflect.has(t, typeof k === 'string' ? real_url(k, root) : k),
		set: (t, k, v) => Reflect.set(t, typeof k === 'string' ? real_url(k, root) : k, v),
		deleteProperty: (t, k) =>
			Reflect.deleteProperty(t, typeof k === 'string' ? real_url(k, root) : k)
	});
	Object.defineProperty(req, 'main', { get: () => real.main, enumerable: true });
	Object.defineProperty(req, 'extensions', { get: () => real.extensions, enumerable: true });
	return req;
}

/**
 * Show every path of `root` under the virtual root, for the rest of the process. `own(file)`: a
 * file Heisenbench itself loaded (a compiler it requires), which keeps the real working directory.
 * One process counts one root: a second root throws.
 */
export function install_paths(root: string, own: (file: string) => boolean = () => false): void {
	if (installed) {
		if (installed.root !== root) throw new Error('heisenbench: one process measures one root');
		return;
	}
	installed = make_service(root, own);
	(globalThis as unknown as Record<symbol, PathsService>)[PATHS] = installed;
}
