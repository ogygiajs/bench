import type { Sample } from '../coverage/recorder.ts';
import type { GrowthClass } from '../growth/fit.ts';

/** What the parent hands the proving child (child.ts), v8-serialized. */
export interface ProveJob {
	kind: 'prove';
	root: string;
	deps: boolean | string[];
	/** The module the function is in (its id: a path relative to root). */
	module: string;
	/** The function's path in the module (a top-level function: its name). */
	path: string;
	/** The candidate module (an absolute path no file is at, next to the original) and its source. Null: the original alone. */
	candidate: { file: string; source: string } | null;
	/** The function's recorded inputs. */
	samples: Sample[];
	/** Growth factors (default 1, 10, 100). */
	sizes: number[];
	/** Steps one call may take. */
	cap: number;
	/** Edge-case variants per recorded input. */
	variants: number;
	/** `shapes`: each value keeps its type and each object its keys; `all`: keys deleted and undefined too. */
	edge: 'shapes' | 'all';
	seed: number;
	/** Inputs tried while shrinking a differing input to a minimal one. */
	shrink: number;
	/** The result file (v8-serialized ProveChildResult). */
	out: string;
}

/** What `heisenbench record` runs in a child for `prove --bench`: the bench cases, at their scales too. */
export interface RecordJob {
	kind: 'record';
	root: string;
	files: string[];
	targets: Record<string, string[]>;
	scales: number[];
	out: string;
}

export interface Cost {
	steps: number;
	allocations: number;
	bytes: number;
}

export interface Side {
	cost: Cost | null;
	threw: { name: string; message: string } | null;
	/** The call went past its step cap. */
	capped: boolean;
}

export type InputKind = 'recorded' | 'grown' | 'edge';

export interface InputRow {
	kind: InputKind;
	label: string;
	/** Summed size of its arguments (growth/scale.ts input_size). */
	size: number;
	original: Side;
	candidate: Side | null;
	/** Where the two sides' behavior first differs; null when it is the same. */
	difference: string | null;
}

export interface CurveFit {
	class: GrowthClass | null;
	/** The best power of `a + b * k^p` (fit.ts). */
	power: number;
	/** The log-log slope between the two largest sizes, over input size. */
	exponent: number;
	/** The first factor whose run went past the cap. */
	capped_at: number | null;
}

export interface GrowthRow {
	k: number;
	size: number;
	original: Cost | null;
	candidate: Cost | null;
}

export interface ProveGrowth {
	/** The argument grown (the one whose growth is steepest on the original). */
	argument: number;
	kind: string;
	rows: GrowthRow[];
	original: CurveFit;
	candidate: CurveFit | null;
}

export interface Blame {
	at: string;
	steps: number;
	share: number;
}

export interface ProveChildResult {
	inputs: InputRow[];
	growth: ProveGrowth | null;
	/** Power of steps over the recorded inputs' sizes (fit.ts fit_noisy), when they span enough. */
	recorded_curve: {
		original: { power: number; r2: number };
		candidate: { power: number; r2: number } | null;
		sizes: [number, number];
	} | null;
	/** The lines with the most steps at the largest input counted, each side. */
	blame: { original: Blame[]; candidate: Blame[]; size: number };
	/** The smallest input the two sides differ on, after shrinking. */
	minimal: {
		label: string;
		input: string;
		difference: string;
		size: number;
		/** The size of the differing input it was shrunk from. */
		from_size: number;
	} | null;
	errors: string[];
	/** What the proof left out and why (a grown input past the size cap), in words. */
	notes?: string[];
}
