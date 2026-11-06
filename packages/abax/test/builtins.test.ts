import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fn_of, load_module, measure } from './helpers.ts';
import { builtin_cost, load_prices } from '../src/prices.ts';

const { prices } = load_prices();
const cost = (key: string, n: number) => builtin_cost(prices.builtins[key], n);

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
	assert.equal(by.get('join')!.steps, cost('Array.prototype.join', 8 + joined.length));
	assert.ok(fn_of(r, 'sorter > sort:0').calls > 0, 'the comparator is counted as code');
	const line3 = f.lines.find((l) => l.line === 3)!;
	assert.ok(line3.steps >= cost('Array.prototype.sort', 8));
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
	const unsited = g.builtins.find((b) => b.name === 'map');
	assert.equal(unsited?.line, 0, 'a call shape with no site is charged to the function');
	assert.equal(unsited?.steps, cost('Array.prototype.map', 3));
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
