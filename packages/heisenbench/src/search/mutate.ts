import { clone } from '../growth/scale.ts';
import { NEAR_COMMON, declared_grammar, infer_grammar, nodes_of, parse } from './grammar.ts';
import type { Grammar, GrammarOption, Node } from './grammar.ts';

/*
 * Input mutations for the slow-input search (spec 9). One mutation changes one place in the input:
 * a string (repeat a character, a run of one character, special characters, copy a piece over
 * another, reverse), an array (reverse, sort up or down, shuffle, swap, rotate, duplicate, all the
 * same), a number (edges: 0, -1, 1, -0, NaN, halves, negation; never bigger than it was, so a
 * size given as a number cannot grow the work), or nesting (wrap a value, nest an object in itself).
 *
 * `mutate_guided` edits a string by its grammar (grammar.ts) instead, so the input stays valid:
 * whole nodes are duplicated, nested in themselves, wrapped, swapped, repeated or spliced in from
 * another input, a leaf grows a run of one of its characters, and near-misses go in at node
 * boundaries. An edit that makes the input too big deletes other nodes (never the edited one) to
 * make room.
 */

type Obj = Record<string | number, unknown>;

/** sfc32-style generator: the same seed gives the same search on every machine. */
export class Rng {
	#s: Uint32Array;
	constructor(seed: number) {
		this.#s = new Uint32Array([0x9e3779b9, 0x243f6a88, 0xb7e15162, seed >>> 0]);
		for (let i = 0; i < 12; i++) this.u32();
	}
	u32(): number {
		const s = this.#s;
		const t = (((s[0] + s[1]) >>> 0) + s[3]) >>> 0;
		s[3] = (s[3] + 1) >>> 0;
		s[0] = s[1] ^ (s[1] >>> 9);
		s[1] = (s[2] + (s[2] << 3)) >>> 0;
		s[2] = (s[2] << 21) | (s[2] >>> 11);
		s[2] = (s[2] + t) >>> 0;
		return t;
	}
	/** Integer in [0, n). */
	int(n: number): number {
		return n <= 0 ? 0 : this.u32() % n;
	}
	pick<T>(list: readonly T[]): T {
		return list[this.int(list.length)];
	}
}

export const SPECIAL = [
	'a',
	'A',
	'0',
	' ',
	'\n',
	'\t',
	'(',
	')',
	'[',
	']',
	'{',
	'}',
	'*',
	'+',
	'?',
	'.',
	'\\',
	'/',
	'<',
	'>',
	'&',
	'"',
	"'",
	'=',
	':',
	';',
	',',
	'-',
	'_',
	'#',
	'%',
	'é',
	'\u0000'
];

type Path = Array<string | number>;

interface Place {
	path: Path;
	value: unknown;
}

function is_plain(v: unknown): v is Obj {
	if (v === null || typeof v !== 'object') return false;
	const p = Object.getPrototypeOf(v);
	return p === Object.prototype || p === null;
}

/** Every place a mutation can change: the root and everything under arrays and plain objects. */
function places(v: unknown, path: Path, out: Place[], depth: number): void {
	out.push({ path, value: v });
	if (depth > 8) return;
	if (Array.isArray(v)) {
		for (let i = 0; i < v.length; i++) places(v[i], [...path, i], out, depth + 1);
	} else if (is_plain(v)) {
		for (const k of Object.keys(v)) places(v[k], [...path, k], out, depth + 1);
	}
}

function set_at(root: unknown, path: Path, value: unknown): unknown {
	if (path.length === 0) return value;
	let cur = root as Obj;
	for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]] as Obj;
	cur[path[path.length - 1]] = value;
	return root;
}

function compare(a: unknown, b: unknown): number {
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	const x = typeof a === 'string' ? a : (JSON.stringify(a) ?? '');
	const y = typeof b === 'string' ? b : (JSON.stringify(b) ?? '');
	return x < y ? -1 : x > y ? 1 : 0;
}

