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

export function show(v: unknown, depth = 0, seen: unknown[] = []): string {
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
		if (o instanceof Error) return `${o.name}(${JSON.stringify(o.message)})`;
		if (o instanceof Promise) return 'Promise';
		if (o instanceof Map) {
			let s = 'Map{';
			for (const [k, x] of o) s += `${show(k, depth + 1, seen)}=>${show(x, depth + 1, seen)},`;
			return s + '}';
		}
		if (o instanceof Set) {
			let s = 'Set{';
			for (const x of o) s += `${show(x, depth + 1, seen)},`;
			return s + '}';
		}
		if (is_array(o)) {
			let s = '[';
			for (let i = 0; i < o.length; i++)
				s += (i in o ? show(o[i], depth + 1, seen) : '<hole>') + ',';
			return s + ']';
		}
		const keys = own_keys(o);
		let s = name_of(o) + '{';
		for (let i = 0; i < keys.length; i++) {
			let x: unknown;
			try {
				x = (o as Record<string, unknown>)[keys[i]];
			} catch (e) {
				x = e;
			}
			s += `${keys[i]}:${show(x, depth + 1, seen)},`;
		}
		return s + '}';
	} finally {
		seen.pop();
	}
}

/**
 * An error as text. V8 builds some messages from the source text of the expression that failed
 * (`x.y is not a function`, `x is not iterable`); instrumentation wraps those expressions, so the
 * quoted part is dropped and only the kind of failure is kept.
 */
export function show_error(e: unknown): string {
	if (!(e instanceof Error)) return `throw ${show(e)}`;
	let m = e.message;
	for (const tail of [
		' is not a function',
		' is not iterable',
		' is not async iterable',
		' is not a constructor',
		' is not defined'
	]) {
		const at = m.indexOf(tail);
		if (at !== -1) m = '…' + m.slice(at);
	}
	return `${e.name}(${JSON.stringify(m)})`;
}
