/*
 * A value as text, at the moment it is logged (objects change later). Written with plain loops and
 * no priced built-ins, so formatting a value never charges the function that logged it. Functions
 * print as their name, never their source (instrumentation changes the source).
 */

const own_keys = Object.keys;
const get_proto = Object.getPrototypeOf;
const is_array = Array.isArray;

function name_of(v: object): string {
	const proto = get_proto(v) as { constructor?: { name?: string } } | null;
	const c = proto && proto.constructor;
	return c && typeof c.name === 'string' ? c.name : 'null';
}

/**
 * How much of one value is written. A program can nest a capped array in itself again and again
 * (`g = cap([g].concat(g))`): every level shares the one below, so the value is small and its text
 * grows by the width at each level (48⁴ leaves at depth 3, seed 305890).
 */
const LIMIT = 4096;
let left = 0;

export function show(v: unknown): string {
	left = LIMIT;
	return go(v, 0, []);
}

/** `piece` added to `s`, or `…` once the budget is spent (then the caller stops). */
function add(s: string, piece: string): string {
	left -= piece.length;
	return s + piece;
}

function go(v: unknown, depth: number, seen: unknown[]): string {
	switch (typeof v) {
		case 'number':
			return Object.is(v, -0) ? '-0' : String(v);
		case 'string':
			return JSON.stringify(v);
		case 'boolean':
		case 'undefined':
			return String(v);
		case 'bigint':
			return `${v}n`;
		case 'symbol':
			return `Symbol(${v.description ?? ''})`;
		case 'function':
			return `fn:${(v as { name?: string }).name ?? ''}`;
	}
	if (v === null) return 'null';
	const o = v as object;
	for (let i = 0; i < seen.length; i++) if (seen[i] === o) return '<cycle>';
	if (depth > 3) return '<deep>';
	seen.push(o);
	try {
		if (o instanceof Error) return show_error(o);
		if (o instanceof Promise) return 'Promise';
		if (o instanceof Map) {
			let s = 'Map{';
			for (const [k, x] of o) {
				if (left <= 0) return s + '…}';
				s = add(s, `${go(k, depth + 1, seen)}=>${go(x, depth + 1, seen)},`);
			}
			return s + '}';
		}
		if (o instanceof Set) {
			let s = 'Set{';
			for (const x of o) {
				if (left <= 0) return s + '…}';
				s = add(s, `${go(x, depth + 1, seen)},`);
			}
			return s + '}';
		}
		if (is_array(o)) {
			let s = '[';
			for (let i = 0; i < o.length; i++) {
				if (left <= 0) return s + '…]';
				s = add(s, (i in o ? go(o[i], depth + 1, seen) : '<hole>') + ',');
			}
			return s + ']';
		}
		const keys = own_keys(o);
		let s = name_of(o) + '{';
		for (let i = 0; i < keys.length; i++) {
			if (left <= 0) return s + '…}';
			let x: unknown;
			try {
				x = (o as Record<string, unknown>)[keys[i]];
			} catch (e) {
				x = e;
			}
			s = add(s, `${keys[i]}:${go(x, depth + 1, seen)},`);
		}
		return s + '}';
	} finally {
		seen.pop();
	}
}

/**
 * An error as text. V8 builds TypeError messages from the source text of the expression that
 * failed (`x.y is not a function`, `Cannot destructure property 'a' of '(f() && {...})'`), and
 * instrumentation wraps those expressions: a TypeError is compared by its kind only. Other errors
 * (the program's own, RangeError, ReferenceError) keep their message.
 */
export function show_error(e: unknown): string {
	if (!(e instanceof Error)) return `throw ${show(e)}`;
	if (e.name === 'TypeError') return 'TypeError(…)';
	return `${e.name}(${JSON.stringify(e.message)})`;
}