function mutate_string(s: string, r: Rng): [string, string] {
	const n = s.length;
	if (n === 0) return [r.pick(SPECIAL), 'string: add a character'];
	const i = r.int(n);
	switch (r.int(8)) {
		case 0: {
			const j = r.int(n);
			return [s.slice(0, i) + s[j] + s.slice(i + 1), 'string: repeat a character'];
		}
		case 1: {
			const len = 1 + r.int(Math.max(1, n - i));
			return [
				s.slice(0, i) + s[i].repeat(len) + s.slice(i + len),
				'string: a run of one character'
			];
		}
		case 2:
			return [s.slice(0, i) + r.pick(SPECIAL) + s.slice(i + 1), 'string: special character'];
		case 3: {
			const from = r.int(n);
			const len = 1 + r.int(Math.max(1, Math.min(n - from, n - i)));
			return [
				s.slice(0, i) + s.slice(from, from + len) + s.slice(i + len),
				'string: copy a piece over another'
			];
		}
		case 4:
			return [[...s].reverse().join(''), 'string: reverse'];
		case 5:
			return [s.slice(0, i) + s.slice(i + 1), 'string: drop a character'];
		case 6:
			return [s.slice(0, i) + s[i] + s.slice(i), 'string: double a character'];
		default:
			return [s[i].repeat(n), 'string: all one character'];
	}
}

function mutate_array(a: unknown[], r: Rng): [unknown[], string] {
	const n = a.length;
	const b = a.slice();
	if (n === 0) return [b, 'array: empty'];
	const i = r.int(n);
	const j = r.int(n);
	switch (r.int(9)) {
		case 0:
			return [b.reverse(), 'array: reverse'];
		case 1:
			return [b.sort(compare), 'array: sort up'];
		case 2:
			return [b.sort((x, y) => compare(y, x)), 'array: sort down'];
		case 3:
			for (let k = n - 1; k > 0; k--) {
				const m = r.int(k + 1);
				const t = b[k];
				b[k] = b[m];
				b[m] = t;
			}
			return [b, 'array: shuffle'];
		case 4: {
			const t = b[i];
			b[i] = b[j];
			b[j] = t;
			return [b, 'array: swap two'];
		}
		case 5:
			return [b.slice(i).concat(b.slice(0, i)), 'array: rotate'];
		case 6:
			b[i] = clone(b[j]);
			return [b, 'array: duplicate an element'];
		case 7:
			b.splice(i, 1);
			return [b, 'array: drop an element'];
		default:
			return [b.map(() => clone(b[i])), 'array: all the same'];
	}
}

function mutate_number(x: number, r: Rng): [number, string] {
	const edges = [0, -1, 1, -0, Number.NaN, -x, Math.trunc(x / 2), x - 1, x / 2];
	const v = r.pick(edges);
	const limit = Math.max(1, Math.abs(x));
	return [Math.abs(v) <= limit || Number.isNaN(v) ? v : x, 'number: edge value'];
}

/** One mutation of a copy of `input`. Returns the new input and what was done. */
export function mutate(input: unknown, r: Rng): { input: unknown; what: string } {
	const root = clone(input);
	const list: Place[] = [];
	places(root, [], list, 0);
	const p = r.pick(list);
	const v = p.value;
	let next: unknown = v;
	let what = 'nothing';
	if (typeof v === 'string') [next, what] = mutate_string(v, r);
	else if (typeof v === 'number') [next, what] = mutate_number(v, r);
	else if (Array.isArray(v)) {
		if (r.int(6) === 0) {
			next = [clone(v)];
			what = 'nesting: wrap an array';
		} else {
			[next, what] = mutate_array(v, r);
		}
	} else if (is_plain(v)) {
		const keys = Object.keys(v);
		if (keys.length > 0 && r.int(2) === 0) {
			const k = r.pick(keys);
			const copy = { ...v };
			copy[k] = clone(v);
			next = copy;
			what = 'nesting: nest an object in itself';
		} else if (keys.length >= 2) {
			const a = r.pick(keys);
			const b = r.pick(keys);
			const copy = { ...v };
			copy[a] = v[b];
			copy[b] = v[a];
			next = copy;
			what = 'object: swap two values';
		}
	}
	const label = p.path.length > 0 ? `${what} at ${p.path.join('.')}` : what;
	return { input: set_at(root, p.path, next), what: label };
}

// ---------------------------------------------------------------- grammar plan

/** The grammar of each string place of an input: declared by the case, or inferred once. */
export class GrammarPlan {
	#option: GrammarOption | undefined;
	#by_shape = new Map<string, Grammar>();

	constructor(option?: GrammarOption) {
		this.#option = option;
	}

