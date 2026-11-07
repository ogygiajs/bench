import { clone, data_keys, scale_input, shallow_copy } from '../growth/scale.ts';
import type { CaseReport } from '../report.ts';
import { nodes_of, parse } from './grammar.ts';
import type { Node } from './grammar.ts';
import { get_at, replace_at, string_places } from './mutate.ts';
import type { GrammarPlan } from './mutate.ts';

/*
 * After the search: the winning input made small, then grown again to see how its work scales.
 *
 * Shrinking is delta debugging over the input's strings and arrays: whole grammar nodes deleted or
 * unwrapped (a nesting level taken off), then pieces of characters or elements halved down to one
 * at a time, each change kept when the input still does what made it the winner (`accept`).
 *
 * Growing makes the shrunk input 1, 2, 4 and 8 times bigger in each way that fits it: `repeat` (the
 * generic scaler, strings and arrays repeated), `nest` (the deepest nesting of a string made deeper
 * with its own opening and closing pieces) and `case` (the case's own `scale`).
 */

type Obj = Record<string | number, unknown>;
type Path = Array<string | number>;

function is_plain(v: unknown): v is Obj {
	if (v === null || typeof v !== 'object') return false;
	const p = Object.getPrototypeOf(v);
	return p === Object.prototype || p === null;
}

/** The input with every string and collection emptied: what the case costs on next to nothing. */
export function emptied(v: unknown): unknown {
	if (typeof v === 'string') return '';
	if (Array.isArray(v)) return [];
	if (v instanceof Map) return new Map();
	if (v instanceof Set) return new Set();
	if (is_plain(v)) {
		const out = shallow_copy(v);
		for (const k of data_keys(v)) out[k] = emptied(v[k]);
		return out;
	}
	return v;
}

/** Every string and array of an input, biggest first (the root included). */
function shrink_places(input: unknown): Path[] {
	const out: Array<{ path: Path; size: number }> = [];
	const walk = (v: unknown, path: Path, depth: number): void => {
		if (typeof v === 'string') {
			if (v.length > 0) out.push({ path, size: v.length });
			return;
		}
		if (depth > 8) return;
		if (Array.isArray(v)) {
			if (v.length > 0) out.push({ path, size: v.length });
			for (let i = 0; i < v.length; i++) walk(v[i], [...path, i], depth + 1);
		} else if (is_plain(v)) {
			for (const k of data_keys(v)) walk(v[k], [...path, k], depth + 1);
		}
	};
	walk(input, [], 0);
	return out.sort((a, b) => b.size - a.size).map((p) => p.path);
}

export interface Shrunk {
	input: unknown;
	/** Inputs tried. */
	evals: number;
}

/**
 * The smallest input `accept` still takes, from `input` (which it takes), trying at most
 * `max_evals` candidates. Deterministic: the order of tries depends only on the input.
 */
export async function shrink(
	input: unknown,
	accept: (candidate: unknown) => Promise<boolean>,
	plan: GrammarPlan,
	max_evals: number
): Promise<Shrunk> {
	let cur = input;
	let evals = 0;
	const tried = new Set<string>();
	const try_one = async (candidate: unknown): Promise<boolean> => {
		if (evals >= max_evals) return false;
		// the same candidate twice (two nodes with one span) costs one try
		let key: string;
		try {
			key = JSON.stringify(candidate) ?? '';
		} catch {
			key = '';
		}
		if (key !== '' && tried.has(key)) return false;
		if (key !== '') tried.add(key);
		evals++;
		if (!(await accept(candidate))) return false;
		cur = candidate;
		return true;
	};
	let progress = true;
	while (progress && evals < max_evals) {
		progress = false;
		for (const path of shrink_places(cur)) {
			const v = get_at(cur, path);
			if (typeof v === 'string') {
				if (await shrink_nodes(cur, path, v, plan, try_one)) progress = true;
			}
			const now = get_at(cur, path);
			if (typeof now === 'string' || Array.isArray(now)) {
				if (await ddmin(cur, path, try_one)) progress = true;
			}
			if (evals >= max_evals) break;
		}
	}
	return { input: cur, evals };
}

