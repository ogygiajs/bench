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
	make: (n: number) => BuiltinInput;
	fresh?: boolean;
}

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
	'Array.prototype.join': arr(() => [',']),
	'Array.prototype.concat': arr((n) => [numbers(n)]),
	'Array.prototype.reverse': arr(() => [], true),
	'Array.prototype.fill': arr(() => [0], true),
	'Array.from': { make: (n) => ({ self: Array, args: [numbers(n)] }) },
	'String.prototype.split': str(() => [',']),
	'String.prototype.slice': str(() => [0]),
	'String.prototype.substring': str(() => [0]),
	'String.prototype.replace': str(() => [/a/g, 'z']),
	'String.prototype.replaceAll': str(() => ['a', 'z']),
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
	'String.prototype.match': str(() => [/a/g]),
	'String.prototype.matchAll': str(() => [/a/g]),
	'RegExp.prototype.exec': { make: (n) => ({ self: /#/, args: [text(n)] }) },
	'RegExp.prototype.test': { make: (n) => ({ self: /#/, args: [text(n)] }) },
	'JSON.stringify': { make: (n) => ({ self: JSON, args: [numbers(Math.ceil(n / 6))] }) },
	'JSON.parse': {
		make: (n) => ({ self: JSON, args: [JSON.stringify(numbers(Math.ceil(n / 6)))] })
	},
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
