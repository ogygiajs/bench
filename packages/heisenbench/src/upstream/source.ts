/*
 * A recorded value as JavaScript source, for a reproduction script to rebuild it: strings,
 * numbers, arrays, plain objects, Map, Set, Date, RegExp, and functions the recorder kept as their
 * source (coverage/portable.ts). Anything else (a class instance, a Node module, a callback that
 * closed over state) has no source a stranger could run, and is refused with what it is.
 */

const TAG = '__heisenbench_portable';
const IDENT = /^[A-Za-z_$][\w$]*$/;
/** A value nested deeper than this is refused (a recorded AST would make an unreadable script). */
const MAX_DEPTH = 24;

export class NoSource extends Error {}

function key(k: string): string {
	return IDENT.test(k) ? k : JSON.stringify(k);
}

export function to_source(v: unknown, indent = '', depth = 0): string {
	if (depth > MAX_DEPTH) throw new NoSource('a value nested too deep');
	const inner = indent + '\t';
	if (v === undefined) return 'undefined';
	if (v === null) return 'null';
	switch (typeof v) {
		case 'string':
			return JSON.stringify(v);
		case 'boolean':
			return String(v);
		case 'number':
			if (Number.isNaN(v)) return 'NaN';
			if (Object.is(v, -0)) return '-0';
			if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
			return String(v);
		case 'bigint':
			return `${v}n`;
		case 'function':
			throw new NoSource('a function');
		case 'symbol':
			throw new NoSource('a symbol');
	}
	if (Array.isArray(v)) {
		if (v.length === 0) return '[]';
		const items = v.map((x) => to_source(x, inner, depth + 1));
		const flat = `[${items.join(', ')}]`;
		if (flat.length <= 80 && !flat.includes('\n')) return flat;
		return `[\n${items.map((x) => inner + x).join(',\n')}\n${indent}]`;
	}
	if (v instanceof Map) {
		return `new Map(${to_source(
			[...v].map(([a, b]) => [a, b]),
			indent,
			depth + 1
		)})`;
	}
	if (v instanceof Set) return `new Set(${to_source([...v], indent, depth + 1)})`;
	if (v instanceof Date) return `new Date(${JSON.stringify(v.toISOString())})`;
	if (v instanceof RegExp) return String(v);
	const proto = Object.getPrototypeOf(v) as unknown;
	if (proto !== Object.prototype && proto !== null)
		throw new NoSource(`an instance of ${(v as object).constructor?.name ?? 'a class'}`);
	const o = v as Record<string, unknown>;
	const tag = o[TAG];
	if (tag === 'fn') {
		const src = String(o.src);
		// a method kept as `name(a) { ... }` becomes a function expression
		return o.method ? `function ${src}` : src;
	}
	if (tag !== undefined)
		throw new NoSource(tag === 'module' ? 'a Node module' : 'a callback that closed over state');
	const entries = Object.entries(o);
	if (entries.length === 0) return '{}';
	const parts = entries.map(([k, x]) => `${key(k)}: ${to_source(x, inner, depth + 1)}`);
	const flat = `{ ${parts.join(', ')} }`;
	if (flat.length <= 80 && !flat.includes('\n')) return flat;
	return `{\n${parts.map((x) => inner + x).join(',\n')}\n${indent}}`;
}