/** Delete or unwrap whole grammar nodes of the string at `path`, biggest first. */
async function shrink_nodes(
	root: unknown,
	path: Path,
	s: string,
	plan: GrammarPlan,
	try_one: (candidate: unknown) => Promise<boolean>
): Promise<boolean> {
	const g = plan.at(path, s);
	let changed = false;
	let cur = s;
	let base = root;
	for (let round = 0; round < 64; round++) {
		const nodes = nodes_of(parse(g, cur), 512).sort(
			(a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start
		);
		let hit = false;
		for (const n of nodes) {
			// the node, a run of it and up to 3 following siblings (a JSON member), or its inside
			const sibs = n.parent?.kids ?? [n];
			const i = sibs.indexOf(n);
			const runs = [2, 3, 4]
				.filter((k) => i + k <= sibs.length)
				.map((k) => cur.slice(0, n.start) + cur.slice(sibs[i + k - 1].end));
			for (const next of [delete_node(cur, n), ...runs, unwrap_node(cur, n)]) {
				if (next === null || next === cur) continue;
				const candidate = replace_at(base, path, next);
				if (await try_one(candidate)) {
					cur = next;
					base = candidate;
					hit = changed = true;
					break;
				}
			}
			if (hit) break;
		}
		if (!hit) break;
	}
	return changed;
}

function delete_node(s: string, n: Node): string {
	return s.slice(0, n.start) + s.slice(n.end);
}

function unwrap_node(s: string, n: Node): string | null {
	if (!n.pair) return null;
	return s.slice(0, n.start) + s.slice(n.inner_start, n.inner_end) + s.slice(n.end);
}

/** Classic delta debugging over the characters or elements at `path`: remove pieces, halving. */
async function ddmin(
	root: unknown,
	path: Path,
	try_one: (candidate: unknown) => Promise<boolean>
): Promise<boolean> {
	let base = root;
	let v = get_at(base, path) as string | unknown[];
	let n = 2;
	let changed = false;
	while (v.length >= 1) {
		const len = v.length;
		const chunk = Math.max(1, Math.ceil(len / n));
		let hit = false;
		for (let start = 0; start < len; start += chunk) {
			const next =
				typeof v === 'string'
					? v.slice(0, start) + v.slice(start + chunk)
					: [...v.slice(0, start), ...v.slice(start + chunk)];
			const candidate = replace_at(base, path, next);
			if (await try_one(candidate)) {
				base = candidate;
				v = next;
				hit = changed = true;
				break;
			}
		}
		if (hit) n = Math.max(n - 1, 2);
		else if (chunk === 1) break;
		else n = Math.min(n * 2, len);
	}
	return changed;
}

// ---------------------------------------------------------------- growing

export type GrowWay = 'repeat' | 'nest' | 'case';

export interface Grower {
	way: GrowWay;
	/** The input about k times bigger (k a whole number). */
	make(k: number): unknown;
}

/** The ways an input can grow: the case's own scaler, repetition, and nesting where it has any. */
export function growers(
	input: unknown,
	plan: GrammarPlan,
	own?: (ctx: unknown, k: number) => unknown
): Grower[] {
	const out: Grower[] = [];
	if (own) out.push({ way: 'case', make: (k) => own(clone(input), k) });
	out.push({ way: 'repeat', make: (k) => scale_input(input, k) });
	const nest = nest_grower(input, plan);
	if (nest) out.push(nest);
	return out;
}

/**
 * The string with the deepest nesting, made deeper: the most common key on its deepest chain of
 * paired nodes, its outermost node on that chain wrapped in copies of its own opening and closing
 * pieces until the string is about k times longer.
 */
function nest_grower(input: unknown, plan: GrammarPlan): Grower | null {
	let best: { path: Path; s: string; open: string; close: string; at: Node; depth: number } | null =
		null;
	for (const p of string_places(input)) {
		const g = plan.at(p.path, p.value);
		const nodes = nodes_of(parse(g, p.value), 4096).filter((n) => n.pair);
		if (nodes.length === 0) continue;
		const deepest = nodes.reduce((a, b) => (b.depth > a.depth ? b : a));
		const chain: Node[] = [];
		for (let n: Node | null = deepest; n && n.parent; n = n.parent) if (n.pair) chain.push(n);
		const counts = new Map<string, number>();
		for (const n of chain) counts.set(n.key, (counts.get(n.key) ?? 0) + 1);
		let key = chain[0].key;
		for (const [k, c] of counts) if (c > (counts.get(key) ?? 0)) key = k;
		const at = chain.filter((n) => n.key === key).pop()!;
		const depth = counts.get(key)!;
		if (!best || depth > best.depth) {
			best = {
				path: p.path,
				s: p.value,
				open: p.value.slice(at.start, at.inner_start),
				close: p.value.slice(at.inner_end, at.end),
				at,
				depth
			};
		}
	}
	if (!best) return null;
	const { path, s, open, close, at } = best;
	const unit = open.length + close.length;
	if (unit === 0) return null;
	return {
		way: 'nest',
		make: (k: number) => {
			const m = Math.max(0, Math.round(((k - 1) * s.length) / unit));
			const grown =
				s.slice(0, at.start) +
				open.repeat(m) +
				s.slice(at.start, at.end) +
				close.repeat(m) +
				s.slice(at.end);
			return replace_at(input, path, grown);
		}
	};
}

// ---------------------------------------------------------------- blame

export interface Blame {
	/** `module:line`. */
	at: string;
	/** The function the line is in (`module > path`). */
	fn: string;
	/** Steps the line took past what `small` would predict at the bigger size. */
	extra: number;
	/** Its share of all the lines' extra steps. */
	share: number;
}

/**
 * Where the extra steps go between a small run and a big one: per line, the big run's steps past
 * `scale` times the small run's (scale = how much bigger the big input is), most first.
 */
export function blame(small: CaseReport, big: CaseReport, scale: number, max = 5): Blame[] {
	const before = new Map<string, number>();
	for (const f of small.functions)
		for (const l of f.lines) before.set(`${f.id}\u0000${l.line}`, l.steps);
	const rows: Array<Omit<Blame, 'share'>> = [];
	for (const f of big.functions) {
		for (const l of f.lines) {
			const extra = l.steps - scale * (before.get(`${f.id}\u0000${l.line}`) ?? 0);
			if (extra > 0) rows.push({ at: `${f.module}:${l.line}`, fn: f.id, extra });
		}
	}
	const total = rows.reduce((n, r) => n + r.extra, 0);
	return rows
		.sort((a, b) => b.extra - a.extra || (a.at < b.at ? -1 : 1))
		.slice(0, max)
		.map((r) => ({
			...r,
			extra: Math.round(r.extra),
			share: total > 0 ? Math.round((r.extra / total) * 1000) / 1000 : 0
		}))
		.filter((r) => r.share >= 0.01);
}
