import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fn_of, load_module, loader_root, measure, write_files } from './helpers.ts';
import { SIZE_TERMS, builtin_cost, load_prices } from '../src/prices.ts';
import type { SizeTerm } from '../src/prices.ts';

const { prices } = load_prices();
const cost = (key: string, n: number, terms: Partial<Record<SizeTerm, number>> = {}) =>
	builtin_cost(
		prices.builtins[key],
		n,
		SIZE_TERMS.map((t) => terms[t] ?? 0)
	);

test('built-ins are priced by size and charged to their call line', async () => {
	const m = await load_module(`export function sorter(xs: number[]) {
	const c = xs.slice();
	c.sort((a, b) => a - b);
	return c.join(',');
}
`);
	const xs = [5, 3, 8, 1, 9, 2, 7, 4];
	let joined = '';
	const r = await measure(() => {
		joined = m.sorter(xs as never) as string;
	}, true);
	const f = fn_of(r, 'sorter');
	const by = new Map(f.builtins.map((b) => [b.name, b]));
	assert.deepEqual(
		f.builtins.map((b) => [b.name, b.line, b.calls]),
		[
			['slice', 2, 1],
			['sort', 3, 1],
			['join', 4, 1]
		]
	);
	assert.equal(by.get('slice')!.steps, cost('Array.prototype.slice', 8));
	assert.equal(by.get('sort')!.steps, cost('Array.prototype.sort', 8));
	assert.equal(
		by.get('join')!.steps,
		cost('Array.prototype.join', 8 + joined.length, { items: 8 })
	);
	assert.ok(fn_of(r, 'sorter > sort:0').calls > 0, 'the comparator is counted as code');
	const line3 = f.lines.find((l) => l.line === 3)!;
	assert.ok(line3.steps >= cost('Array.prototype.sort', 8));
});

test('size terms: what a built-in cuts, matches, calls back, builds and converts is kept per call', async () => {
	const m = await load_module(`export function terms(s: string, xs: number[]) {
	const parts = s.split(',');
	const all = s.replace(/,/g, ';');
	const one = s.replace(',', ';');
	const called = s.replaceAll(',', (c) => c + c);
	const found = s.match(/,/g);
	const joined = xs.join('-');
	const tree = JSON.parse('{"a":[1,2,{"b":"c"}]}');
	const text = JSON.stringify({ a: [1, 2] });
	const mapped = Array.from(xs, (x) => x * 2);
	const copied = Array.from(xs);
	return [parts, all, one, called, found, joined, tree, text, mapped, copied];
}
`);
	const r = await measure(() => m.terms('a,b,c,d' as never, [1, 2, 3] as never), true);
	const u = fn_of(r, 'terms').units!;
	const term = (key: string, t: string) => u[`bi.${key}.${t}`] ?? 0;
	assert.equal(term('String.prototype.split', 'parts'), 4);
	assert.equal(
		term('String.prototype.replace', 'matches'),
		3 + 1,
		'a global regex: 3; a string: once'
	);
	assert.equal(term('String.prototype.replace', 'callbacks'), 0);
	assert.equal(term('String.prototype.replaceAll', 'matches'), 3);
	assert.equal(term('String.prototype.replaceAll', 'callbacks'), 3);
	assert.equal(term('String.prototype.match', 'matches'), 3);
	assert.equal(term('Array.prototype.join', 'items'), 3);
	// the object, the array, two numbers, the inner object and its string
	assert.equal(term('JSON.parse', 'values'), 6);
	assert.equal(term('JSON.stringify', 'values'), 4);
	assert.equal(term('Array.from', 'callbacks'), 3, 'the mapFn, not the copy');
});

test('calls from uninstrumented code are free; nested built-ins are charged once', async () => {
	const m = await load_module(`export function rep(s: string) {
	return s.replace(/a/g, 'b');
}
export function indirect(xs: number[]) {
	const map = Array.prototype.map;
	return map.call(xs, (x: number) => x + 1);
}
`);
	const free = await measure(() => {
		[3, 1, 2].sort();
		JSON.stringify({ a: 1 });
	}, true);
	assert.equal(free.totals.steps, 0);

	const r = await measure(() => m.rep('banana' as never), true);
	const f = fn_of(r, 'rep');
	assert.deepEqual(
		f.builtins.map((b) => b.name),
		['replace'],
		'RegExp exec inside replace is not charged again'
	);

	const r2 = await measure(() => m.indirect([1, 2, 3] as never), true);
	const g = fn_of(r2, 'indirect');
	const via_call = g.builtins.find((b) => b.name === 'map');
	assert.equal(via_call?.line, 6, '`map.call(...)` is a site of map');
	assert.equal(via_call?.steps, cost('Array.prototype.map', 3));
});

