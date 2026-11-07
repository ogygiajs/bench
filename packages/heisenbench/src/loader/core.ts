import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import {
	VIRTUAL_PREFIX,
	compile_svelte,
	inline_map,
	is_svelte_module,
	is_ts,
	module_id,
	module_specifier,
	transform,
	ts_to_js,
	virtualize_meta
} from '../transform/index.ts';
import type { SourceMapInput } from '@jridgewell/trace-mapping';
import { load_prices } from '../prices.ts';
import { OWN_DIR } from '../own.ts';

export interface LoaderConfig {
	/** Report paths are relative to this directory. */
	root: string;
	/**
	 * Which dependencies (packages in node_modules) are counted: true for every one, false for none,
	 * or a list of package names. Default true: work a dependency does for the code is the code's
	 * work, and an uncounted parser hides a quadratic one. Never counted, whatever this says:
	 * Heisenbench's own modules (the runtime that counts), Node's built-ins (they are priced as
	 * built-ins when counted code calls them), and what Heisenbench itself `require`s (the Svelte
	 * and TypeScript compilers it compiles with) with everything that requires in turn. CommonJS
	 * modules are counted like ES modules (transform `commonjs`).
	 */
	deps?: boolean | string[];
	/** Path substrings that are never instrumented. Default: bench files (`.bench.`). */
	exclude?: string[];
	/** Svelte output for .svelte files. Default 'server'. */
	svelte?: 'server' | 'client';
	/** Append the `__heisenbench` export of private bindings. Default true. */
	expose?: boolean;
	/**
	 * Count another commit's code with these bench files (`heisenbench run --source-from <sha>`):
	 * every counted file outside node_modules that is in that commit is read as it is there; bench
	 * files (`exclude`) and files the commit does not have (bench helpers the PR added) are read
	 * from the working tree. `top` is the git top level the paths are relative to.
	 */
	source_from?: { sha: string; top: string };
	/**
	 * The modules of the root read their own paths under the virtual root (runtime/paths.ts): the
	 * transform's `virtual_paths` for counted modules, `virtualize_meta` for bench files.
	 */
	virtual_paths?: boolean;
}

/** `git ...` in `cwd`, its stdout; throws what git says. */
function git_out(cwd: string, args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		maxBuffer: 1 << 28,
		stdio: ['ignore', 'pipe', 'pipe']
	});
}

const HEISENBENCH_DIR = OWN_DIR;
/** Query parameter of a fresh module graph (`?heisenbench_gen=3`). */
export const GENERATION = 'heisenbench_gen=';
const EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.svelte'];

/**
 * CommonJS files the bench graph loaded (not Heisenbench's own): a fresh module graph per run
 * evaluates them again (forget_commonjs), as the cache-busting query does for ES modules.
 */
const graph_commonjs = new Set<string>();

/** Counted CommonJS files whose functions ran in a measuring window: these get fresh state. */
const called_commonjs = new Set<string>();

interface CallsByFile {
	called(specifier: string): boolean;
}

/**
 * Drop from `require.cache` the counted CommonJS files whose code ran in a measuring window (once
 * one has, from then on), so the next copy of the graph (fresh.ts) evaluates them again with
 * module state of their own. Node caches a CommonJS file by its path, whatever query the ES
 * module that imports it carries. Files whose functions never ran in a window (tables a
 * dependency builds once when it loads, like the ARIA data Svelte's compiler imports: 300 files)
 * stay shared: evaluating them again for every run is only garbage, and the GC it brings made
 * a case that leans on weak caches count differently from one run to the next.
 */
export function forget_commonjs(): void {
	const rt = (globalThis as Record<symbol, CallsByFile | undefined>)[
		Symbol.for('heisenbench.runtime')
	];
	const cache = module_cache();
	for (const path of graph_commonjs) {
		if (!called_commonjs.has(path) && rt?.called(module_specifier(path))) called_commonjs.add(path);
		if (called_commonjs.has(path)) delete cache[path];
	}
}

function module_cache(): Record<string, unknown> {
	return createRequire(import.meta.url).cache as Record<string, unknown>;
}

/** `type` of the package.json nearest to a directory, by directory. */
const package_types = new Map<string, string | null>();

function package_type(dir: string): string | null {
	const hit = package_types.get(dir);
	if (hit !== undefined) return hit;
	let type: string | null = null;
	const file = join(dir, 'package.json');
	if (existsSync(file)) {
		try {
			const t = (JSON.parse(readFileSync(file, 'utf8')) as { type?: unknown }).type;
			type = typeof t === 'string' ? t : 'commonjs';
		} catch {
			type = 'commonjs';
		}
	} else {
		const up = dirname(dir);
		type = up === dir ? 'commonjs' : package_type(up);
	}
	package_types.set(dir, type);
	return type;
}

