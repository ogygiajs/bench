/*
 * Inputs for timing each priced built-in at a size (calibrate/prices.ts). `make(n)` returns the
 * receiver and arguments of one call; `fresh` marks built-ins that change their receiver, which
 * then gets a new copy before every timed call (outside the timing). The size the curve is fitted
 * against is the size the runtime charges for (builtins.ts `builtin_size`), measured on the call.
 */

export interface BuiltinInput {
	self: unknown;
	args: unknown[];
}

export interface InputMaker {
	/**
	 * One call's input at size `n`. `shape` picks one of `shapes` kinds of input of that size,
	 * for a built-in priced by size terms besides n (prices.ts SIZE_TERMS): a `split` cutting the
	 * same characters into few parts or many, so the fit can tell the two costs apart.
	 */
	make: (n: number, shape?: number) => BuiltinInput;
	fresh?: boolean;
	/** How many shapes `make` has (default 1). */
	shapes?: number;
}

/** `n` characters with `sep` after every `every - 1` others. */
function separated(n: number, every: number, sep = ','): string {
	const unit = 'x'.repeat(every - 1) + sep;
	return unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
}

/** Values whose JSON is about n characters: numbers, small records, long strings. */
function json_shapes(): Array<(n: number) => unknown> {
	return [
		(n) => numbers(Math.ceil(n / 6)),
		(n) => Array.from({ length: Math.ceil(n / 24) }, (_, i) => ({ id: i, tag: 'ab' })),
		(n) => Array.from({ length: Math.ceil(n / 67) }, () => text(64))
	];
}

/** Input shapes for the built-ins with size terms: each a function of n. */
function shaped(makes: Array<(n: number) => BuiltinInput>): InputMaker {
	return { make: (n, shape = 0) => makes[shape](n), shapes: makes.length };
}

// The line break regex a JavaScript parser splits source code by.
const LINE_BREAK = new RegExp('\\r\\n?|\\n|\\u2028|\\u2029');
const DENSITIES = [2, 8, 32, 256];

function numbers(n: number): number[] {
	// a fixed shuffle: sorting work does not depend on the seed
	const out: number[] = [];
	let x = 1;
	for (let i = 0; i < n; i++) {
		x = (x * 1103515245 + 12345) % 2147483648;
		out.push(x % 100000);
	}
	return out;
}

function text(n: number): string {
	return 'abcdefghij,'.repeat(Math.ceil(n / 11)).slice(0, n);
}

function record(n: number): Record<string, number> {
	const o: Record<string, number> = {};
	for (let i = 0; i < n; i++) o['k' + i] = i;
	return o;
}

function map_of(n: number): Map<number, number> {
	const m = new Map<number, number>();
	for (let i = 0; i < n; i++) m.set(i, i);
	return m;
}

const arr = (args: (n: number) => unknown[] = () => [], fresh = false): InputMaker => ({
	make: (n) => ({ self: numbers(n), args: args(n) }),
	fresh
});
const str = (args: (n: number) => unknown[] = () => []): InputMaker => ({
	make: (n) => ({ self: text(n), args: args(n) })
});

/** Strings of `n` characters with a comma every `d`, replaced by a string, then by a callback. */
function replacing(pattern: unknown): InputMaker {
	const every = [2, 16, 128];
	return shaped([
		...every.map((d) => (n: number) => ({ self: separated(n, d), args: [pattern, ';'] })),
		...every.map((d) => (n: number) => ({
			self: separated(n, d),
			args: [pattern, (m: string) => m + ';']
		}))
	]);
}