test('built-ins that uncounted code calls are never charged, whatever counted code called it', async () => {
	const dir = loader_root();
	// `.bench.` files are not instrumented: this one stands for a dependency.
	write_files(dir, {
		'uncounted.bench.ts': `export class Box {
	m = new Map([['a', 1]]);
	s = 'abcdef';
	get(k: string) { return this.m.get(k); }
	slice(n: number) { return this.s.slice(n); }
}
export function work(xs: number[]) { return xs.slice(1).join('-'); }
`
	});
	const m = await load_module(`import { Box, work } from './uncounted.bench.ts';
export function calls(xs: number[]) {
	const box = new Box();
	const a = box.get('a');
	const b = box.slice(2);
	const c = work(xs);
	const u = new URL('https://example.test/p?og=a:b&x=1');
	return [a, b, c, u.searchParams.getAll('og').length];
}
export function chained(o: { box?: Box; s?: string }) {
	return [o?.box.get('a'), o?.box.slice(1), o.s?.slice(1)];
}
export async function waits(s: string, n: Promise<number>) {
	return s.slice(await n);
}
class Cache extends Map<string, number> {
	get(k: string) { return super.get(k); }
}
export function inherits() {
	const c = new Cache([['k', 1]]);
	return c.get('k');
}
export function build(depth: number, m: Map<number, unknown>): Map<number, unknown> {
	if (depth > 0) m.set(depth, build(depth - 1, new Map()));
	return m;
}
`);
	const r = await measure(() => m.calls([1, 2, 3] as never), true);
	assert.deepEqual(fn_of(r, 'calls').builtins, [], 'Box methods, work() and URL parsing are free');

	const { Box } = (await import(pathToFileURL(join(dir, 'uncounted.bench.ts')).href)) as {
		Box: new () => unknown;
	};
	const r3 = await measure(() => m.chained({ box: new Box(), s: 'abc' } as never), true);
	assert.deepEqual(
		fn_of(r3, 'chained').builtins.map((b) => [b.name, b.calls]),
		[['slice', 1]],
		'in an optional chain only the real String slice on `o.s` is charged'
	);

	const r4 = await measure(() => m.waits('abcdef' as never, Promise.resolve(2) as never), true);
	assert.deepEqual(
		fn_of(r4, 'waits').builtins.map((b) => [b.name, b.line, b.calls]),
		[['slice', 14, 1]],
		'a site with an await in its arguments is still charged'
	);

	const r5 = await measure(() => m.inherits(), true);
	assert.deepEqual(
		fn_of(r5, 'Cache > get').builtins.map((b) => [b.name, b.calls]),
		[['get', 1]],
		'`super.get` is charged to the counted method that made it'
	);

	const r6 = await measure(() => m.build(5 as never, new Map() as never), true);
	assert.deepEqual(
		fn_of(r6, 'build').builtins.map((b) => [b.name, b.calls]),
		[['set', 5]],
		'a site reached again inside its own arguments charges every call'
	);
});

test('Map and Set operations cost a constant; the runtime never charges itself', async () => {
	const m = await load_module(`export async function cache(keys: string[]) {
	const m = new Map<string, number>();
	for (const k of keys) {
		if (!m.has(k)) m.set(k, k.length);
		await null;
	}
	return m.get(keys[0]);
}
`);
	const r = await measure(() => m.cache(['a', 'b', 'a'] as never), true);
	const f = fn_of(r, 'cache');
	const calls = Object.fromEntries(f.builtins.map((b) => [b.name, b.calls]));
	assert.deepEqual(calls, { has: 3, set: 2, get: 1 });
	assert.equal(r.totals.steps, f.self_steps);
});

test('a search is priced by what it walks: an indexOf scanner stays linear', async () => {
	const m = await load_module(`export function tags(html: string): number {
	let n = 0;
	for (let at = html.indexOf('<'); at !== -1; at = html.indexOf('<', at + 1)) n++;
	return n;
}
export function has(html: string): boolean {
	return html.includes('</body>', 4);
}
`);
	const { base, k } = prices.builtins['String.prototype.indexOf'];
	for (const n of [100, 1000]) {
		const r = await measure(() => m.tags('<a>xx'.repeat(n) as never), true);
		const charged = fn_of(r, 'tags').builtins.reduce((s, b) => s + b.steps, 0);
		// n + 1 searches that together walk the string once (5n characters), not n times
		assert.equal(charged, (n + 1) * base + k * 5 * n);
	}

	const t = await load_module(`const TOKEN = /<\\/?b>/g;
export function tokens(html: string): number {
	let n = 0;
	TOKEN.lastIndex = 0;
	while (TOKEN.exec(html)) n++;
	return n;
}
`);
	const re = prices.builtins['RegExp.prototype.exec'];
	for (const n of [100, 1000]) {
		const r = await measure(() => t.tokens('<b>xx</b>'.repeat(n) as never), true);
		const charged = fn_of(r, 'tokens').builtins.reduce((s, b) => s + b.steps, 0);
		// 2n matches and a final miss, together walking the input once (9n characters)
		assert.equal(
			charged,
			builtin_cost(re, 0) * (2 * n + 1) + (builtin_cost(re, 9 * n) - builtin_cost(re, 0))
		);
	}

	const r = await measure(() => m.has('<html><body></body></html>' as never), true);
	const includes = fn_of(r, 'has').builtins[0];
	assert.equal(includes.steps, cost('String.prototype.includes', 12 - 4 + 7));
});
