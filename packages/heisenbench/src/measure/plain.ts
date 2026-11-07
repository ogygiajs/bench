import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';
import {
	compile_svelte,
	inline_map,
	is_svelte_module,
	is_ts,
	ts_to_js
} from '../transform/index.ts';
import { private_bindings } from '../transform/instrument.ts';
import { GENERATION, guess_format } from '../loader/core.ts';
import { OWN_DIR } from '../own.ts';

/*
 * The plain build: the code as it ships, for the layers that need the real engine (time, real
 * bytes, leaks). Nothing is counted. Two things still happen to files under the roots:
 *
 * - `.svelte` / `.svelte.ts` files are compiled (server output), like the counting loader does;
 * - every module gets the same `export const __heisenbench = {...}` of private bindings, appended at the
 *   end, so bench files that import private functions run unchanged.
 *
 * TS is left to Node's own type stripping, which keeps every offset: script positions V8 reports
 * (heap profiles, snapshots) are the positions the counting transform saw.
 */

const HEISENBENCH_DIR = OWN_DIR;
const EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.svelte'];

/**
 * Whether the counting build reads a file as CommonJS (loader/core.ts guess_format): a `.cjs`
 * file, or a `.js` file of a package that is not `"type": "module"`. Script positions V8 reports
 * for it are mapped through the same transform the counting build ran.
 */
export function is_commonjs_source(filename: string): boolean {
	if (is_ts(filename) || is_svelte_module(filename)) return false;
	return guess_format(filename) === 'commonjs';
}

export interface PlainConfig {
	/** Directories whose modules get the `__heisenbench` export (each checkout of a PR vs base run). */
	roots: string[];
	svelte?: 'server' | 'client';
}

export function is_plain_source(path: string, roots: readonly string[]): boolean {
	if (path.startsWith(HEISENBENCH_DIR)) return false;
	if (path.includes(`${sep}node_modules${sep}`)) return false;
	if (path.endsWith('.d.ts') || path.includes('.bench.')) return false;
	if (!EXTENSIONS.some((e) => path.endsWith(e))) return false;
	return roots.some((r) => path.startsWith(r.endsWith(sep) ? r : r + sep));
}

/** A module of a dependency the counting build counts (an ES module of a package, not Heisenbench's). */
export function is_dependency_source(path: string): boolean {
	if (path.startsWith(HEISENBENCH_DIR) || path.endsWith('.d.ts')) return false;
	if (!path.includes(`${sep}node_modules${sep}`)) return false;
	return EXTENSIONS.some((e) => path.endsWith(e));
}

/** `export const __heisenbench = {...}` for a module's source (TS or JS), or '' when there is nothing to add. */
export function expose_suffix(
	code: string,
	filename: string,
	lang: 'ts' | 'js' = is_ts(filename) ? 'ts' : 'js'
): string {
	const parsed = parseSync(filename, code, { sourceType: 'module', lang });
	if (parsed.errors.length > 0) return '';
	const bindings = private_bindings(parsed.program as never);
	if (bindings.some((b) => b.name === '__heisenbench')) return '';
	const props = bindings.map((b) => (b.live ? `get ${b.name}(){return ${b.name}}` : b.name));
	return `\nexport const __heisenbench={${props.join(',')}};\n`;
}

/**
 * The code V8 runs for a plain module, as the counting transform must see it to number the same
 * functions: TS stripped to whitespace (as Node does it), .svelte compiled.
 */
export function executed_code(
	filename: string,
	source: string,
	svelte: 'server' | 'client' = 'server'
): { code: string; map: object | null } {
	if (is_svelte_module(filename)) {
		const out = compile_svelte(source, filename, svelte);
		return { code: out.code, map: out.map as object };
	}
	if (!is_ts(filename)) return { code: source, map: null };
	const out = ts_to_js(source, filename);
	return { code: out.code, map: out.map as object | null };
}

let installed: PlainConfig | null = null;

/** Load every module under the roots as the plain build (in this thread). Once per process. */
export function register_plain(config: PlainConfig): void {
	if (installed) {
		for (const r of config.roots) if (!installed.roots.includes(r)) installed.roots.push(r);
		return;
	}
	const cfg: PlainConfig = { roots: [...config.roots], svelte: config.svelte };
	installed = cfg;
	registerHooks({
		// a fresh copy (`?heisenbench_gen=N`, cases.ts) passes its query on to what it imports, so the whole
		// graph is new; Heisenbench's own files stay shared
		resolve(specifier, context, next) {
			const r = next(specifier, context);
			const parent = context.parentURL;
			if (!parent || !r.url.startsWith('file:') || r.url.includes(GENERATION)) return r;
			const q = parent.indexOf('?');
			const at = q === -1 ? -1 : parent.indexOf(GENERATION, q);
			if (at === -1 || fileURLToPath(r.url).startsWith(HEISENBENCH_DIR)) return r;
			const end = parent.indexOf('&', at);
			const gen = parent.slice(at, end === -1 ? undefined : end);
			return { ...r, url: r.url + (r.url.includes('?') ? '&' : '?') + gen };
		},
		load(url, context, next) {
			if (!url.startsWith('file:')) return next(url, context);
			const path = fileURLToPath(url);
			// TypeScript is read here, not by Node's loader: it throws on an `enum` before a hook
			// sees the source. What stripping can run goes back to Node as TypeScript (it keeps every
			// offset); the rest is the same compile the counting build used.
			const ts = is_own_typescript(path);
			const plain = is_plain_source(path, cfg.roots);
			if (!plain && !ts) return next(url, context);
			if (is_svelte_module(path)) {
				const { code, map } = executed_code(path, readFileSync(path, 'utf8'), cfg.svelte);
				const js = code + expose_suffix(code, path, 'js');
				return { format: 'module', source: js + inline_map(map!), shortCircuit: true };
			}
			if (ts) {
				const src = readFileSync(path, 'utf8');
				const { code, map } = ts_to_js(src, path);
				if (map !== null) {
					const js = plain ? code + expose_suffix(code, path, 'js') : code;
					return { format: 'module', source: js + inline_map(map as object), shortCircuit: true };
				}
				const source = plain ? src + expose_suffix(src, path) : src;
				return { format: 'module-typescript', source, shortCircuit: true };
			}
			const r = next(url, context);
			if (r.source == null) return r;
			if (r.format !== 'module') return r;
			const src =
				typeof r.source === 'string'
					? r.source
					: Buffer.from(r.source as Uint8Array).toString('utf8');
			return { ...r, source: src + expose_suffix(src, path), shortCircuit: true };
		}
	});
}

/** An ES module in TypeScript outside node_modules (Node does not strip types in packages). */
function is_own_typescript(path: string): boolean {
	return (
		(path.endsWith('.ts') || path.endsWith('.mts')) &&
		!path.endsWith('.d.ts') &&
		!path.includes(`${sep}node_modules${sep}`)
	);
}
