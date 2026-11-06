/**
 * Defining bench cases (tinybench-style): a name, the function to measure, and an optional setup
 * whose return value is handed to the function. Setup and teardown run outside the measuring
 * window, before and after every run.
 *
 *   import { bench } from '@bench/abax/bench';
 *   import { __abax } from '../src/router/match.ts';
 *
 *   bench('match a nested route', ({ routes }) => __abax.match(routes, '/a/b'), {
 *     setup: () => ({ routes: make_routes(50) })
 *   });
 */

export interface BenchOptions<T> {
	setup?: () => T | Promise<T>;
	teardown?: (ctx: T) => unknown;
}

export interface BenchCase<T = unknown> extends BenchOptions<T> {
	name: string;
	fn: (ctx: T) => unknown;
	/** Bench file the case was defined in (set by the runner). */
	file: string;
}

const SYM = Symbol.for('abax.bench.cases');
const CURRENT = Symbol.for('abax.bench.file');

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

/** Set by the runner while it imports a bench file. */
export function set_current_file(file: string): void {
	(globalThis as unknown as Global)[CURRENT] = file;
}

export function bench<T = undefined>(
	name: string,
	fn: (ctx: T) => unknown,
	options: BenchOptions<T> = {}
): void {
	const file = ((globalThis as unknown as Global)[CURRENT] as string | undefined) ?? '';
	cases().push({ name, fn, setup: options.setup, teardown: options.teardown, file } as BenchCase);
}
