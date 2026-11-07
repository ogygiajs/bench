import { resolve, sep } from 'node:path';
import type { SourceMapInput } from '@jridgewell/trace-mapping';
import { VIRTUAL_PREFIX, module_id, transform } from './transform/index.ts';
import { load_prices } from './prices.ts';
import { OWN_DIR, own_file } from './own.ts';

/*
 * The counting transform as a Vite / Rolldown / Rollup plugin. It runs last (`enforce: 'post'`), so
 * it sees the JS other plugins produced (TS, .svelte) and maps every block back through their
 * combined source map. Plain Rolldown hands plugins the TS source itself; the parser reads TS and
 * the inserted code is valid TS, so that works too.
 */

export interface AbaxPluginOptions {
	/** Report paths are relative to this directory (default: cwd). */
	root?: string;
	/** Which files to instrument (default: .js/.mjs/.ts/.mts/.svelte outside node_modules). */
	include?: (file: string) => boolean;
	/** Append the `__abax` export of private bindings (default true). */
	expose?: boolean;
	/** Specifier the counter modules import the runtime from (default: this package's runtime). */
	runtime?: string;
}

export interface TransformContext {
	getCombinedSourcemap?: () => unknown;
}

const RUNTIME_PATH = own_file('runtime/index');
const SOURCE_EXT = ['.js', '.mjs', '.ts', '.mts', '.svelte', '.jsx', '.tsx'];

function default_include(file: string): boolean {
	if (file.includes(`${sep}node_modules${sep}`) || file.startsWith(OWN_DIR)) return false;
	return (
		SOURCE_EXT.some((e) => file.endsWith(e)) && !file.endsWith('.d.ts') && !file.includes('.bench.')
	);
}

export function abax_plugin(options: AbaxPluginOptions = {}) {
	const root = resolve(options.root ?? process.cwd());
	const include = options.include ?? default_include;
	const prices = load_prices();
	const virtual = new Map<string, string>();
	return {
		name: 'abax',
		enforce: 'post' as const,
		resolveId(id: string): string | null {
			return id.startsWith(VIRTUAL_PREFIX) ? '\0' + id : null;
		},
		load(id: string): string | null {
			if (!id.startsWith('\0' + VIRTUAL_PREFIX)) return null;
			return virtual.get(id.slice(1)) ?? null;
		},
		transform(
			this: TransformContext,
			code: string,
			id: string
		): { code: string; map: object } | null {
			if (id.startsWith('\0')) return null;
			const q = id.indexOf('?');
			const file = q === -1 ? id : id.slice(0, q);
			if (!include(file)) return null;
			let input_map: SourceMapInput | null = null;
			try {
				const m = this.getCombinedSourcemap?.() as { mappings?: string } | undefined;
				if (m && m.mappings) input_map = m as SourceMapInput;
			} catch {
				input_map = null;
			}
			const r = transform(code, {
				filename: file,
				id: module_id(file, root),
				input_map,
				expose: options.expose,
				prices,
				runtime: options.runtime ?? RUNTIME_PATH
			});
			virtual.set(r.specifier, r.virtual);
			return { code: r.code, map: r.map };
		}
	};
}
