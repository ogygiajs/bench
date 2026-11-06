import { createHash } from 'node:crypto';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { relative, sep } from 'node:path';
import type { SourceMapInput } from '@jridgewell/trace-mapping';
import { instrument } from './instrument.ts';
import type { InstrumentResult } from './instrument.ts';
import { load_prices } from '../prices.ts';
import type { Prices } from '../prices.ts';
import type { ModuleMeta } from '../meta.ts';

export { instrument } from './instrument.ts';
export type { InstrumentOptions, InstrumentResult } from './instrument.ts';

export const VIRTUAL_PREFIX = 'abax:module/';

/** Absolute file URL of the runtime, imported by every virtual counter module. */
export const RUNTIME_URL = new URL('../runtime/index.ts', import.meta.url).href;

export interface TransformOptions {
	/** Absolute path of the file (also used to pick the parser language). */
	filename: string;
	/** Report identity; defaults to `module_id(filename, root)`. */
	id?: string;
	root?: string;
	input_map?: SourceMapInput | null;
	expose?: boolean;
	prices?: { prices: Prices; hash: string };
	/** Specifier the virtual module uses to import the runtime (default: RUNTIME_URL). */
	runtime?: string;
}

export interface TransformResult extends InstrumentResult {
	/** Specifier of the per-module counter module the instrumented code imports. */
	specifier: string;
	/** Source of that counter module. */
	virtual: string;
}

export function module_specifier(filename: string): string {
	return VIRTUAL_PREFIX + createHash('sha1').update(filename).digest('hex').slice(0, 16);
}

/**
 * Report identity of a module: the path relative to the run root, or `pkg/path/in/pkg` for a file
 * inside node_modules (dependencies are blamed under their package names).
 */
export function module_id(filename: string, root: string): string {
	const nm = filename.lastIndexOf(`${sep}node_modules${sep}`);
	if (nm !== -1)
		return filename
			.slice(nm + 14)
			.split(sep)
			.join('/');
	return relative(root, filename).split(sep).join('/');
}

/**
 * The counter module: registers the module's meta with the runtime once and hands the counters to
 * the instrumented module. It is a leaf import, so it evaluates before any module body, and
 * instrumented functions called early through an import cycle still find their counters.
 */
export function virtual_module_source(meta: ModuleMeta, runtime: string = RUNTIME_URL): string {
	return (
		`import { get_runtime } from ${JSON.stringify(runtime)};\n` +
		`const m = get_runtime().module(${JSON.stringify(meta)});\n` +
		`export const c = m.c, d = m.d, f = m.f, b = m.b, s = m.s, r = m.r;\n`
	);
}

export function transform(code: string, opts: TransformOptions): TransformResult {
	const p = opts.prices ?? load_prices();
	const specifier = module_specifier(opts.filename);
	const r = instrument(code, {
		id: opts.id ?? module_id(opts.filename, opts.root ?? process.cwd()),
		filename: opts.filename,
		input_map: opts.input_map,
		prices: p.prices,
		prices_hash: p.hash,
		module_specifier: specifier,
		expose: opts.expose
	});
	return { ...r, specifier, virtual: virtual_module_source(r.meta, opts.runtime ?? RUNTIME_URL) };
}

/** TS to JS with every type replaced by whitespace: offsets, lines and columns stay the same. */
export function strip_types(code: string): string {
	return stripTypeScriptTypes(code, { mode: 'strip' });
}

export function is_ts(filename: string): boolean {
	return filename.endsWith('.ts') || filename.endsWith('.mts') || filename.endsWith('.cts');
}

interface SvelteCompiled {
	js: { code: string; map: SourceMapInput };
}

interface SvelteCompiler {
	compile(source: string, options: Record<string, unknown>): SvelteCompiled;
	compileModule(source: string, options: Record<string, unknown>): SvelteCompiled;
}

const compilers = new Map<string, SvelteCompiler>();

/**
 * The Svelte compiler of the project the file belongs to (its output imports that project's
 * `svelte/internal/*`, so compiler and runtime must be one version); Abax's own when the project
 * has none.
 */
function svelte_compiler(filename: string): SvelteCompiler {
	let path: string;
	try {
		path = createRequire(filename).resolve('svelte/compiler');
	} catch {
		path = createRequire(import.meta.url).resolve('svelte/compiler');
	}
	let c = compilers.get(path);
	if (!c) {
		c = createRequire(import.meta.url)(path) as SvelteCompiler;
		compilers.set(path, c);
	}
	return c;
}

/**
 * Compile a `.svelte` component or a `.svelte.js` / `.svelte.ts` module with the Svelte compiler.
 * The returned map points at the original file, so blocks resolve to the .svelte source lines.
 */
export function compile_svelte(
	source: string,
	filename: string,
	generate: 'server' | 'client' = 'server'
): { code: string; map: SourceMapInput } {
	const c = svelte_compiler(filename);
	if (filename.endsWith('.svelte')) {
		const out = c.compile(source, { filename, generate, dev: false });
		return { code: out.js.code, map: out.js.map };
	}
	const js = is_ts(filename) ? strip_types(source) : source;
	const out = c.compileModule(js, { filename, generate, dev: false });
	return { code: out.js.code, map: out.js.map };
}

export function is_svelte_module(filename: string): boolean {
	return (
		filename.endsWith('.svelte') ||
		filename.endsWith('.svelte.js') ||
		filename.endsWith('.svelte.ts')
	);
}

/** Inline source map comment for the instrumented output. */
export function inline_map(map: object): string {
	const b64 = Buffer.from(JSON.stringify(map)).toString('base64');
	return `\n//# sourceMappingURL=data:application/json;base64,${b64}\n`;
}
