import { clone, data_keys, shallow_copy } from '../growth/scale.ts';
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
 *
 * `mutate_arm` makes one edit with a given operator (an arm of the bandit schedule, bandit.ts):
 * the same edits, each operator by name, and `arms_of` lists the operators that can change an
 * input with their shares in `mutate_guided`'s fixed schedule.
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
		for (const k of data_keys(v)) places(v[k], [...path, k], out, depth + 1);
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
	const x = typeof a === 'string' ? a : text_of(a);
	const y = typeof b === 'string' ? b : text_of(b);
	return x < y ? -1 : x > y ? 1 : 0;
}

/** JSON of a value, or '' when it has none (or a getter in it throws). */
function text_of(v: unknown): string {
	try {
		return JSON.stringify(v) ?? '';
	} catch {
		return '';
	}
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

/** The array edits, in the order `mutate_array` numbers them. */
const ARRAY_OPS = [
	'reverse',
	'sort up',
	'sort down',
	'shuffle',
	'swap two',
	'rotate',
	'duplicate an element',
	'drop an element',
	'all the same'
];

/** One array edit: `op` (an index into ARRAY_OPS), or a random one. */
function mutate_array(a: unknown[], r: Rng, op?: number): [unknown[], string] {
	const n = a.length;
	const b = a.slice();
	if (n === 0) return [b, 'array: empty'];
	const i = r.int(n);
	const j = r.int(n);
	switch (op ?? r.int(9)) {
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
	const all: Place[] = [];
	places(root, [], all, 0);
	// only places a mutation can change: a class instance or a function stays as it is
	const list = all.filter(
		(x) =>
			typeof x.value === 'string' ||
			typeof x.value === 'number' ||
			Array.isArray(x.value) ||
			is_plain(x.value)
	);
	if (list.length === 0) return { input: root, what: 'nothing' };
	// half the time a collection, by the square root of its length: one array of 500 rows is not
	// drowned by the 2,000 values in its rows
	const lists = list.filter((x) => Array.isArray(x.value) && x.value.length > 1);
	let p = r.pick(list);
	if (lists.length > 0 && r.int(2) === 0) {
		let total = 0;
		const w = lists.map((x) => (total += Math.sqrt((x.value as unknown[]).length)));
		const at = r.u32() / 2 ** 32;
		p =
			lists[
				Math.max(
					0,
					w.findIndex((t) => at * total < t)
				)
			];
	}
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
		const keys = data_keys(v);
		if (keys.length > 0 && r.int(2) === 0) {
			const k = r.pick(keys);
			const copy = shallow_copy(v);
			copy[k] = clone(v);
			next = copy;
			what = 'nesting: nest an object in itself';
		} else if (keys.length >= 2) {
			const a = r.pick(keys);
			const b = r.pick(keys);
			const copy = shallow_copy(v);
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

/**
 * One node operator on `s`: `forced`, or one picked by NODE_OPS's weights. `grow`: characters it
 * may add before room has to be made.
 */
function node_edit(
	s: string,
	g: Grammar,
	r: Rng,
	grow: number,
	donors: string[],
	forced?: string
): TextEdit | null {
	const all = nodes_of(parse(g, s));
	if (all.length === 0) {
		if (g.atoms.length === 0) return null;
		return insert_at(s, 0, r.pick(g.atoms), 'atom');
	}
	const n = r.pick(all);
	const text = span(s, n);
	const op = forced ?? pick_node_op(r);
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
			// a quoted leaf (a string literal) keeps its quotes: the run goes between them
			const q = text[0];
			const quoted =
				text.length >= 2 && (q === '"' || q === "'" || q === '`') && text[text.length - 1] === q;
			const body = quoted ? text.slice(1, -1) : text;
			const ch = body.length > 0 ? body[r.int(body.length)] : 'a';
			if (quoted && (ch === '\\' || ch === q)) break;
			const len = Math.max(
				body.length,
				Math.min(Math.max(1, body.length) * (2 + r.int(7)), body.length + Math.max(grow, 8))
			);
			// half the runs end one character off (`aaaaaaab`): what makes a matcher backtrack
			let tail = '';
			if (r.int(2) === 0) {
				const c = r.pick(SPECIAL);
				if (c !== ch && !(quoted && (c === q || c === '\\' || c < ' '))) tail = c;
			}
			const piece = ch.repeat(len) + tail;
			const run = quoted ? q + piece + q : piece;
			return replace_node(
				s,
				n,
				run,
				`a run of ${len}${tail ? ` and ${JSON.stringify(tail)}` : ''} in a ${n.key}`
			);
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
			// inside a quoted leaf, the quotes stay and no quote or backslash goes in
			const q = text[0];
			const quoted =
				text.length >= 3 && (q === '"' || q === "'" || q === '`') && text[text.length - 1] === q;
			const i = quoted ? n.start + 1 + r.int(text.length - 2) : n.start + r.int(text.length);
			const c = r.int(3);
			if (c === 0)
				return { s: s.slice(0, i) + s.slice(i + 1), what: 'drop a character', from: i, to: i };
			let piece = c === 1 ? s[i] + s[i] : r.pick(SPECIAL);
			if (quoted && (piece === q || piece === '\\' || piece < ' ')) piece = '-';
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
	const was_valid = g.valid ? g.valid(s) : false;
	for (let round = 0; round < 8 && excess > 0; round++) {
		const outside = nodes_of(parse(g, s)).filter((n) => n.end <= from || n.start >= to);
		if (outside.length === 0) return null;
		// a node, or a run of up to 4 siblings (a JSON member is a key, a colon, a value and a comma)
		const spans: Array<{ start: number; end: number }> = [];
		for (const n of outside) {
			const sibs = n.parent?.kids ?? [n];
			const i = sibs.indexOf(n);
			for (let k = 0; k < 4 && i + k < sibs.length; k++) {
				const last = sibs[i + k];
				if (!(last.end <= from || n.start >= to)) break;
				spans.push({ start: n.start, end: last.end });
			}
		}
		const fits = (x: { start: number; end: number }): boolean =>
			x.end > x.start &&
			(!was_valid || g.valid!(s.slice(0, x.start) + s.slice(x.end))) &&
			(x.end <= from || x.start >= to);
		const big = spans.filter((x) => x.end - x.start >= excess);
		big.sort((a, b) => a.end - a.start - (b.end - b.start) || a.start - b.start);
		// the smallest span that makes enough room, so little else goes; else any that fits
		let x = big.find(fits);
		if (!x) {
			for (let tries = 0; tries < 8 && !x; tries++) {
				const y = r.pick(spans);
				if (fits(y)) x = y;
			}
		}
		if (!x) return null;
		const len = x.end - x.start;
		s = s.slice(0, x.start) + s.slice(x.end);
		if (x.end <= from) {
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
	const p = pick_string(strings, r);
	const g = plan.at(p.path, p.value);
	const others = donor_strings(donors, p);
	if (g.name === 'text' && r.int(2) === 0) return text_edit(input, p, strings, r, room);
	return grammar_edit(input, p, g, r, room, others);
}

type StringPlace = { path: Path; value: string };

/** A string place, picked by the square root of its length. */
function pick_string(strings: StringPlace[], r: Rng): StringPlace {
	let total = 0;
	const weights = strings.map((p) => (total += 1 + Math.floor(Math.sqrt(p.value.length))));
	const x = r.int(total);
	return strings[weights.findIndex((w) => x < w)];
}

/** The other inputs' strings at the same place (what a splice can take a node from). */
function donor_strings(donors: unknown[], p: StringPlace): string[] {
	const others: string[] = [];
	for (const d of donors) {
		const v = get_at(d, p.path);
		if (typeof v === 'string' && v !== p.value) others.push(v);
	}
	return others;
}

function where(p: { path: Path }): string {
	return p.path.length > 0 ? ` at ${p.path.join('.')}` : '';
}

/**
 * A plain string edit of `p`, some of them a run of a character of another string of the input
 * (what the code compares it with). Plain text has no structure to keep.
 */
function text_edit(
	input: unknown,
	p: StringPlace,
	strings: StringPlace[],
	r: Rng,
	room: Room
): { input: unknown; what: string } | null {
	const other = strings.filter((q) => q !== p && q.value.length > 0);
	let [s, what] = mutate_string(p.value, r);
	if (other.length > 0 && p.value.length > 0 && r.int(3) === 0) {
		const q = r.pick(other);
		const ch = q.value[r.int(q.value.length)];
		const i = r.int(p.value.length);
		const len = 1 + r.int(p.value.length - i);
		s = p.value.slice(0, i) + ch.repeat(len) + p.value.slice(i + len);
		what = `string: a run of a character of ${q.path.join('.') || 'the input'}`;
	}
	const size = room.size + s.length - p.value.length;
	if (size > room.max || size < room.min) return null;
	return { input: replace_at(input, p.path, s), what: `${what}${where(p)}` };
}

/** A node operator of `p`'s grammar (`op`, or one by NODE_OPS's weights), kept inside `room`. */
function grammar_edit(
	input: unknown,
	p: StringPlace,
	g: Grammar,
	r: Rng,
	room: Room,
	others: string[],
	op?: string
): { input: unknown; what: string } | null {
	const e = node_edit(p.value, g, r, room.max - room.size, others, op);
	if (!e) return null;
	let s = e.s;
	const size = room.size + s.length - p.value.length;
	if (size > room.max) {
		const fitted = make_room(s, g, r, e.from, e.to, size - room.max);
		if (fitted === null) return null;
		s = fitted;
	} else if (size < room.min) return null;
	return { input: replace_at(input, p.path, s), what: `${g.name}: ${e.what}${where(p)}` };
}

// ---------------------------------------------------------------- operators as arms

/**
 * Every operator the bandit schedule picks between, by name: the grammar's node operators, each
 * plain string edit, each array edit, and the number and object edits.
 */
export const ARMS: readonly string[] = [
	...NODE_OPS.map(([op]) => `node: ${op}`),
	'string: edit',
	...ARRAY_OPS.map((op) => `array: ${op}`),
	'array: wrap',
	'number: edge value',
	'object: nest in itself',
	'object: swap two values'
];

/** The places of a copy of `input` an operator can change, by kind. */
interface Kinds {
	root: unknown;
	strings: StringPlace[];
	arrays: Place[];
	numbers: Place[];
	objects: Place[];
}

/** `copy`: the places of a copy (to edit), else of `input` itself (to look at). */
function kinds_of(input: unknown, copy = true): Kinds {
	const root = copy ? clone(input) : input;
	const all: Place[] = [];
	places(root, [], all, 0);
	const k: Kinds = { root, strings: [], arrays: [], numbers: [], objects: [] };
	for (const p of all) {
		const v = p.value;
		if (typeof v === 'string') k.strings.push({ path: p.path, value: v });
		else if (typeof v === 'number') k.numbers.push(p);
		else if (Array.isArray(v)) k.arrays.push(p);
		else if (is_plain(v) && data_keys(v).length > 0) k.objects.push(p);
	}
	return k;
}

/** An operator that can change an input, and how often the fixed schedule runs it there. */
export interface ArmChoice {
	arm: string;
	weight: number;
}

/**
 * The arms that can change `input`, in ARMS order, each with about its share of the fixed
 * schedule (`mutate_guided`). One try in six is a plain edit (`mutate`): half the time an array
 * (when one has two elements or more), else any place, then an edit for its kind. The rest are
 * grammar edits, by NODE_OPS's weights, except that half the edits of a plain-text string are
 * plain string edits.
 */
export function arms_of(input: unknown, plan: GrammarPlan): ArmChoice[] {
	const k = kinds_of(input, false);
	const swap = k.objects.filter((p) => data_keys(p.value as Obj).length >= 2).length;
	// the share of string picks that land on plain text
	let all = 0;
	let text = 0;
	for (const p of k.strings) {
		const w = 1 + Math.floor(Math.sqrt(p.value.length));
		all += w;
		if (plan.at(p.path, p.value).name === 'text') text += w;
	}
	const t = all > 0 ? text / all : 0;
	const guided = k.strings.length > 0 ? 5 / 6 : 0;
	// a plain edit's place, by kind
	const places = k.strings.length + k.arrays.length + k.numbers.length + k.objects.length;
	const lists = k.arrays.some((p) => (p.value as unknown[]).length > 1) ? 1 / 2 : 0;
	const share = (n: number): number => ((1 - guided) * (1 - lists) * n) / Math.max(1, places);
	const out: ArmChoice[] = [];
	for (const arm of ARMS) {
		let weight = 0;
		if (arm.startsWith('node: ')) {
			const w = NODE_OPS.find(([op]) => `node: ${op}` === arm)![1];
			weight = (guided * (1 - t / 2) * w) / NODE_OPS_TOTAL;
		} else if (arm === 'string: edit') {
			weight = share(k.strings.length) + (guided * t) / 2;
		} else if (arm.startsWith('array: ')) {
			const a = share(k.arrays.length) + (k.arrays.length > 0 ? (1 - guided) * lists : 0);
			weight = arm === 'array: wrap' ? a / 6 : (a * 5) / 6 / ARRAY_OPS.length;
		} else if (arm === 'number: edge value') {
			weight = share(k.numbers.length);
		} else if (arm === 'object: swap two values') {
			weight = share(swap) / 2;
		} else {
			weight = share(k.objects.length) - share(swap) / 2;
		}
		if (weight > 0) out.push({ arm, weight });
	}
	return out;
}

/** An array place: by the square root of its length, so one long list is not drowned out. */
function pick_array(list: Place[], r: Rng): Place {
	let total = 0;
	const w = list.map((x) => (total += 1 + Math.sqrt((x.value as unknown[]).length)));
	const at = r.u32() / 2 ** 32;
	return list[
		Math.max(
			0,
			w.findIndex((t) => at * total < t)
		)
	];
}

/**
 * One edit of `input` by the operator `arm`, at a place it applies to (null when it has none, or
 * the edit does not fit `room`).
 */
export function mutate_arm(
	input: unknown,
	arm: string,
	r: Rng,
	plan: GrammarPlan,
	room: Room,
	donors: unknown[] = []
): { input: unknown; what: string } | null {
	const k = kinds_of(input);
	if (arm.startsWith('node: ') || arm === 'string: edit') {
		if (k.strings.length === 0) return null;
		const p = pick_string(k.strings, r);
		if (arm === 'string: edit') return text_edit(input, p, k.strings, r, room);
		const g = plan.at(p.path, p.value);
		return grammar_edit(input, p, g, r, room, donor_strings(donors, p), arm.slice(6));
	}
	let p: Place;
	let next: unknown;
	let what: string;
	if (arm.startsWith('array: ')) {
		if (k.arrays.length === 0) return null;
		p = pick_array(k.arrays, r);
		const v = p.value as unknown[];
		if (arm === 'array: wrap') [next, what] = [[clone(v)], 'nesting: wrap an array'];
		else [next, what] = mutate_array(v, r, ARRAY_OPS.indexOf(arm.slice(7)));
	} else if (arm === 'number: edge value') {
		if (k.numbers.length === 0) return null;
		p = r.pick(k.numbers);
		[next, what] = mutate_number(p.value as number, r);
	} else {
		const list =
			arm === 'object: swap two values'
				? k.objects.filter((x) => data_keys(x.value as Obj).length >= 2)
				: k.objects;
		if (list.length === 0) return null;
		p = r.pick(list);
		const v = p.value as Obj;
		const keys = data_keys(v);
		const copy = shallow_copy(v);
		if (arm === 'object: nest in itself') {
			copy[r.pick(keys)] = clone(v);
			what = 'nesting: nest an object in itself';
		} else {
			const a = r.pick(keys);
			const b = r.pick(keys);
			copy[a] = v[b];
			copy[b] = v[a];
			what = 'object: swap two values';
		}
		next = copy;
	}
	// like `mutate`, the caller checks the size
	const label = p.path.length > 0 ? `${what} at ${p.path.join('.')}` : what;
	return { input: set_at(k.root, p.path, next), what: label };
}
