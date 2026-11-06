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

/*
 * The plain build: the code as it ships, for the layers that need the real engine (time, real
 * bytes, leaks). Nothing is counted. Two things still happen to files under the roots:
 *
 * - `.svelte` / `.svelte.ts` files are compiled (server output), like the counting loader does;
 * - every module gets the same `export const __abax = {...}` of private bindings, appended at the
 *   end, so bench files that import private functions run unchanged.
 *
 * TS is left to Node's own type stripping, which keeps every offset: script positions V8 reports
 * (heap profiles, snapshots) are the positions the counting transform saw.
 */

const ABAX_DIR = fileURLToPath(new URL('../', import.meta.url));
const EXTENSIONS = ['.js', '.mjs', '.ts', '.mts', '.svelte'];

export interface PlainConfig {
	/** Directories whose modules get the `__abax` export (each checkout of a PR vs base run). */
	roots: string[];
	svelte?: 'server' | 'client';
}

export function is_plain_source(path: string, roots: readonly string[]): boolean {
	if (path.startsWith(ABAX_DIR)) return false;
	if (path.includes(`${sep}node_modules${sep}`)) return false;
	if (path.endsWith('.d.ts') || path.includes('.bench.')) return false;
	if (!EXTENSIONS.some((e) => path.endsWith(e))) return false;
	return roots.some((r) => path.startsWith(r.endsWith(sep) ? r : r + sep));
}

/** `export const __abax = {...}` for a module's source (TS or JS), or '' when there is nothing to add. */
export function expose_suffix(
	code: string,
	filename: string,
	lang: 'ts' | 'js' = is_ts(filename) ? 'ts' : 'js'
): string {
	const parsed = parseSync(filename, code, { sourceType: 'module', lang });
	if (parsed.errors.length > 0) return '';
	const bindings = private_bindings(parsed.program as never);
	if (bindings.some((b) => b.name === '__abax')) return '';
	const props = bindings.map((b) => (b.live ? `get ${b.name}(){return ${b.name}}` : b.name));
	return `\nexport const __abax={${props.join(',')}};\n`;
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
		load(url, context, next) {
			if (!url.startsWith('file:')) return next(url, context);
			const path = fileURLToPath(url);
			if (!is_plain_source(path, cfg.roots)) return compiled_if_needed(next(url, context), path);
			if (is_svelte_module(path)) {
				const { code, map } = executed_code(path, readFileSync(path, 'utf8'), cfg.svelte);
				const js = code + expose_suffix(code, path, 'js');
				return { format: 'module', source: js + inline_map(map!), shortCircuit: true };
			}
			const r = next(url, context);
			if (r.source == null) return r;
			if (r.format !== 'module' && r.format !== 'module-typescript') return r;
			const src =
				typeof r.source === 'string'
					? r.source
					: Buffer.from(r.source as Uint8Array).toString('utf8');
			if (r.format === 'module-typescript') {
				// TypeScript stripping cannot run (an enum): the same compile the counting build used.
				const { code, map } = executed_code(path, src);
				if (map !== null) {
					const js = code + expose_suffix(code, path, 'js');
					return { format: 'module', source: js + inline_map(map), shortCircuit: true };
				}
			}
			return { ...r, source: src + expose_suffix(src, path), shortCircuit: true };
		}
	});
}

/** A TypeScript module Node's stripping cannot run, compiled; anything else as loaded. */
function compiled_if_needed<R extends { format?: string | null; source?: unknown }>(
	r: R,
	path: string
): R | { format: 'module'; source: string; shortCircuit: true } {
	if (r.format !== 'module-typescript' || r.source == null) return r;
	const src =
		typeof r.source === 'string' ? r.source : Buffer.from(r.source as Uint8Array).toString('utf8');
	const { code, map } = ts_to_js(src, path);
	if (map === null) return r;
	return { format: 'module', source: code + inline_map(map as object), shortCircuit: true };
}
