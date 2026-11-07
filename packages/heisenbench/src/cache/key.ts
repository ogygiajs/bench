import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { instrument } from '../transform/instrument.ts';
import { is_svelte_module, is_ts, module_id, strip_types } from '../transform/index.ts';
import { load_prices } from '../prices.ts';
import { OWN_DIR, PACKAGE_DIR } from '../own.ts';
import { normalize, sha256 } from './normalize.ts';
import type { LineTable } from './normalize.ts';
import type { IoOp } from './capture.ts';

/*
 * The key of a case (incremental counting, cache/index.ts): a hash of everything its count is a
 * function of. Each part, and why it is there:
 *
 *   engine     Heisenbench's own source, package.json, weights and the versions of its
 *              dependencies: the transform, the runtime and the report are all in there
 *   prices     the prices file's hash: a block's price is a price times an op count
 *   node       Node, V8, platform and arch: Node's built-in modules are code counted code calls,
 *              and a report records which Node counted it
 *   options    --deps, --state, svelte output: they change what is counted
 *   flags      Node's flags (NODE_OPTIONS, execArgv) with the content of every preload they name,
 *              and NODE_ENV
 *   root       the length of the run root's path: code that slices a path made from
 *              `import.meta.url` counts per character (README "Limits")
 *   modules    every module the process loaded, by kind:
 *                code   a counted module of the project: its text normalized (normalize.ts),
 *                       with the body of every function the case never ran left out
 *                text   a module of the project that is not counted (the bench file): its whole
 *                       text, normalized
 *                raw    everything else (dependencies, .svelte, JSON): its bytes
 *              each with its id (a dependency's carries its version)
 *   files      every file read, statted or listed: its bytes, its kind and size, its listing
 *
 * A body left out cannot change the count: execution only reaches code through code that ran,
 * and that code is all in the key, so a case that runs the same code in the same order on the
 * same input enters no function it did not enter before.
 */

export const CACHE_SCHEMA = 'heisenbench-cache/1';

export type ModuleKind = 'code' | 'text' | 'raw';

export interface ModuleEntry {
	/** Relative to the run root (`/`-separated), absolute outside it. */
	path: string;
	/** Report identity (`pkg@version/file` for a dependency). */
	id: string;
	kind: ModuleKind;
	/** sha256 of the bytes, or `missing`. */
	raw: string;
	/** What the key takes: `raw` for raw modules, the normalized text's hash otherwise. */
	hash: string;
	/** `code`: the functions the case ran (their paths in the module). */
	ran?: string[];
}

export interface IoEntry {
	op: IoOp;
	path: string;
	hash: string;
}

/** A path under the root as `a/b.ts`; one outside it (or on another drive) stays absolute. */
export function rel_path(abs: string, root: string): string {
	const r = relative(root, abs);
	if (r === '' || r.startsWith('..') || isAbsolute(r)) return abs;
	return r.split(sep).join('/');
}

export function abs_path(path: string, root: string): string {
	return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : join(root, path);
}

const JS = /\.(?:[mc]?[jt]s|[jt]sx)$/;

/** The kind a loaded file is keyed as. */
export function kind_of(abs: string, counted: boolean): ModuleKind {
	if (abs.includes(`${sep}node_modules${sep}`) || is_svelte_module(abs) || !JS.test(abs))
		return 'raw';
	return counted ? 'code' : 'text';
}

function read_or_null(abs: string): Buffer | null {
	try {
		return readFileSync(abs);
	} catch {
		return null;
	}
}

interface Source {
	raw: string;
	/** The code the run executes: TypeScript with its types stripped (offsets kept). */
	code: string | null;
	/** Functions of `code` (paths as the transform names them) and their bodies. */
	fns?: Array<{ path: string; kind: string; body: [number, number] | null }> | null;
}

/**
 * Hashes of the modules and files of one tree, computed once per process: one file's bytes are
 * read once, its functions found once, its normalized text made once per set of ran functions.
 */
export class TreeHasher {
	readonly root: string;
	#sources = new Map<string, Source>();
	#norm = new Map<string, { hash: string; table: LineTable } | null>();
	#io = new Map<string, string>();

	constructor(root: string) {
		this.root = root;
	}

