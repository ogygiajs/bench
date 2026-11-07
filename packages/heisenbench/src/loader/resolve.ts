import { registerHooks } from 'node:module';

/*
 * TypeScript sources name their siblings in two ways Node does not resolve to a `.ts` file:
 *
 * - by the name they compile to: `./clone.js` for `clone.ts` (`moduleResolution: NodeNext`, and
 *   most `Bundler` projects);
 * - by no extension at all: `./core` for `core.ts`, `./parser` for `parser/index.ts` (a bundler
 *   resolves those).
 *
 * Heisenbench counts the source as it is, so when Node cannot find a relative import, the source
 * file it names is tried: `x.js` -> `x.ts`, `x.mjs` -> `x.mts`, and an import with no extension ->
 * `x.ts`, `x.mts`, `x.js`, `x.mjs`, `x/index.ts`, `x/index.js`. Only after Node's own resolution
 * failed: what Node resolves stays as it is.
 *
 * Inside a package (a file in node_modules) only the bundler's part applies: an import with no
 * extension -> `x.js`, `x.mjs`, `x/index.js`. Packages built for bundlers ship those (Svelte
 * component libraries built with `svelte-package` keep their source's `./helpers`); a package's
 * `x.js` never becomes an `x.ts`.
 */

/** Extensions an import already names: nothing is appended to these. */
const KNOWN = /\.(?:[cm]?[jt]sx?|json|node|svelte|wasm)$/;

/** What a relative import may name instead, in the order tried (none: not a relative import). */
export function source_candidates(specifier: string, parent: string | undefined): string[] {
	if (!parent || !parent.startsWith('file:')) return [];
	if (!specifier.startsWith('./') && !specifier.startsWith('../')) return [];
	const in_package = parent.includes('/node_modules/');
	const q = specifier.search(/[?#]/);
	const path = q === -1 ? specifier : specifier.slice(0, q);
	const rest = q === -1 ? '' : specifier.slice(q);
	if (!in_package && path.endsWith('.js')) return [path.slice(0, -3) + '.ts' + rest];
	if (!in_package && path.endsWith('.mjs')) return [path.slice(0, -4) + '.mts' + rest];
	if (KNOWN.test(path)) return [];
	const dir = path.endsWith('/') ? path : path + '/';
	const files = in_package ? ['.js', '.mjs'] : ['.ts', '.mts', '.js', '.mjs'];
	const index = in_package ? ['index.js'] : ['index.ts', 'index.js'];
	return [
		...(path.endsWith('/') ? [] : files.map((e) => path + e + rest)),
		...index.map((f) => dir + f + rest)
	];
}

/** Node could not find the module (a file, or a directory with no entry). */
export function not_found(e: unknown): boolean {
	const code = (e as { code?: unknown } | null)?.code;
	return code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_UNSUPPORTED_DIR_IMPORT';
}

interface Resolved {
	url: string;
	format?: string | null;
	shortCircuit?: boolean;
}

type NextResolve<C> = (specifier: string, context?: C) => Resolved;

/** `next(specifier)`, or the first source candidate that resolves when it is not found. */
export function resolve_source<C extends { parentURL?: string }>(
	specifier: string,
	context: C,
	next: NextResolve<C>
): Resolved {
	try {
		return next(specifier, context);
	} catch (e) {
		if (!not_found(e)) throw e;
		for (const c of source_candidates(specifier, context.parentURL)) {
			try {
				return next(c, context);
			} catch (inner) {
				if (!not_found(inner)) throw inner;
			}
		}
		throw e;
	}
}

/** {@link resolve_source} for the off-thread hooks of `module.register` (hooks.ts). */
export async function resolve_source_async<C extends { parentURL?: string }>(
	specifier: string,
	context: C,
	next: (specifier: string, context: C) => Promise<Resolved>
): Promise<Resolved> {
	try {
		return await next(specifier, context);
	} catch (e) {
		if (!not_found(e)) throw e;
		for (const c of source_candidates(specifier, context.parentURL)) {
			try {
				return await next(c, context);
			} catch (inner) {
				if (!not_found(inner)) throw inner;
			}
		}
		throw e;
	}
}

const REGISTERED = Symbol.for('heisenbench.resolve.source');

/**
 * Register {@link resolve_source} in this thread, once per process. Hooks registered later run
 * first, so the loaders that register this before their own hooks see the source file's URL.
 */
export function register_source_resolve(): void {
	const g = globalThis as unknown as Record<symbol, boolean | undefined>;
	if (g[REGISTERED]) return;
	g[REGISTERED] = true;
	registerHooks({
		resolve: (specifier, context, next) => resolve_source(specifier, context, next)
	});
}
