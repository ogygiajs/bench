import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';

/*
 * Edge cases derived from the shapes the recorded inputs have. Each recorded input is a set of
 * places (its arguments and what they hold, breadth first): arrays, strings, numbers, booleans,
 * Maps, Sets and plain objects. Each variant changes one place in one way:
 *
 *   array    empty, its first element only, the first element twice more, every element twice,
 *            reversed, sorted, shuffled, its second half replaced by copies of its first (ties),
 *            its last element dropped
 *   string   empty, its first character, doubled, with accented, combining and astral characters;
 *            as lines: every line twice, reversed, the first only, the last dropped, CRLF line
 *            ends, tabs for spaces
 *   number   0, -0, 1, -1, NaN, Infinity, -Infinity, 2^53 - 1, a thousand times, plus a half
 *   boolean  flipped
 *   Map/Set  empty, the first entry only, reversed
 *   object   a key deleted, a key set to undefined (missing and undefined are told apart);
 *            only with `keys` (`heisenbench prove --edge all`)
 *
 * Every change but the last keeps each value's type and each object's keys: the input is still
 * one the function's types allow (a `t1: number` stays a number, NaN and -0 included). Deleting a
 * key makes an input its types rule out; that is opt-in, since a fix need not keep what the
 * original did with an input no caller can pass.
 *
 * The variants come from a seeded generator, so the same samples give the same variants on every
 * run. They are deduplicated by content. Values a recorder kept as portable functions (tagged
 * objects, coverage/portable.ts) are left as they are.
 */

const TAG = '__heisenbench_portable';

export type Path = Array<string | number>;

interface Site {
	path: Path;
	kind: 'array' | 'string' | 'number' | 'boolean' | 'map' | 'set' | 'object';
}

/** sfc32, the generator the determinism layer seeds randomness with. */
export function rng(seed: number): () => number {
	let a = 0x9e3779b9;
	let b = 0x243f6a88;
	let c = 0xb7e15162;
	let d = seed >>> 0;
	const next = (): number => {
		a >>>= 0;
		b >>>= 0;
		c >>>= 0;
		d >>>= 0;
		let t = (a + b) | 0;
		a = b ^ (b >>> 9);
		b = (c + (c << 3)) | 0;
		c = (c << 21) | (c >>> 11);
		d = (d + 1) | 0;
		t = (t + d) | 0;
		c = (c + t) | 0;
		return (t >>> 0) / 4294967296;
	};
	for (let i = 0; i < 12; i++) next();
	return next;
}

function is_plain(v: unknown): v is Record<string, unknown> {
	if (v === null || typeof v !== 'object') return false;
	const p = Object.getPrototypeOf(v);
	return p === Object.prototype || p === null;
}

function tagged(v: unknown): boolean {
	return is_plain(v) && typeof v[TAG] === 'string';
}

/** The places of `root` a variant can change, breadth first, at most `max`. */
export function sites(root: unknown, max = 48): Site[] {
	const out: Site[] = [];
	const seen = new Set<unknown>();
	const queue: Array<{ v: unknown; path: Path }> = [{ v: root, path: [] }];
	while (queue.length > 0 && out.length < max) {
		const { v, path } = queue.shift()!;
		if (typeof v === 'string') out.push({ path, kind: 'string' });
		else if (typeof v === 'number') out.push({ path, kind: 'number' });
		else if (typeof v === 'boolean') out.push({ path, kind: 'boolean' });
		if (v === null || typeof v !== 'object' || seen.has(v) || tagged(v)) continue;
		seen.add(v);
		if (Array.isArray(v)) {
			if (path.length > 0) out.push({ path, kind: 'array' });
			// the elements' places: the first two (their shapes repeat)
			for (let i = 0; i < Math.min(v.length, 2); i++) queue.push({ v: v[i], path: [...path, i] });
		} else if (v instanceof Map) {
			out.push({ path, kind: 'map' });
		} else if (v instanceof Set) {
			out.push({ path, kind: 'set' });
		} else if (is_plain(v)) {
			if (path.length > 0) out.push({ path, kind: 'object' });
			for (const k of Object.keys(v)) queue.push({ v: v[k], path: [...path, k] });
		}
	}
	return out;
}

function get(root: unknown, path: Path): unknown {
	let v = root;
	for (const k of path) v = (v as Record<string | number, unknown>)[k];
	return v;
}

