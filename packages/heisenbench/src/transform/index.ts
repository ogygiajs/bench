import '../warnings.ts';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { SourceMapInput } from '@jridgewell/trace-mapping';
import remapping from '@jridgewell/remapping';
import { instrument } from './instrument.ts';
import type { InstrumentResult } from './instrument.ts';
import { load_prices } from '../prices.ts';
import type { Prices } from '../prices.ts';
import type { ModuleMeta } from '../meta.ts';
import { own_url } from '../own.ts';
import { require_peer, require_typescript } from '../peer.ts';

export { instrument } from './instrument.ts';
export type { InstrumentOptions, InstrumentResult } from './instrument.ts';

export const VIRTUAL_PREFIX = 'heisenbench:module/';

/** Absolute file URL of the runtime, imported by every virtual counter module. */
export const RUNTIME_URL = own_url('runtime/index').href;

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
	/** A CommonJS module (instrument.ts `commonjs`): its counters come without a counter module. */
	commonjs?: boolean;
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
 * Report identity of a module: the path relative to the run root, or `pkg@version/path/in/pkg` for
 * a file inside node_modules (dependencies are blamed under their package names and versions;
 * identity.ts reads them back).
 */
export function module_id(filename: string, root: string): string {
	const marker = `${sep}node_modules${sep}`;
	const nm = filename.lastIndexOf(marker);
	if (nm === -1) return relative(root, filename).split(sep).join('/');
	const parts = filename.slice(nm + marker.length).split(sep);
	const n = parts[0].startsWith('@') ? 2 : 1;
	const name = parts.slice(0, n).join('/');
	const version = package_version(
		filename.slice(0, nm + marker.length) + parts.slice(0, n).join(sep)
	);
	return [version === null ? name : `${name}@${version}`, ...parts.slice(n)].join('/');
}

const versions = new Map<string, string | null>();

/**
 * The `version` of the package at `dir` (from its package.json), so a dependency is named
 * `acorn@8.15.0/dist/acorn.mjs` wherever it is installed: the lockfile decides it, not the path.
 */
function package_version(dir: string): string | null {
	let v = versions.get(dir);
	if (v !== undefined) return v;
	try {
		const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
			version?: unknown;
		};
		v = typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : null;
	} catch {
		v = null;
	}
	versions.set(dir, v);
	return v;
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
		expose: opts.expose,
		commonjs: opts.commonjs
	});
	return { ...r, specifier, virtual: virtual_module_source(r.meta, opts.runtime ?? RUNTIME_URL) };
}

/** TS to JS with every type replaced by whitespace: offsets, lines and columns stay the same. */
export function strip_types(code: string): string {
	return stripTypeScriptTypes(code, { mode: 'strip' });
}

interface TypeScriptCompiler {
	transpileModule(
		source: string,
		o: { fileName: string; compilerOptions: Record<string, unknown>; reportDiagnostics?: boolean }
	): { outputText: string; sourceMapText?: string };
}

/** The project's TypeScript (resolved from the file), else Heisenbench's own; an error when neither exists. */
function typescript_for(filename: string): TypeScriptCompiler {
	return require_typescript<TypeScriptCompiler>(
		`${filename} uses TypeScript that type stripping cannot run (enum, namespace or parameter properties); compiling it`,
		filename
	);
}

/**
 * TS to JS. Type stripping first (positions stay the same, no map). TypeScript that stripping
 * cannot handle (`enum`, `namespace`, parameter properties, legacy decorators...) is compiled with
 * the TypeScript compiler instead, and the map it returns points every line back at the source.
 */
export function ts_to_js(
	source: string,
	filename: string
): { code: string; map: SourceMapInput | null } {
	try {
		return { code: strip_types(source), map: null };
	} catch (e) {
		if ((e as { code?: unknown }).code !== 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') throw e;
	}
	const ts = typescript_for(filename);
	const out = ts.transpileModule(source, {
		fileName: filename,
		compilerOptions: {
			target: 99, // ESNext: syntax stays as written
			module: 99, // ESNext
			sourceMap: true,
			inlineSources: false,
			// What Node's stripping keeps, this keeps: every import that is not `import type`.
			verbatimModuleSyntax: true,
			useDefineForClassFields: true,
			removeComments: false
		}
	});
	const code = out.outputText.replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
	const map = out.sourceMapText ? (JSON.parse(out.sourceMapText) as SourceMapInput) : null;
	return { code, map };
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

/**
 * The Svelte compiler of the project the file belongs to (its output imports that project's
 * `svelte/internal/*`, so compiler and runtime must be one version); Heisenbench's own when the project
 * has none.
 */
function svelte_compiler(filename: string): SvelteCompiler {
	return require_peer<SvelteCompiler>('svelte/compiler', `compiling ${filename}`, filename);
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
	const ts = is_ts(filename) ? ts_to_js(source, filename) : { code: source, map: null };
	const out = c.compileModule(ts.code, { filename, generate, dev: false });
	if (ts.map === null) return { code: out.js.code, map: out.js.map };
	// Svelte's map points at the compiled TypeScript; TypeScript's points at the source.
	const map = remapping([out.js.map, ts.map] as Parameters<typeof remapping>[0], () => null);
	return { code: out.js.code, map: map as unknown as SourceMapInput };
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
