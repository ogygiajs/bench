/*
 * Engine health (spec 5): what V8 did with the measured code, run uninstrumented in a child process.
 *
 * A function's tier is where its code ended up after a fixed protocol (warm-up runs, then every
 * reachable function forced to optimize, then more runs). A site is one inline cache: a property
 * read or write, keyed access or global lookup, with the worst state it reached.
 */

export const ENGINE_SCHEMA = 'abax-engine/1';

/** Where a function's code ended up. `deoptimized`: it had optimized code and lost it. */
export type Tier =
	| 'not compiled'
	| 'interpreted'
	| 'baseline'
	| 'maglev'
	| 'turbofan'
	| 'deoptimized';

/** Inline-cache state in plain words, from V8's one-letter codes. */
export type IcState =
	| 'no feedback'
	| 'uninitialized'
	| 'monomorphic'
	| 'polymorphic'
	| 'megamorphic'
	| 'generic';

/** How bad a state is: a site that moves up this scale got slower. */
export const IC_RANK: Record<IcState, number> = {
	'no feedback': 0,
	uninitialized: 0,
	monomorphic: 1,
	polymorphic: 2,
	megamorphic: 3,
	generic: 3
};

export const TIER_RANK: Record<Tier, number> = {
	'not compiled': 0,
	deoptimized: 0,
	interpreted: 1,
	baseline: 2,
	maglev: 3,
	turbofan: 4
};

export function is_optimized(t: Tier): boolean {
	return t === 'maglev' || t === 'turbofan';
}

export interface EngineDeopt {
	reason: string;
	/** `deopt-eager`, `deopt-lazy`, `deopt-soft`... */
	kind: string;
	/** Original source line where the deopt happened (0 when unknown). */
	line: number;
	count: number;
}

export interface EngineFunction {
	/** `module > path`, the same identity as the step report. */
	id: string;
	module: string;
	path: string;
	line: number;
	tier: Tier;
	/** It runs inside live optimized code of a caller (inlined), whatever its own tier. */
	inlined: boolean;
	/** Optimized tier, or inlined into optimized code. */
	optimized: boolean;
	/** The child could reach the function object (export or `__abax`) and forced it to optimize. */
	forced: boolean;
	deopts: EngineDeopt[];
	/**
	 * Set when the runs of the case did not agree on this function: what differed, in plain words.
	 * The values are the first run's. The engine diff never makes a finding of it.
	 */
	unstable?: string;
	/**
	 * Why a function is not optimized:
	 *   cold          it never ran hot enough for V8 to optimize it (not forced, never optimized,
	 *                 no deopt): nothing is wrong with it; a function run a few times a case is cold
	 *   refused       forced to optimize, and V8 did not
	 *   deoptimized   it had optimized code and lost it
	 * Only refused and deoptimized are findings.
	 */
	not_optimized?: 'cold' | 'refused' | 'deoptimized';
}

export interface EngineSite {
	/** `function id > kind key #n`: stable across line moves. */
	id: string;
	function: string;
	module: string;
	/** Original source line and column (1-based). */
	line: number;
	col: number;
	/** `property read`, `property write`, `keyed read`, `global read`... */
	kind: string;
	/** Property name (named access), `[]` (keyed access) or the global name. */
	key: string;
	/** Worst state the site reached. */
	state: IcState;
	/** Distinct object shapes (maps) the site saw. */
	maps: number;
	/** Set when the runs of the case did not agree on this site (see EngineFunction.unstable). */
	unstable?: string;
	/** Distinct keys a keyed site saw (property names or indexes). */
	keys?: number;
	/**
	 * Why a site is megamorphic or generic: `shapes`, more object shapes than its cache holds;
	 * `keys`, a keyed site that saw more than one property name (V8 keeps one name per keyed cache,
	 * so the second makes it megamorphic, on a single shape too).
	 */
	cause?: 'shapes' | 'keys';
}

/** A site's state in plain words: `megamorphic`, or `generic (keys of many names)`. */
export function state_words(s: Pick<EngineSite, 'state' | 'cause'>): string {
	if ((s.state === 'megamorphic' || s.state === 'generic') && s.cause === 'keys')
		return 'generic (keys of many names, not many shapes)';
	return s.state;
}

export interface EngineCase {
	name: string;
	file: string;
	/**
	 * Every run of the child decoded to exactly the same result. When false, the functions and sites
	 * that differed carry `unstable` (a report from before per-entry marks has none: then the whole
	 * case counts as unstable).
	 */
	stable: boolean;
	/** Child runs decoded and compared (1 with the check off; more after a mismatch). */
	repeats?: number;
	error: string | null;
	functions: EngineFunction[];
	sites: EngineSite[];
}

export interface EngineReport {
	schema: typeof ENGINE_SCHEMA;
	node: string;
	v8: string;
	/** Node and V8 flags the child ran with. */
	flags: string[];
	warmup: number;
	runs: number;
	cases: EngineCase[];
}
