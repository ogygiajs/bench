import { FEATURES } from '../calibrate/weights.ts';
import { OP_KINDS } from '../prices.ts';
import type { OpKind, Prices } from '../prices.ts';
import { price_units } from '../units.ts';
import type { Units } from '../units.ts';

/*
 * What the range model sees of one call of some code: its steps split by kind (an op kind like
 * `call`, a dynamic price like `dyn.string_char`, a built-in like `bi.String.prototype.replace`),
 * and, when they were measured, its allocations, bytes, calls, input size, engine health and the
 * Node version. A case in a report has all of them; a function's change in a diff has its units
 * alone, and the rest is missing (NaN), which the trees send down the side most training rows
 * went (trees.ts).
 */

/** Engine health of one side, as `heisenbench health` gives it (the training data's `engine`). */
export interface EngineSide {
	functions: number;
	interpreted: number;
	baseline: number;
	maglev: number;
	turbofan: number;
	inlined: number;
	deoptimized: number;
	refused: number;
	deopts: number;
	sites: number;
	polymorphic: number;
	megamorphic: number;
}

export interface RangeInput {
	/** Steps per kind; sums to the steps of the call. */
	steps_by_kind: Record<string, number>;
	/** Calls per built-in (`String.prototype.slice`), when known. */
	builtin_calls?: Record<string, number> | null;
	allocations?: number | null;
	bytes?: number | null;
	calls?: number | null;
	/** The size of what the case's setup returns (the growth layer's measure). */
	input_size?: number | null;
	engine?: EngineSide | null;
	/** `v26.4.0` */
	node?: string | null;
}

/** The input of a set of units (a case, a function, a change) under a price file. */
export function input_of_units(
	u: Units,
	prices: Prices,
	extra: Omit<RangeInput, 'steps_by_kind' | 'builtin_calls'> = {}
): RangeInput {
	// steps per kind, as the audit groups them (audit/fit.ts kind_steps): a built-in with all its terms
	const by_kind = new Map<string, Units>();
	for (const k of Object.keys(u)) {
		const kind = k.startsWith('bi.') ? k.slice(0, k.lastIndexOf('.')) : k;
		let g = by_kind.get(kind);
		if (!g) by_kind.set(kind, (g = {}));
		g[k] = u[k];
	}
	const steps_by_kind: Record<string, number> = {};
	for (const [kind, g] of by_kind) {
		const s = price_units(g, prices);
		if (s !== 0) steps_by_kind[kind] = s;
	}
	const builtin_calls: Record<string, number> = {};
	for (const k of Object.keys(u)) {
		if (k.startsWith('bi.') && k.endsWith('.calls')) builtin_calls[k.slice(3, -6)] = u[k];
	}
	return {
		steps_by_kind,
		builtin_calls,
		allocations: extra.allocations ?? u.alloc ?? null,
		bytes: extra.bytes ?? null,
		calls: extra.calls ?? u.call ?? null,
		input_size: extra.input_size ?? null,
		engine: extra.engine ?? null,
		node: extra.node ?? null
	};
}

/** Total steps of an input. */
export function input_steps(x: RangeInput): number {
	let s = 0;
	for (const v of Object.values(x.steps_by_kind)) s += v;
	return s;
}

/**
 * The linear part's row, the steps -> ns weights' own columns (calibrate/weights.ts FEATURES):
 * ops executed per op kind, built-in steps, dynamic steps and 1 for the call itself. Steps over
 * an op kind's price are its ops. (A column of all steps was tried too: the fit gave it 0.)
 */
export function linear_row(x: RangeInput, prices: Prices): number[] {
	const ops = OP_KINDS.map((k: OpKind) => {
		const p = prices.ops[k] ?? 0;
		const s = x.steps_by_kind[k] ?? 0;
		return p > 0 ? s / p : 0;
	});
	let builtin = 0;
	let dynamic = 0;
	for (const [k, v] of Object.entries(x.steps_by_kind)) {
		if (k.startsWith('bi.')) builtin += v;
		else if (k.startsWith('dyn.')) dynamic += v;
	}
	const row = [...ops, builtin, dynamic, 1];
	if (row.length !== FEATURES.length) throw new Error('heisenbench: linear row out of step');
	return row;
}

/**
 * The groups a share of steps is taken over. A built-in is grouped by what it works on; an op
 * kind by what the engine does with it.
 */
export const KIND_GROUPS = [
	'call',
	'property',
	'arith',
	'control',
	'alloc',
	'string_op',
	'loop',
	'dynamic',
	'bi_string',
	'bi_regexp',
	'bi_array',
	'bi_map',
	'bi_json',
	'bi_object',
	'bi_other'
] as const;

