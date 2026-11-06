import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abax_plugin } from '../plugin.ts';
import { module_id } from '../transform/index.ts';

/*
 * The plugins of a counted app build (spec 8): the counting transform on the app's dependencies
 * (the packages under test, e.g. ogygia, @ogygia/* and the Svelte runtime) in both the server and
 * the client build, plus two helpers:
 *
 * - The client build gets the page runtime (page.ts) in place of the Node runtime: the same
 *   counters, plus the priced built-ins installed in the page and a global the harness reads the
 *   counts from. Abax's own modules that import Node built-ins (the price file's hash, the price
 *   file loader) get small browser stand-ins there; nothing in the page calls them.
 * - An overlay swaps the source of chosen package files for other text with the file's path kept,
 *   so a planted change keeps its module identity (`@ogygia/core/dist/x.js`) and a diff matches
 *   it to the unpatched build function by function.
 */

const RUNTIME_PATH = fileURLToPath(new URL('../runtime/index.ts', import.meta.url));
const PAGE_RUNTIME = fileURLToPath(new URL('./page.ts', import.meta.url));
const ABAX_SRC = fileURLToPath(new URL('../', import.meta.url));
const SHIM = '\0abax-shim:';
const SOURCE_EXT = ['.js', '.mjs', '.svelte', '.ts', '.mts'];

/** `@scope/name` or `name` of a file inside node_modules (null when it is not in one). */
export function package_of(file: string): string | null {
	const marker = `${sep}node_modules${sep}`;
	const at = file.lastIndexOf(marker);
	if (at === -1) return null;
	const rest = file.slice(at + marker.length).split(sep);
	return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
}

/** True when `pkg` is one of `packages`; `@scope/*` takes every package of the scope. */
export function package_matches(pkg: string, packages: readonly string[]): boolean {
	for (const p of packages) {
		if (p === pkg) return true;
		if (p.endsWith('/*') && pkg.startsWith(p.slice(0, -1))) return true;
	}
	return false;
}

/** Files of the packages under test that the counting transform rewrites. */
export function counted_file(file: string, packages: readonly string[]): boolean {
	if (file.endsWith('.d.ts') || !SOURCE_EXT.some((e) => file.endsWith(e))) return false;
	const pkg = package_of(file);
	if (pkg === null || !package_matches(pkg, packages)) return false;
	// The Svelte compiler runs at build time; a bundle that pulls part of it in is not ogygia's cost.
	return !(pkg === 'svelte' && file.includes(`${sep}compiler${sep}`));
}

export interface CountedPluginOptions {
	/** Packages to count: names, or `@scope/*`. */
	packages: readonly string[];
	/** Module id (`@ogygia/core/dist/x.js`) -> path of the file whose text replaces it. */
	overlay?: Record<string, string>;
	/** Report root for files outside node_modules (default cwd). */
	root?: string;
	/**
	 * Which build this is. Default: Vite tells (the environment's consumer, or `ssr`); a bundler
	 * that does not (plain Rolldown) needs it said.
	 */
	target?: 'server' | 'client';
}

const BROWSER_SHIMS: Record<string, string> = {
	// The price file's hash: identity only, the reports are built in Node.
	'node:crypto':
		'export function createHash() { let h = 2166136261; const o = { update(s) { s = String(s); for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; return o; }, digest() { return h.toString(16).padStart(8, "0").repeat(2); } }; return o; }\n',
	'node:fs':
		'export function readFileSync() { throw new Error("abax: no file system in the page"); }\nexport function existsSync() { return false; }\nexport function writeFileSync() { throw new Error("abax: no file system in the page"); }\n'
};

interface ResolveOptions {
	ssr?: boolean;
}

interface EnvironmentContext {
	environment?: { config?: { consumer?: string } };
}

function is_client(ctx: EnvironmentContext, options: ResolveOptions | undefined): boolean {
	const consumer = ctx.environment?.config?.consumer;
	if (consumer) return consumer === 'client';
	return !options?.ssr;
}

/** The plugins to add to an app's Vite config for a counted build. */
export function counted_plugins(o: CountedPluginOptions): object[] {
	const root = resolve(o.root ?? process.cwd());
	const overlay = new Map(Object.entries(o.overlay ?? {}));
	const helper = {
		name: 'abax:app',
		enforce: 'pre' as const,
		resolveId(
			this: EnvironmentContext,
			id: string,
			importer: string | undefined,
			options?: ResolveOptions
		): string | null {
			const client = o.target ? o.target === 'client' : is_client(this, options);
			if (!client) return null;
			if (id === RUNTIME_PATH) return PAGE_RUNTIME;
			if (importer && importer.startsWith(ABAX_SRC) && id in BROWSER_SHIMS) return SHIM + id;
			return null;
		},
		load(id: string): string | null {
			if (id.startsWith(SHIM)) return BROWSER_SHIMS[id.slice(SHIM.length)] ?? null;
			if (overlay.size === 0 || id.startsWith('\0')) return null;
			const q = id.indexOf('?');
			const file = q === -1 ? id : id.slice(0, q);
			const replacement = overlay.get(module_id(file, root));
			return replacement === undefined ? null : readFileSync(replacement, 'utf8');
		}
	};
	const counting = abax_plugin({
		root,
		expose: false,
		include: (file) => counted_file(file, o.packages),
		runtime: RUNTIME_PATH
	});
	return [helper, counting];
}
