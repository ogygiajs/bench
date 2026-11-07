import type { Shape } from './odds.ts';

/*
 * How often each growth shape shows up: the prior of growth odds (odds.ts). There is no dataset of
 * labeled curves yet, so the default is the classes of the 1,116 functions growth from recorded
 * calls decided on one real codebase when it was added (bench #24: its whole test suite and bench
 * cases, recorded and grown): real code, mostly flat or linear, about 1 in 70 superlinear. Each
 * shape gets half a count more, so none is ever impossible (none was exponential).
 *
 * PLANTED_COUNTS are the shapes the growth tests and answer keys plant (half of them superlinear):
 * what the tests ask growth to tell apart, not how often code has them. They are kept to show the
 * odds do not hang on the prior where the points are clear (test/growth-odds.test.ts reads every
 * planted case under both).
 *
 * A dataset of labeled curves replaces this table: pass `prior` to exact_odds / noisy_odds, or
 * `--growth-prior <file.json>` (an object of shape -> weight; weights need not sum to 1).
 */

export type ShapePrior = Record<Shape, number>;

/** Classes of the functions decided on one real codebase. */
export const FOUND_COUNTS: ShapePrior = {
	constant: 490,
	log: 200,
	linear: 372,
	'n log n': 39,
	quadratic: 9,
	cubic: 3,
	quartic: 2,
	polynomial: 1,
	exponential: 0
};

/** Shapes planted in the growth tests and answer keys. */
export const PLANTED_COUNTS: ShapePrior = {
	constant: 1,
	log: 1,
	linear: 9,
	'n log n': 1,
	quadratic: 5,
	cubic: 2,
	quartic: 2,
	polynomial: 2,
	exponential: 2
};

/** Shares of `counts`, each shape given half a count first. */
export function shares(counts: Partial<ShapePrior>): ShapePrior {
	const keys: Shape[] = [
		'constant',
		'log',
		'linear',
		'n log n',
		'quadratic',
		'cubic',
		'quartic',
		'polynomial',
		'exponential'
	];
	let total = 0;
	for (const k of keys) total += Math.max(0, counts[k] ?? 0) + 0.5;
	const out = {} as ShapePrior;
	for (const k of keys) out[k] = (Math.max(0, counts[k] ?? 0) + 0.5) / total;
	return out;
}

export const DEFAULT_PRIOR: ShapePrior = shares(FOUND_COUNTS);

/**
 * Prior that a curve is flat up to some measured size and rises from there (a branch that starts
 * once the input is long enough; the generic scaler's copies often get there).
 */
export const PATH_CHANGE = 0.2;