/**
 * The format of a JavaScript file Node did not name one for (a `require`d file: Node decides as
 * it compiles it): `.cjs` is CommonJS, `.mjs` an ES module, and `.js` follows the nearest
 * package.json's `type`. A `.js` file with no `type` that turns out to be an ES module (Node
 * detects its syntax) does not parse as CommonJS and is left to Node.
 */
export function guess_format(path: string): 'commonjs' | 'module' {
	if (path.endsWith('.cjs')) return 'commonjs';
	if (path.endsWith('.mjs')) return 'module';
	return package_type(dirname(path)) === 'module' ? 'module' : 'commonjs';
}

function package_name(path: string): string | null {
	const marker = `${sep}node_modules${sep}`;
	const at = path.lastIndexOf(marker);
	if (at === -1) return null;
	const rest = path.slice(at + marker.length).split(sep);
	return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
}

/** Instrumented source and the format it loads as. */
export interface Instrumented {
	code: string;
	format: 'module' | 'commonjs';
}

/** What both loader flavours (registerHooks in-thread, module.register off-thread) share. */
export class LoaderCore {
	config: LoaderConfig;
	virtual = new Map<string, string>();
	prices = load_prices();

	constructor(config: LoaderConfig) {
		this.config = config;
	}

	/**
	 * Files Heisenbench's own code `require`d (a peer compiler) and everything they load: its
	 * tools, not the code under test, even when they sit in the project's node_modules.
	 */
	#own_loaded = new Set<string>();

	/**
	 * Called by the resolve hook with each resolved module: a `require` from Heisenbench's own
	 * code, or any load from a file it brought in, marks the file as its own (never counted).
	 * An `import` from its own code is the bench file (fresh.ts, the runner) and stays counted.
	 */
	note_resolved(url: string, parent: string | undefined, conditions?: readonly string[]): void {
		if (!parent || !url.startsWith('file:') || !parent.startsWith('file:')) return;
		const from = fileURLToPath(parent.split('?')[0]);
		const own =
			this.#own_loaded.has(from) ||
			(from.startsWith(HEISENBENCH_DIR) && (conditions?.includes('require') ?? false));
		if (own) this.#own_loaded.add(fileURLToPath(url.split('?')[0]));
	}

	/** Heisenbench's own file, or one its own code brought in (a compiler it requires). */
	is_own(path: string): boolean {
		return path.startsWith(HEISENBENCH_DIR) || this.#own_loaded.has(path);
	}

	/**
	 * An ES module of the root that is not counted (a bench file in JavaScript) whose `import.meta`
	 * the loader makes virtual (`virtual_paths`).
	 */
	meta_only(url: string, format: string | null | undefined): boolean {
		if (!this.config.virtual_paths || format !== 'module' || !url.startsWith('file:')) return false;
		const path = fileURLToPath(url);
		const root = this.config.root.endsWith(sep) ? this.config.root : this.config.root + sep;
		return path.startsWith(root) && !this.is_own(path) && package_name(path) === null;
	}