export const INPUTS: Record<string, InputMaker> = {
	'Array.prototype.sort': arr(() => [(a: number, b: number) => a - b], true),
	'Array.prototype.toSorted': arr(() => [(a: number, b: number) => a - b]),
	'Array.prototype.slice': arr(),
	'Array.prototype.splice': arr((n) => [0, n], true),
	'Array.prototype.map': arr(() => [(x: number) => x + 1]),
	'Array.prototype.filter': arr(() => [(x: number) => (x & 1) === 0]),
	'Array.prototype.reduce': arr(() => [(a: number, b: number) => a + b, 0]),
	'Array.prototype.reduceRight': arr(() => [(a: number, b: number) => a + b, 0]),
	'Array.prototype.forEach': arr(() => [() => {}]),
	'Array.prototype.some': arr(() => [(x: number) => x < 0]),
	'Array.prototype.every': arr(() => [(x: number) => x >= 0]),
	'Array.prototype.find': arr(() => [(x: number) => x < 0]),
	'Array.prototype.findIndex': arr(() => [(x: number) => x < 0]),
	'Array.prototype.flatMap': arr(() => [(x: number) => [x]]),
	'Array.prototype.flat': {
		make: (n) => ({ self: numbers(n).map((x) => [x]), args: [] })
	},
	'Array.prototype.indexOf': arr(() => [-1]),
	'Array.prototype.lastIndexOf': arr(() => [-1]),
	'Array.prototype.includes': arr(() => [-1]),
	// numbers, then strings of 8 and 64 characters: elements and characters apart
	'Array.prototype.join': shaped([
		(n) => ({ self: numbers(n), args: [','] }),
		(n) => ({ self: Array.from({ length: Math.ceil(n / 8) }, () => 'abcdefgh'), args: [','] }),
		(n) => ({ self: Array.from({ length: Math.ceil(n / 64) }, () => text(64)), args: [','] })
	]),
	'Array.prototype.concat': arr((n) => [numbers(n)]),
	'Array.prototype.reverse': arr(() => [], true),
	'Array.prototype.fill': arr(() => [0], true),
	'Array.from': shaped([
		(n) => ({ self: Array, args: [numbers(n)] }),
		(n) => ({ self: Array, args: [numbers(n), (x: number) => x + 1] })
	]),
	// the same characters cut into many parts or few, by a string and by a regex
	'String.prototype.split': shaped([
		...DENSITIES.map((d) => (n: number) => ({ self: separated(n, d), args: [','] })),
		...[8, 64].map((d) => (n: number) => ({ self: separated(n, d, '\n'), args: [LINE_BREAK] }))
	]),
	'String.prototype.slice': str(() => [0]),
	'String.prototype.substring': str(() => [0]),
	// few matches or many, replaced by a string or by a callback
	'String.prototype.replace': replacing(/,/g),
	'String.prototype.replaceAll': replacing(','),
	'String.prototype.indexOf': str(() => ['#']),
	'String.prototype.includes': str(() => ['#']),
	'String.prototype.startsWith': { make: (n) => ({ self: text(n), args: [text(n)] }) },
	'String.prototype.endsWith': { make: (n) => ({ self: text(n), args: [text(n)] }) },
	'String.prototype.trim': { make: (n) => ({ self: ` ${text(n)} `, args: [] }) },
	'String.prototype.toLowerCase': { make: (n) => ({ self: text(n).toUpperCase(), args: [] }) },
	'String.prototype.toUpperCase': str(),
	'String.prototype.repeat': { make: (n) => ({ self: 'a', args: [n] }) },
	'String.prototype.padStart': { make: (n) => ({ self: 'a', args: [n] }) },
	'String.prototype.padEnd': { make: (n) => ({ self: 'a', args: [n] }) },
	'String.prototype.match': shaped(
		[2, 16, 128].map((d) => (n: number) => ({ self: separated(n, d), args: [/,/g] }))
	),
	'String.prototype.matchAll': str(() => [/a/g]),
	'RegExp.prototype.exec': { make: (n) => ({ self: /#/, args: [text(n)] }) },
	'RegExp.prototype.test': { make: (n) => ({ self: /#/, args: [text(n)] }) },
	// numbers, small records and long strings: values and characters apart
	'JSON.stringify': shaped(json_shapes().map((v) => (n: number) => ({ self: JSON, args: [v(n)] }))),
	'JSON.parse': shaped(
		json_shapes().map((v) => (n: number) => ({ self: JSON, args: [JSON.stringify(v(n))] }))
	),
	structuredClone: { make: (n) => ({ self: globalThis, args: [numbers(n)] }) },
	'Object.keys': { make: (n) => ({ self: Object, args: [record(n)] }) },
	'Object.values': { make: (n) => ({ self: Object, args: [record(n)] }) },
	'Object.entries': { make: (n) => ({ self: Object, args: [record(n)] }) },
	'Object.assign': { make: (n) => ({ self: Object, args: [{}, record(n)] }) },
	'Object.fromEntries': { make: (n) => ({ self: Object, args: [Object.entries(record(n))] }) },
	'Map.prototype.get': { make: (n) => ({ self: map_of(n), args: [n >> 1] }) },
	'Map.prototype.set': { make: (n) => ({ self: map_of(n), args: [n >> 1, 1] }) },
	'Map.prototype.has': { make: (n) => ({ self: map_of(n), args: [n >> 1] }) },
	'Map.prototype.delete': { make: (n) => ({ self: map_of(n), args: [n >> 1] }), fresh: true },
	'Set.prototype.add': { make: (n) => ({ self: new Set(numbers(n)), args: [-1] }), fresh: true },
	'Set.prototype.has': { make: (n) => ({ self: new Set(numbers(n)), args: [-1] }) },
	'Set.prototype.delete': { make: (n) => ({ self: new Set(numbers(n)), args: [-1] }) }
};

/** The original function behind a built-in key (`Array.prototype.sort` -> the sort function). */
export function builtin_function(key: string): ((...args: unknown[]) => unknown) | null {
	const parts = key.split('.');
	let owner: unknown = globalThis;
	for (const p of parts) {
		if (owner == null) return null;
		owner = (owner as Record<string, unknown>)[p];
	}
	return typeof owner === 'function' ? (owner as (...args: unknown[]) => unknown) : null;
}