/** `root` (a fresh copy, changed in place) with the value at `path` replaced. */
export function set_at(root: unknown, path: Path, value: unknown): unknown {
	if (path.length === 0) return value;
	const parent = get(root, path.slice(0, -1)) as Record<string | number, unknown>;
	parent[path[path.length - 1]] = value;
	return root;
}

function delete_at(root: unknown, path: Path): unknown {
	const parent = get(root, path.slice(0, -1)) as Record<string | number, unknown>;
	delete parent[path[path.length - 1]];
	return root;
}

function order_key(v: unknown): string {
	try {
		return typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
	} catch {
		return String(v);
	}
}

/** The changes of one place: each gives the new value from the old (a fresh copy). */
function changes(kind: Site['kind'], next: () => number): Array<[string, (v: never) => unknown]> {
	switch (kind) {
		case 'array':
			return [
				['empty', () => []],
				['one element', (v: unknown[]) => v.slice(0, 1)],
				[
					'the first twice more',
					(v: unknown[]) => (v.length ? [...v, structuredClone(v[0]), structuredClone(v[0])] : v)
				],
				['every element twice', (v: unknown[]) => v.flatMap((x) => [x, structuredClone(x)])],
				['reversed', (v: unknown[]) => [...v].reverse()],
				[
					'sorted',
					(v: unknown[]) =>
						[...v].sort((a, b) =>
							order_key(a) < order_key(b) ? -1 : order_key(a) > order_key(b) ? 1 : 0
						)
				],
				[
					'shuffled',
					(v: unknown[]) => {
						const out = [...v];
						for (let i = out.length - 1; i > 0; i--) {
							const j = Math.floor(next() * (i + 1));
							[out[i], out[j]] = [out[j], out[i]];
						}
						return out;
					}
				],
				[
					'ties',
					(v: unknown[]) =>
						v.map((x, i) =>
							i >= v.length / 2 ? structuredClone(v[i - Math.ceil(v.length / 2)]) : x
						)
				],
				['last dropped', (v: unknown[]) => v.slice(0, -1)]
			];
		case 'string':
			return [
				['empty', () => ''],
				['one character', (v: string) => v.slice(0, 1)],
				['doubled', (v: string) => v + v],
				['unicode', (v: string) => `é${v}😀`],
				['combining', (v: string) => `${v}é`],
				['astral only', () => '😀𝄞'],
				// a text of lines (source code, a log) has the shapes of a list
				[
					'every line twice',
					(v: string) =>
						v
							.split('\n')
							.flatMap((l) => [l, l])
							.join('\n')
				],
				['lines reversed', (v: string) => v.split('\n').reverse().join('\n')],
				['first line only', (v: string) => v.split('\n')[0]],
				['last line dropped', (v: string) => v.split('\n').slice(0, -1).join('\n')],
				['CRLF line ends', (v: string) => v.replace(/\r?\n/g, '\r\n')],
				['tabs for spaces', (v: string) => v.replace(/ {2}/g, '\t')]
			];
		case 'number':
			return [
				['0', () => 0],
				['-0', () => -0],
				['1', () => 1],
				['-1', () => -1],
				['NaN', () => NaN],
				['Infinity', () => Infinity],
				['-Infinity', () => -Infinity],
				['2^53 - 1', () => Number.MAX_SAFE_INTEGER],
				['a thousand times', (v: number) => v * 1000],
				['plus a half', (v: number) => v + 0.5]
			];
		case 'boolean':
			return [['flipped', (v: boolean) => !v]];
		case 'map':
			return [
				['empty', () => new Map()],
				['one entry', (v: Map<unknown, unknown>) => new Map([...v].slice(0, 1))],
				['reversed', (v: Map<unknown, unknown>) => new Map([...v].reverse())]
			];
		case 'set':
			return [
				['empty', () => new Set()],
				['one entry', (v: Set<unknown>) => new Set([...v].slice(0, 1))],
				['reversed', (v: Set<unknown>) => new Set([...v].reverse())]
			];
		case 'object':
			return [];
	}
}

function key_of(v: unknown): string | null {
	try {
		return createHash('sha1').update(serialize(v)).digest('hex');
	} catch {
		return null;
	}
}

export interface Variant {
	/** `args[0].resources: empty` */
	label: string;
	args: unknown[];
	this_value: unknown;
}

function path_text(path: Path): string {
	return 'args' + path.map((k) => (typeof k === 'number' ? `[${k}]` : `.${k}`)).join('');
}

/**
 * Up to `max` edge-case variants of one input (its arguments and `this`, as recorded), none equal
 * to an input in `seen` (content keys; every variant made is added to it).
 */