	source(abs: string): Source {
		let s = this.#sources.get(abs);
		if (s) return s;
		const bytes = read_or_null(abs);
		if (bytes === null) s = { raw: 'missing', code: null };
		else {
			const text = bytes.toString('utf8');
			let code: string | null = text;
			if (is_ts(abs)) {
				try {
					code = strip_types(text);
				} catch {
					// TypeScript the compiler runs (an enum): its own text is keyed instead
					code = text;
				}
			}
			s = { raw: sha256(bytes), code };
		}
		this.#sources.set(abs, s);
		return s;
	}

	raw(abs: string): string {
		return this.source(abs).raw;
	}

	#functions(abs: string, s: Source): NonNullable<Source['fns']> | null {
		if (s.fns !== undefined) return s.fns;
		s.fns = null;
		if (s.code === null) return null;
		try {
			const p = load_prices();
			const r = instrument(s.code, {
				id: 'heisenbench-cache',
				filename: abs,
				prices: p.prices,
				prices_hash: p.hash,
				module_specifier: 'heisenbench:cache',
				expose: false
			});
			s.fns = r.meta.functions.map((f, i) => ({ path: f.path, kind: f.kind, body: r.bodies[i] }));
		} catch {
			s.fns = null;
		}
		return s.fns;
	}

	/**
	 * The normalized text's hash and line table of a module of the project, with the bodies of
	 * the functions not in `ran` left out (`ran` undefined: the whole text). Null when it does
	 * not parse: the key then takes its bytes.
	 */
	normalized(abs: string, ran?: readonly string[]): { hash: string; table: LineTable } | null {
		const k = `${abs}\0${ran === undefined ? '*' : ran.join('\0')}`;
		if (this.#norm.has(k)) return this.#norm.get(k)!;
		const s = this.source(abs);
		let out: { hash: string; table: LineTable } | null = null;
		if (s.code !== null) {
			const blank: Array<[number, number]> = [];
			let ok = true;
			if (ran !== undefined) {
				const fns = this.#functions(abs, s);
				if (fns === null) ok = false;
				else {
					const keep = new Set(ran);
					for (const f of fns)
						if (f.kind === 'function' && f.body && !keep.has(f.path)) blank.push(f.body);
				}
			}
			const n = ok ? normalize(s.code, abs, blank) : null;
			if (n) out = { hash: n.hash, table: n.table };
		}
		this.#norm.set(k, out);
		return out;
	}

	/** A module entry for this tree. */
	entry(abs: string, kind: ModuleKind, ran?: readonly string[]): ModuleEntry {
		const raw = this.raw(abs);
		const sorted = kind === 'code' ? [...(ran ?? [])].sort() : undefined;
		const e: ModuleEntry = {
			path: rel_path(abs, this.root),
			id: module_id(abs, this.root),
			kind,
			raw,
			hash: this.hash_of(abs, kind, raw, sorted)
		};
		if (sorted) e.ran = sorted;
		return e;
	}

	hash_of(abs: string, kind: ModuleKind, raw: string, ran?: readonly string[]): string {
		if (kind === 'raw' || raw === 'missing') return `raw:${raw}`;
		const n = this.normalized(abs, kind === 'code' ? (ran ?? []) : undefined);
		return n === null ? `raw:${raw}` : `${kind}:${n.hash}`;
	}

	/**
	 * `e` as this tree has it: its stored hash when the bytes are the same, else computed again.
	 * The path and id stay: a module that moved is another module.
	 */
	current(e: ModuleEntry): ModuleEntry {
		const abs = abs_path(e.path, this.root);
		const raw = this.raw(abs);
		if (raw === e.raw) return e;
		return { ...e, raw, hash: this.hash_of(abs, e.kind, raw, e.ran) };
	}

	#manifests = new Map<string, string | null>();

	/**
	 * The package.json nearest to `abs`: how Node resolved the module (its `exports`, `imports`,
	 * `type`) is decided there, so it is an input of every case that loaded the module.
	 */
	manifest_of(abs: string): string | null {
		const dir = dirname(abs);
		const have = this.#manifests.get(dir);
		if (have !== undefined) return have;
		const p = join(dir, 'package.json');
		const up = dirname(dir);
		const found = existsSync(p) ? p : up === dir ? null : this.manifest_of(dir);
		this.#manifests.set(dir, found);
		return found;
	}

	io(op: IoOp, path: string): string {
		const k = `${op}\0${path}`;
		let h = this.#io.get(k);
		if (h !== undefined) return h;
		const abs = abs_path(path, this.root);
		h = 'missing';
		try {
			if (op === 'read') h = sha256(readFileSync(abs));
			else if (op === 'list') h = sha256(readdirSync(abs).sort().join('\0'));
			else if (op === 'real') h = `at:${rel_path(realpathSync(abs), this.root)}`;
			else {
				const st = statSync(abs);
				h = `${st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'}:${st.isFile() ? st.size : 0}`;
			}
		} catch {
			h = 'missing';
		}
		this.#io.set(k, h);
		return h;
	}
}