export type KindGroup = (typeof KIND_GROUPS)[number];

const OP_GROUP: Record<OpKind, KindGroup> = {
	call: 'call',
	new: 'call',
	await: 'call',
	yield: 'call',
	throw: 'call',
	prop_read: 'property',
	prop_write: 'property',
	arith: 'arith',
	unary: 'arith',
	update: 'arith',
	compare: 'control',
	logical: 'control',
	branch: 'control',
	assign: 'control',
	alloc: 'alloc',
	alloc_word: 'alloc',
	template: 'string_op',
	concat: 'string_op',
	iter_init: 'loop',
	iter_step: 'loop',
	forin_step: 'loop'
};

/** The group a kind of steps belongs to. */
export function group_of(kind: string): KindGroup {
	if (kind.startsWith('dyn.')) return 'dynamic';
	if (kind.startsWith('bi.')) {
		const k = kind.slice(3);
		if (k.startsWith('RegExp.') || /\.(match|matchAll|replace|replaceAll|search)$/.test(k))
			return 'bi_regexp';
		if (k.startsWith('String.')) return 'bi_string';
		if (k.startsWith('Array.') || k.includes('Array.prototype')) return 'bi_array';
		if (/^(Map|Set|WeakMap|WeakSet)\./.test(k)) return 'bi_map';
		if (k.startsWith('JSON.')) return 'bi_json';
		if (k.startsWith('Object.')) return 'bi_object';
		return 'bi_other';
	}
	return OP_GROUP[kind as OpKind] ?? 'control';
}

/** The group holding most of the steps: the input's "unit kind" in the coverage tables. */
export function main_group(x: RangeInput): KindGroup {
	const by = new Map<KindGroup, number>();
	for (const [k, v] of Object.entries(x.steps_by_kind)) {
		const g = group_of(k);
		by.set(g, (by.get(g) ?? 0) + v);
	}
	let best: KindGroup = 'control';
	let best_v = -Infinity;
	for (const g of KIND_GROUPS) {
		const v = by.get(g) ?? 0;
		if (v > best_v) {
			best = g;
			best_v = v;
		}
	}
	return best;
}

/** The trees' features, in order (`log_*` are natural logs of 1 + the value). */
export const TREE_FEATURES = [
	'log_linear_ns',
	'log_steps',
	...KIND_GROUPS.map((g) => `share_${g}`),
	'log_builtin_calls',
	'log_calls',
	'log_allocations',
	'log_bytes',
	'log_input_size',
	'turbofan_share',
	'unoptimized_share',
	'inlined_share',
	'log_deopts',
	'deoptimized',
	'polymorphic_share',
	'megamorphic_share',
	'node_major'
] as const;

const log1p = (v: number | null | undefined): number =>
	v === null || v === undefined || !Number.isFinite(v) ? NaN : Math.log1p(Math.max(0, v));

const ratio = (a: number, b: number): number => (b > 0 ? a / b : NaN);

/** The trees' feature vector of an input, given the linear baseline's ns for it. */
export function tree_row(x: RangeInput, linear_ns: number): number[] {
	const steps = input_steps(x);
	const by = new Map<KindGroup, number>();
	for (const [k, v] of Object.entries(x.steps_by_kind)) {
		const g = group_of(k);
		by.set(g, (by.get(g) ?? 0) + v);
	}
	const bcalls = x.builtin_calls ? Object.values(x.builtin_calls).reduce((s, v) => s + v, 0) : null;
	const e = x.engine ?? null;
	const node = x.node ? Number(/^v?(\d+)/.exec(x.node)?.[1] ?? NaN) : NaN;
	const row = [
		Math.log(Math.max(linear_ns, 1e-3)),
		log1p(steps),
		...KIND_GROUPS.map((g) => (steps > 0 ? (by.get(g) ?? 0) / steps : 0)),
		log1p(bcalls),
		log1p(x.calls),
		log1p(x.allocations),
		log1p(x.bytes),
		log1p(x.input_size),
		e ? ratio(e.turbofan, e.functions) : NaN,
		e ? ratio(e.interpreted + e.baseline, e.functions) : NaN,
		e ? ratio(e.inlined, e.functions) : NaN,
		e ? log1p(e.deopts) : NaN,
		e ? e.deoptimized : NaN,
		e ? ratio(e.polymorphic, e.sites) : NaN,
		e ? ratio(e.megamorphic, e.sites) : NaN,
		node
	];
	if (row.length !== TREE_FEATURES.length) throw new Error('heisenbench: tree row out of step');
	return row;
}