export function variants_of(
	input: { args: unknown[]; this_value: unknown },
	max: number,
	seed: number,
	seen: Set<string>,
	/** Also change the shape: delete keys and set them to undefined (`--edge all`). */
	keys = false
): Variant[] {
	const next = rng(seed);
	const root = { args: input.args, this_value: input.this_value };
	const all: Array<{ label: string; make: () => { args: unknown[]; this_value: unknown } }> = [];
	for (const s of sites(input.args)) {
		const path: Path = s.path;
		const where = path_text(path);
		for (const [name, change] of changes(s.kind, next)) {
			all.push({
				label: `${where}: ${name}`,
				make: () => {
					const copy = structuredClone(root);
					const old = get(copy.args, path);
					set_at(copy.args, path, change(old as never));
					return copy;
				}
			});
		}
		if (s.kind === 'object' && keys) {
			for (const k of Object.keys(get(input.args, path) as object).slice(0, 4)) {
				all.push({
					label: `${where}.${k}: deleted`,
					make: () => {
						const copy = structuredClone(root);
						delete_at(copy.args, [...path, k]);
						return copy;
					}
				});
				all.push({
					label: `${where}.${k}: undefined`,
					make: () => {
						const copy = structuredClone(root);
						set_at(copy.args, [...path, k], undefined);
						return copy;
					}
				});
			}
		}
	}
	// more than asked for: a seeded choice, kept in order
	let chosen = all;
	if (all.length > max) {
		const picked = new Set<number>();
		while (picked.size < max) picked.add(Math.floor(next() * all.length));
		chosen = [...picked].sort((a, b) => a - b).map((i) => all[i]);
	}
	const out: Variant[] = [];
	for (const v of chosen) {
		let made: { args: unknown[]; this_value: unknown };
		try {
			made = v.make();
		} catch {
			continue;
		}
		const key = key_of(made);
		if (key === null || seen.has(key)) continue;
		seen.add(key);
		out.push({ label: v.label, ...made });
	}
	return out;
}

/** The content key of an input (null when it cannot be serialized). */
export function input_key(input: { args: unknown[]; this_value: unknown }): string | null {
	return key_of({ args: input.args, this_value: input.this_value });
}

/**
 * Smaller copies of an input, one change each: an array element removed (halves first), a string
 * halved, a Map or Set entry removed, an object key deleted, a number made 0.
 */
export function reductions(
	input: { args: unknown[]; this_value: unknown },
	/** Delete object keys too (only when the edge cases may change shapes). */
	keys = false
): Array<{ args: unknown[]; this_value: unknown }> {
	const out: Array<{ args: unknown[]; this_value: unknown }> = [];
	const root = { args: input.args, this_value: input.this_value };
	for (const s of sites(input.args, 64)) {
		const v = get(input.args, s.path);
		const edit = (f: (old: never) => unknown): void => {
			try {
				const copy = structuredClone(root);
				set_at(copy.args, s.path, f(get(copy.args, s.path) as never));
				out.push(copy);
			} catch {
				// not cloneable here
			}
		};
		if (s.kind === 'array') {
			const n = (v as unknown[]).length;
			if (n > 1) {
				edit((a: unknown[]) => a.slice(0, Math.ceil(n / 2)));
				edit((a: unknown[]) => a.slice(Math.ceil(n / 2)));
			}
			for (let i = 0; i < Math.min(n, 16); i++) edit((a: unknown[]) => a.filter((_, j) => j !== i));
		} else if (s.kind === 'string' && (v as string).length > 1) {
			edit((x: string) => x.slice(0, Math.ceil(x.length / 2)));
			edit((x: string) => x.slice(Math.ceil(x.length / 2)));
		} else if (s.kind === 'map' && (v as Map<unknown, unknown>).size > 0) {
			edit((m: Map<unknown, unknown>) => new Map([...m].slice(1)));
		} else if (s.kind === 'set' && (v as Set<unknown>).size > 0) {
			edit((m: Set<unknown>) => new Set([...m].slice(1)));
		} else if (s.kind === 'number' && v !== 0) {
			edit(() => 0);
		} else if (s.kind === 'object' && keys) {
			for (const k of Object.keys(v as object)) {
				try {
					const copy = structuredClone(root);
					delete_at(copy.args, [...s.path, k]);
					out.push(copy);
				} catch {
					// not cloneable here
				}
			}
		}
	}
	return out;
}