let engine_hash: string | null = null;

function walk(dir: string, out: string[]): void {
	for (const name of readdirSync(dir).sort()) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (/\.[mc]?[jt]s$/.test(name)) out.push(p);
	}
}

/** The package directory of `name`, found the way Node finds it from Heisenbench's own. */
function package_dir(name: string): string | null {
	let dir = PACKAGE_DIR;
	for (;;) {
		const p = join(dir, 'node_modules', name, 'package.json');
		if (existsSync(p)) return p;
		const up = join(dir, '..');
		if (up === dir) return null;
		dir = up;
	}
}

/** Heisenbench as it counts: its code, its package files and its dependencies' versions. */
export function engine_version(): string {
	if (engine_hash !== null) return engine_hash;
	const h = [] as string[];
	const files: string[] = [];
	walk(OWN_DIR, files);
	for (const f of files) h.push(relative(OWN_DIR, f), sha256(readFileSync(f)));
	for (const f of ['package.json', 'weights.json', 'prices.json']) {
		const b = read_or_null(join(PACKAGE_DIR, f));
		h.push(f, b === null ? 'missing' : sha256(b));
	}
	const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as {
		dependencies?: Record<string, string>;
	};
	for (const d of Object.keys(pkg.dependencies ?? {}).sort()) {
		const p = package_dir(d);
		let v = 'missing';
		if (p) v = (JSON.parse(readFileSync(p, 'utf8')) as { version?: string }).version ?? 'none';
		h.push(d, v);
	}
	engine_hash = sha256(h.join('\0'));
	return engine_hash;
}

/** Flags that name a file Node loads first. */
const PRELOAD_FLAGS = ['--import', '--require', '-r', '--loader', '--experimental-loader'];

/** Node's flags, with the root written as `<root>` and each preload's bytes. */
export function node_flags(root: string, hasher: TreeHasher): string[] {
	const args = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)].filter(
		(a) => a !== ''
	);
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const eq = a.indexOf('=');
		const flag = eq === -1 ? a : a.slice(0, eq);
		if (PRELOAD_FLAGS.includes(flag)) {
			const value = eq === -1 ? (args[++i] ?? '') : a.slice(eq + 1);
			const file = value.startsWith('file:') ? fileURLToPath(value) : value;
			const abs = abs_path(file, process.cwd());
			out.push(`${flag}=${rel_path(abs, root)}`, existsSync(abs) ? hasher.raw(abs) : 'not a file');
		} else out.push(a.split(root).join('<root>'));
	}
	return out;
}

export interface KeyOptions {
	root: string;
	deps: boolean | string[];
	svelte: 'server' | 'client';
	fresh: boolean;
}

/** The parts every key of one run shares. */
export function global_parts(o: KeyOptions, hasher: TreeHasher): Record<string, unknown> {
	return {
		schema: CACHE_SCHEMA,
		engine: engine_version(),
		prices: load_prices().hash,
		node: [process.version, process.versions.v8, process.platform, process.arch],
		options: { deps: o.deps, svelte: o.svelte, fresh: o.fresh },
		flags: node_flags(o.root, hasher),
		node_env: process.env.NODE_ENV ?? null,
		root: o.root.length
	};
}

/** The key of one case from its parts. */
export function case_key(
	global: Record<string, unknown>,
	file: string,
	name: string,
	modules: readonly ModuleEntry[],
	io: readonly IoEntry[]
): string {
	const m = [...modules]
		.map((e) => [e.path, e.id, e.kind, e.hash])
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	const f = [...io]
		.map((e) => [e.op, e.path, e.hash])
		.sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : a[0] + a[1] > b[0] + b[1] ? 1 : 0));
	return sha256(JSON.stringify([global, file, name, m, f]));
}