	/** The grammar of the string at `path` (one per place, array indices aside). */
	at(path: Path, s: string): Grammar {
		const shape = shape_of(path);
		let g = this.#by_shape.get(shape);
		if (!g) {
			g = declared_grammar(this.#option, path) ?? infer_grammar(s);
			this.#by_shape.set(shape, g);
		}
		return g;
	}

	/** `place -> grammar name`, for the report. */
	names(): Record<string, string> {
		const out: Record<string, string> = {};
		const keys = [...this.#by_shape.keys()].sort();
		for (const k of keys) out[k] = this.#by_shape.get(k)!.name;
		return out;
	}
}

/** `pages.*.body`: a path with its array indices as `*` (`<input>` for the root). */
export function shape_of(path: Path): string {
	if (path.length === 0) return '<input>';
	return path.map((p) => (typeof p === 'number' ? '*' : p)).join('.');
}

export function get_at(root: unknown, path: Path): unknown {
	let cur = root;
	for (const k of path) {
		if (cur === null || typeof cur !== 'object') return undefined;
		cur = (cur as Obj)[k];
	}
	return cur;
}

/** Every string of an input, with its path. */
export function string_places(input: unknown): Array<{ path: Path; value: string }> {
	const list: Place[] = [];
	places(input, [], list, 0);
	const out: Array<{ path: Path; value: string }> = [];
	for (const p of list) if (typeof p.value === 'string') out.push({ path: p.path, value: p.value });
	return out;
}

export function replace_at(input: unknown, path: Path, value: unknown): unknown {
	return set_at(clone(input), path, value);
}

// ---------------------------------------------------------------- node operators

/** An input's size and the bounds an edit must keep it in. */
export interface Room {
	size: number;
	min: number;
	max: number;
}

interface TextEdit {
	s: string;
	what: string;
	/** The edited span of the new string: making room never deletes inside it. */
	from: number;
	to: number;
}

const NODE_OPS: Array<[string, number]> = [
	['duplicate', 12],
	['nest', 12],
	['wrap', 6],
	['swap', 7],
	['repeat', 9],
	['run', 13],
	['near', 13],
	['atom', 6],
	['splice', 8],
	['delete', 6],
	['char', 8]
];
const NODE_OPS_TOTAL = NODE_OPS.reduce((n, [, w]) => n + w, 0);

function pick_node_op(r: Rng): string {
	let x = r.int(NODE_OPS_TOTAL);
	for (const [op, w] of NODE_OPS) {
		if (x < w) return op;
		x -= w;
	}
	return 'char';
}

function span(s: string, n: Node): string {
	return s.slice(n.start, n.end);
}

function insert_at(s: string, at: number, piece: string, what: string): TextEdit {
	return { s: s.slice(0, at) + piece + s.slice(at), what, from: at, to: at + piece.length };
}

function replace_node(s: string, n: Node, piece: string, what: string): TextEdit {
	return {
		s: s.slice(0, n.start) + piece + s.slice(n.end),
		what,
		from: n.start,
		to: n.start + piece.length
	};
}

/** One node operator on `s`. `grow`: characters it may add before room has to be made. */
function node_edit(s: string, g: Grammar, r: Rng, grow: number, donors: string[]): TextEdit | null {
	const all = nodes_of(parse(g, s));
	if (all.length === 0) {
		if (g.atoms.length === 0) return null;
		return insert_at(s, 0, r.pick(g.atoms), 'atom');
	}
	const n = r.pick(all);
	const text = span(s, n);
	const op = pick_node_op(r);
	switch (op) {
		case 'duplicate':
			return insert_at(s, n.end, text, `duplicate a ${n.key || 'node'}`);
		case 'nest': {
			if (!n.pair) break;
			const open = s.slice(n.start, n.inner_start);
			const close = s.slice(n.inner_end, n.end);
			return replace_node(s, n, open + text + close, `nest a ${n.key} in itself`);
		}
		case 'wrap': {
			if (g.wraps.length === 0) break;
			const [a, b] = r.pick(g.wraps);
			return replace_node(s, n, a + text + b, `wrap a ${n.key || 'node'}`);
		}
		case 'swap': {
			const sibs = n.parent?.kids ?? [];
			if (sibs.length < 2) break;
			let i = r.int(sibs.length);
			let j = r.int(sibs.length);
			if (i === j) j = (i + 1) % sibs.length;
			if (i > j) [i, j] = [j, i];
			const a = sibs[i];
			const b = sibs[j];
			return {
				s: s.slice(0, a.start) + span(s, b) + s.slice(a.end, b.start) + span(s, a) + s.slice(b.end),
				what: 'swap two siblings',
				from: a.start,
				to: b.end
			};
		}
		case 'repeat': {
			if (text.length === 0) break;
			const k = 2 + r.int(7);
			const times = Math.max(
				1,
				Math.min(k - 1, Math.floor(Math.max(grow, text.length) / text.length))
			);
			return insert_at(
				s,
				n.end,
				text.repeat(times),
				`repeat a ${n.key || 'node'} ${times + 1} times`
			);
		}
		case 'run': {
			// leaves only: a run inside an element's tags would break it
			if (n.inner_start !== n.start || text.length === 0) break;
			const ch = text[r.int(text.length)];
			const len = Math.max(
				text.length,
				Math.min(text.length * (2 + r.int(7)), text.length + Math.max(grow, 8))
			);
			return replace_node(s, n, ch.repeat(len), `a run of ${len} in a ${n.key}`);
		}
		case 'near': {
			const pool = g.near.length > 0 && r.int(3) > 0 ? g.near : NEAR_COMMON;
			const piece = r.pick(pool);
			const at = r.int(2) === 0 ? n.start : n.end;
			return insert_at(s, at, piece, `near-miss ${JSON.stringify(piece)}`);
		}
		case 'atom':
			if (g.atoms.length === 0) break;
			return insert_at(s, n.end, r.pick(g.atoms), 'insert a node');
		case 'splice': {
			const from = donors.length > 0 && r.int(2) === 0 ? r.pick(donors) : s;
			const other = nodes_of(parse(g, from), 4096);
			if (other.length === 0) break;
			return replace_node(s, n, span(from, r.pick(other)), 'splice a node over another');
		}
		case 'delete':
			return replace_node(s, n, '', `delete a ${n.key || 'node'}`);
		case 'char': {
			// one character inside the node, not a whole-string rewrite
			if (text.length === 0) break;
			const i = n.start + r.int(text.length);
			const c = r.int(3);
			if (c === 0)
				return { s: s.slice(0, i) + s.slice(i + 1), what: 'drop a character', from: i, to: i };
			const piece = c === 1 ? s[i] + s[i] : r.pick(SPECIAL);
			return {
				s: s.slice(0, i) + piece + s.slice(i + 1),
				what: 'change a character',
				from: i,
				to: i + piece.length
			};
		}
	}
	// the operator does not fit this node: copy it instead
	return insert_at(s, n.end, text, `duplicate a ${n.key || 'node'}`);
}

/** Delete nodes outside `[from, to)` until `s` is `excess` characters shorter, or null. */
function make_room(
	s: string,
	g: Grammar,
	r: Rng,
	from: number,
	to: number,
	excess: number
): string | null {
	for (let round = 0; round < 8 && excess > 0; round++) {
		const outside = nodes_of(parse(g, s)).filter((n) => n.end <= from || n.start >= to);
		if (outside.length === 0) return null;
		const big = outside.filter((n) => n.end - n.start >= excess);
		let n: Node;
		if (big.length > 0) {
			// the smallest node that makes enough room, so little else goes
			n = big.reduce((a, b) => (b.end - b.start < a.end - a.start ? b : a));
		} else n = r.pick(outside);
		const len = n.end - n.start;
		if (len === 0) continue;
		s = s.slice(0, n.start) + s.slice(n.end);
		if (n.end <= from) {
			from -= len;
			to -= len;
		}
		excess -= len;
	}
	return excess > 0 ? null : s;
}

/**
 * One grammar edit of an input: a string place picked by length (most of the time), edited by a
 * node operator of its grammar and kept inside `room`; otherwise a plain `mutate`.
 */
export function mutate_guided(
	input: unknown,
	r: Rng,
	plan: GrammarPlan,
	room: Room,
	donors: unknown[] = []
): { input: unknown; what: string } | null {
	const strings = string_places(input);
	if (strings.length === 0 || r.int(6) === 0) return mutate(input, r);
	let total = 0;
	const weights = strings.map((p) => (total += 1 + Math.floor(Math.sqrt(p.value.length))));
	const x = r.int(total);
	const p = strings[weights.findIndex((w) => x < w)];
	const g = plan.at(p.path, p.value);
	const others: string[] = [];
	for (const d of donors) {
		const v = get_at(d, p.path);
		if (typeof v === 'string' && v !== p.value) others.push(v);
	}
	const e = node_edit(p.value, g, r, room.max - room.size, others);
	if (!e) return null;
	let s = e.s;
	const size = room.size + s.length - p.value.length;
	if (size > room.max) {
		const fitted = make_room(s, g, r, e.from, e.to, size - room.max);
		if (fitted === null) return null;
		s = fitted;
	} else if (size < room.min) return null;
	const where = p.path.length > 0 ? ` at ${p.path.join('.')}` : '';
	return { input: replace_at(input, p.path, s), what: `${g.name}: ${e.what}${where}` };
}