	should_instrument(url: string): boolean {
		if (!url.startsWith('file:')) return false;
		const path = fileURLToPath(url);
		if (path.startsWith(HEISENBENCH_DIR)) return false;
		if (this.#own_loaded.has(path)) return false;
		if (path.endsWith('.d.ts')) return false;
		if (!EXTENSIONS.some((e) => path.endsWith(e))) return false;
		for (const x of this.config.exclude ?? ['.bench.']) if (path.includes(x)) return false;
		const pkg = package_name(path);
		if (pkg !== null) {
			const deps = this.config.deps ?? true;
			if (deps === false) return false;
			if (Array.isArray(deps) && !deps.includes(pkg)) return false;
		}
		return true;
	}

	is_virtual(specifier: string): boolean {
		return specifier.startsWith(VIRTUAL_PREFIX);
	}

	/**
	 * Fresh module state (fresh.ts): a module imported with `?heisenbench_gen=N` passes the same query to
	 * every file it imports, so the whole graph is a new copy with its own module state. Heisenbench's own
	 * files and Node built-ins stay shared. The counter modules are keyed by file, not URL: every
	 * copy of a file counts into the same counters.
	 */
	with_generation(url: string, parent: string | undefined): string {
		if (!parent || !url.startsWith('file:')) return url;
		const q = parent.indexOf('?');
		const at = q === -1 ? -1 : parent.indexOf(GENERATION, q);
		if (at === -1 || url.includes(GENERATION)) return url;
		if (fileURLToPath(url).startsWith(HEISENBENCH_DIR)) return url;
		const end = parent.indexOf('&', at);
		const gen = parent.slice(at, end === -1 ? undefined : end);
		return url + (url.includes('?') ? '&' : '?') + gen;
	}

	virtual_source(url: string): string {
		const src = this.virtual.get(url);
		if (src === undefined) throw new Error(`heisenbench: unknown counter module ${url}`);
		return src;
	}

	/**
	 * True when the load hook must read the file itself: the default loader rejects .svelte, and
	 * strips TypeScript only (it throws on an `enum` before a hook sees the source).
	 */
	needs_own_read(url: string): boolean {
		return (
			url.startsWith('file:') &&
			(fileURLToPath(url).endsWith('.svelte') || this.is_plain_typescript(url))
		);
	}

	read(url: string): string {
		return this.source_override(url) ?? readFileSync(fileURLToPath(url), 'utf8');
	}

	/** Files of the `source_from` commit (paths from the git top level), listed once. */
	#tree: Set<string> | null = null;
	#tree_text = new Map<string, string>();

	/**
	 * With `source_from`, the text a counted file has in that commit; null when it is read from
	 * disk (no `source_from`, a bench file, a dependency, or a file the commit does not have).
	 */
	source_override(url: string): string | null {
		const from = this.config.source_from;
		if (!from || !url.startsWith('file:')) return null;
		const path = fileURLToPath(url);
		if (path.startsWith(HEISENBENCH_DIR) || package_name(path) !== null) return null;
		for (const x of this.config.exclude ?? ['.bench.']) if (path.includes(x)) return null;
		const rel = relative(from.top, path).split(sep).join('/');
		if (rel.startsWith('../') || rel === '..') return null;
		this.#tree ??= new Set(
			git_out(from.top, ['ls-tree', '-r', '--name-only', '-z', from.sha]).split('\0')
		);
		if (!this.#tree.has(rel)) return null;
		let text = this.#tree_text.get(rel);
		if (text === undefined) {
			text = git_out(from.top, ['show', `${from.sha}:${rel}`]);
			this.#tree_text.set(rel, text);
		}
		return text;
	}

	/**
	 * A TypeScript ES module this loader reads itself although it is not counted (a bench file):
	 * Node's own loader strips types only, and an `enum` in a bench file must not stop the run.
	 * Packages in node_modules are left to Node (it does not strip types there at all).
	 */
	is_plain_typescript(url: string): boolean {
		if (!url.startsWith('file:')) return false;
		const path = fileURLToPath(url);
		return (
			(path.endsWith('.ts') || path.endsWith('.mts')) &&
			!path.endsWith('.d.ts') &&
			package_name(path) === null
		);
	}

	/** That module as JS: types stripped, or compiled when stripping cannot run it. */
	plain_typescript(url: string): string {
		const file = fileURLToPath(url);
		const out = ts_to_js(this.read(url), file);
		const code = this.config.virtual_paths ? virtualize_meta(out.code, file) : out.code;
		return out.map === null ? code : code + inline_map(out.map as object);
	}

	/**
	 * Instrument loaded source. Returns the code and the format to load it as, or null when the
	 * module stays as it is (JSON, a native addon...). `format` is what Node said; a `require`d
	 * file comes without one, and its extension and package.json say (guess_format).
	 */
	instrument(url: string, source: string, format: string | null | undefined): Instrumented | null {
		const filename = fileURLToPath(url);
		// Fresh copies of a module (with_generation) load the same file again: transform it once.
		const cached = this.#done.get(filename);
		if (cached && cached.source === source && cached.format === format) return cached.out;
		const out = this.#instrument(filename, source, format);
		this.#done.set(filename, { source, format, out });
		if (out?.format === 'commonjs') graph_commonjs.add(filename);
		return out;
	}

	#done = new Map<
		string,
		{ source: string; format: string | null | undefined; out: Instrumented | null }
	>();

	#instrument(
		filename: string,
		source: string,
		format: string | null | undefined
	): Instrumented | null {
		let code = source;
		let input_map: SourceMapInput | null = null;
		let commonjs = false;
		if (is_svelte_module(filename)) {
			const out = compile_svelte(source, filename, this.config.svelte ?? 'server');
			code = out.code;
			input_map = out.map;
		} else if (format === 'module-typescript' || (format == null && is_ts(filename))) {
			const out = ts_to_js(source, filename);
			code = out.code;
			input_map = out.map;
		} else if (format === 'commonjs' || (format == null && guess_format(filename) === 'commonjs')) {
			commonjs = true;
		} else if (format !== 'module' && !(format == null && guess_format(filename) === 'module')) {
			return null;
		}
		let r: ReturnType<typeof transform>;
		try {
			r = transform(code, {
				filename,
				id: module_id(filename, this.config.root),
				input_map,
				expose: this.config.expose,
				prices: this.prices,
				commonjs,
				virtual_paths: this.config.virtual_paths
			});
		} catch (e) {
			// A `.js` file with no package type that is an ES module after all (Node detects it from
			// its syntax), or CommonJS the parser cannot read: left to Node, as it ran before.
			if (commonjs) return null;
			throw e;
		}
		if (!commonjs) this.virtual.set(r.specifier, r.virtual);
		return { code: r.code + inline_map(r.map), format: commonjs ? 'commonjs' : 'module' };
	}
}
