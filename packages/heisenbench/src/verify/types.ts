export type VerifyLayer =
	| 'steps'
	| 'elision'
	| 'leak'
	| 'engine'
	| 'growth'
	| 'contract'
	| 'search'
	| 'app'
	| 'time'
	| 'trend';

export const VERIFY_LAYERS: VerifyLayer[] = [
	'steps',
	'elision',
	'leak',
	'engine',
	'growth',
	'contract',
	'search',
	'app',
	'time',
	'trend'
];

/** One planted change (or planted no-op) and how to check what Heisenbench says about it. */
export interface Check {
	layer: VerifyLayer;
	name: string;
	what: string;
	/** A planted slowdown (true) or a planted no-op that must stay quiet (false). */
	planted: boolean;
	/** What Heisenbench must say. */
	expect: string;
	/** Timing-sensitive: runs alone, after the others. */
	exclusive: boolean;
	run: () => Promise<{ pass: boolean; got: string }>;
}

export interface VerifyRow {
	layer: VerifyLayer;
	name: string;
	what: string;
	planted: boolean;
	expect: string;
	got: string;
	pass: boolean;
	ms: number;
}
