import { LoaderCore } from './core.ts';
import type { LoaderConfig } from './core.ts';

/*
 * Loader hooks for `module.register`:
 *
 *   import { register } from 'node:module';
 *   register('@bench/abax/hooks', import.meta.url, { data: { root: process.cwd() } });
 *
 * The hooks run off-thread; the counter modules they serve import the runtime on the main thread.
 */

interface ResolveResult {
	url: string;
	format?: string | null;
	shortCircuit?: boolean;
}

interface LoadResult {
	format: string | null | undefined;
	source?: string | ArrayBuffer | Uint8Array | null;
	shortCircuit?: boolean;
}

type NextResolve = (specifier: string, context: object) => Promise<ResolveResult>;
type NextLoad = (url: string, context: object) => Promise<LoadResult>;

let core: LoaderCore | null = null;

export function initialize(data: LoaderConfig | undefined): void {
	core = new LoaderCore(data ?? { root: process.cwd() });
}

function get_core(): LoaderCore {
	if (!core) core = new LoaderCore({ root: process.cwd() });
	return core;
}

export async function resolve(
	specifier: string,
	context: object,
	next: NextResolve
): Promise<ResolveResult> {
	const c = get_core();
	if (c.is_virtual(specifier)) return { url: specifier, shortCircuit: true };
	const r = await next(specifier, context);
	const url = c.with_generation(r.url, (context as { parentURL?: string }).parentURL);
	return url === r.url ? r : { ...r, url };
}

export async function load(url: string, context: object, next: NextLoad): Promise<LoadResult> {
	const c = get_core();
	if (c.is_virtual(url))
		return { format: 'module', source: c.virtual_source(url), shortCircuit: true };
	if (!c.should_instrument(url)) {
		const r = await next(url, context);
		if (r.format !== 'module-typescript' || r.source == null) return r;
		const src =
			typeof r.source === 'string'
				? r.source
				: Buffer.from(r.source as Uint8Array).toString('utf8');
		return { format: 'module', source: c.plain_typescript(url, src), shortCircuit: true };
	}
	if (c.needs_own_read(url)) {
		return {
			format: 'module',
			source: c.instrument(url, c.read(url), null) ?? '',
			shortCircuit: true
		};
	}
	const r = await next(url, context);
	if (r.source == null) return r;
	const src =
		typeof r.source === 'string' ? r.source : Buffer.from(r.source as Uint8Array).toString('utf8');
	const code = c.instrument(url, src, r.format);
	if (code === null) return r;
	return { format: 'module', source: code, shortCircuit: true };
}
