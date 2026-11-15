/**
 * Defining bench cases (tinybench-style): a name, the function to measure, and an optional setup
 * whose return value is handed to the function. Setup and teardown run outside the measuring
 * window, before and after every run, on the window's clock and randomness (case_world).
 *
 *   import { bench } from 'heisenbench/bench';
 *   import { __heisenbench } from '../src/router/match.ts';
 *
 *   bench('match a nested route', ({ routes }) => __heisenbench.match(routes, '/a/b'), {
 *     setup: () => ({ routes: make_routes(50) })
 *   });
 */

import type { GrammarOption } from './search/grammar.ts';

export type { Grammar, GrammarName, GrammarOption } from './search/grammar.ts';

export interface BenchOptions<T> {
	setup?: () => T | Promise<T>;
	teardown?: (ctx: T) => unknown;
	/**
	 * Growth (`heisenbench growth`): the setup's input made about `factor` times bigger. Only for inputs
	 * the generic scaler cannot grow (a size given as a number, an input that must stay valid).
	 */
	scale?: (ctx: T, factor: number) => T;
	/**
	 * Worst-case search (`heisenbench search`): how the input's strings are built, so they are
	 * edited as valid input. A built-in name (`html`, `markdown`, `url`, `js`, `json`, `text`), a
	 * grammar object, or a map from input paths (`'page.body'`) to either. Undeclared strings get
	 * the built-in grammar their text looks like.
	 */
	grammar?: GrammarOption;
}

export interface BenchCase<T = unknown> extends BenchOptions<T> {
	name: string;
	fn: (ctx: T) => unknown;
	/** Bench file the case was defined in (set by the runner). */
	file: string;
}

const SYM = Symbol.for('heisenbench.bench.cases');
const CURRENT = Symbol.for('heisenbench.bench.file');
const NAMES = Symbol.for('heisenbench.bench.names');
/** runtime/determinism.ts CASE_WORLD_KEY. */
const WORLD = Symbol.for('heisenbench.case_world');

type Global = Record<symbol, unknown>;

/** Every case defined so far in this process (shared across module copies through a global). */
export function cases(): BenchCase[] {
	const g = globalThis as unknown as Global;
	let list = g[SYM] as BenchCase[] | undefined;
	if (!list) {
		list = [];
		g[SYM] = list;
	}
	return list;
}

/** Set by the runner while it imports a bench file (each import of a file names its cases anew). */
export function set_current_file(file: string): void {
	const g = globalThis as unknown as Global;
	g[CURRENT] = file;
	g[NAMES] = new Set<string>();
}

export function bench<T = undefined>(
	name: string,
	fn: (ctx: T) => unknown,
	options: BenchOptions<T> = {}
): void {
	const file = ((globalThis as unknown as Global)[CURRENT] as string | undefined) ?? '';
	if (typeof name !== 'string' || name === '')
		throw new TypeError('heisenbench: bench() needs a name');
	if (typeof fn !== 'function')
		throw new TypeError(`heisenbench: bench('${name}') needs a function`);
	// Reports pair cases by file and name: two cases of one file must not share a name.
	const g = globalThis as unknown as Global;
	let names = g[NAMES] as Set<string> | undefined;
	if (!names) g[NAMES] = names = new Set();
	if (names.has(name))
		throw new Error(`heisenbench: two cases in ${file || 'this file'} are named '${name}'`);
	names.add(name);
	const { setup, scale, teardown } = options;
	cases().push({
		...options,
		...(setup && { setup: () => in_case_world(setup) }),
		...(scale && { scale: (ctx: T, k: number) => in_case_world(() => scale(ctx, k)) }),
		...(teardown && { teardown: (ctx: T) => in_case_world(() => teardown(ctx)) }),
		name,
		fn,
		file
	} as BenchCase);
}

/** `f` on the window's clock and randomness (runtime/determinism.ts case_world), when a run is loaded. */
function in_case_world<R>(f: () => R): R {
	const world = (globalThis as unknown as Global)[WORLD] as (<X>(f: () => X) => X) | undefined;
	return world ? world(f) : f();
}
