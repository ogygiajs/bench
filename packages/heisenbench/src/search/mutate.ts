import { clone } from '../growth/scale.ts';

/*
 * Input mutations for the slow-input search (spec 9). One mutation changes one place in the input:
 * a string (repeat a character, a run of one character, special characters, copy a piece over
 * another, reverse), an array (reverse, sort up or down, shuffle, swap, rotate, duplicate, all the
 * same), a number (edges: 0, -1, 1, -0, NaN, halves, negation; never bigger than it was, so a
 * size given as a number cannot grow the work), or nesting (wrap a value, nest an object in itself).
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
