import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fn_of, load_module, measure } from './helpers.ts';
import type { CaseReport } from '../src/report.ts';
import { array_bytes, closure_bytes, object_bytes, string_bytes } from '../src/layout.ts';

function edge(r: CaseReport, from: string, to: string): number {
	const short = (id: string) => (id === '<root>' ? id : id.slice(id.indexOf(' > ') + 3));
	return r.edges.find((e) => short(e.from) === from && short(e.to) === to)?.count ?? 0;
}

function sum_self(r: CaseReport): number {
	return r.functions.reduce((s, f) => s + f.self_steps, 0);
}

test('shadow call stack: edges, self and inclusive steps', async () => {
	const m = await load_module(`export function leaf(n: number) {
	let s = 0;
	for (let i = 0; i < n; i++) s += i;
	return s;
}
export function mid(n: number) { return leaf(n) + leaf(1); }
export function top(n: number) { return mid(n) * 2; }
`);
	const r = await measure(() => m.top(3 as never));
	assert.equal(edge(r, '<root>', 'top'), 1);
	assert.equal(edge(r, 'top', 'mid'), 1);
	assert.equal(edge(r, 'mid', 'leaf'), 2);
	assert.equal(r.edges.length, 3);
	const top = fn_of(r, 'top');
	const mid = fn_of(r, 'mid');
	const leaf = fn_of(r, 'leaf');
	assert.equal(top.inclusive_steps, r.totals.steps);
	assert.equal(mid.inclusive_steps, mid.self_steps + leaf.self_steps);
	assert.equal(leaf.inclusive_steps, leaf.self_steps);
	assert.equal(sum_self(r), r.totals.steps);
});

test('recursion is counted once in inclusive steps', async () => {
	const m = await load_module(
		`export function fib(n: number): number { return n < 2 ? n : fib(n - 1) + fib(n - 2); }`
	);
	const r = await measure(() => m.fib(10 as never));
	const f = fn_of(r, 'fib');
	assert.equal(f.calls, 177);
	assert.equal(edge(r, 'fib', 'fib'), 176);
	assert.equal(f.inclusive_steps, f.self_steps);
});

test('the stack is saved and restored across await, also when calls interleave', async () => {
	const m = await load_module(`export async function child(n: number) {
	await null;
	let s = 0;
	for (let i = 0; i < n; i++) s += helper(i);
	await null;
	return s;
}
function helper(i: number) { return i; }
export async function parent() {
	const a = await child(3);
	const b = await child(2);
	return a + b;
}
export async function sibling() { return helper(1); }
`);
	const r = await measure(() => Promise.all([m.parent(), m.parent(), m.sibling()]));
	assert.equal(edge(r, '<root>', 'parent'), 2);
	assert.equal(edge(r, '<root>', 'sibling'), 1);
	assert.equal(edge(r, 'parent', 'child'), 4);
	assert.equal(edge(r, 'child', 'helper'), 10);
	assert.equal(edge(r, 'sibling', 'helper'), 1);
	assert.equal(r.edges.length, 5, JSON.stringify(r.edges));
	const parent = fn_of(r, 'parent');
	const child = fn_of(r, 'child');
	const helper = fn_of(r, 'helper');
	const sibling = fn_of(r, 'sibling');
	assert.equal(child.inclusive_steps, child.self_steps + (helper.self_steps * 10) / 11);
	assert.equal(parent.inclusive_steps, parent.self_steps + child.inclusive_steps);
	assert.equal(sibling.inclusive_steps, sibling.self_steps + helper.self_steps / 11);
	assert.equal(sum_self(r), r.totals.steps);
});

test('generators keep their own frame across yields', async () => {
	const m = await load_module(`function helper(i: number) { return i * 2; }
export function* gen(n: number) { for (let i = 0; i < n; i++) yield helper(i); }
export function consume() {
	let s = 0;
	for (const v of gen(3)) s += v;
	return s;
}
`);
	let out = 0;
	const r = await measure(() => {
		out = m.consume() as number;
	});
	assert.equal(out, 6);
	assert.equal(edge(r, 'consume', 'gen'), 1);
	assert.equal(edge(r, 'gen', 'helper'), 3);
	const gen = fn_of(r, 'gen');
	const helper = fn_of(r, 'helper');
	assert.equal(gen.inclusive_steps, gen.self_steps + helper.self_steps);
	assert.equal(fn_of(r, 'consume').inclusive_steps, r.totals.steps);
});

test('allocation sites: exact counts and V8-layout byte estimates', async () => {
	const m = await load_module(`export function allocs(xs: number[]) {
	const o = { a: 1, b: 2 };
	const e = {};
	const arr = [1, 2, 3];
	const empty: number[] = [];
	const f = () => o.a;
	const s = \`n=\${xs.length}\`;
	const sp = { ...o, c: 3 };
	const cp = [...xs];
	return [o, e, arr, empty, f, s, sp, cp];
}
`);
	const r = await measure(() => {
		m.allocs([1, 2, 3, 4] as never);
		m.allocs([1, 2, 3, 4] as never);
	});
	const f = fn_of(r, 'allocs');
	const by_line = new Map(f.sites.map((s) => [s.line, s]));
	const expect: Array<[number, string, number]> = [
		[2, 'object', object_bytes(2)],
		[3, 'object', object_bytes(0)],
		[4, 'array', array_bytes(3)],
		[5, 'array', array_bytes(0)],
		[6, 'closure', closure_bytes(1)],
		[7, 'string', string_bytes(3)],
		[8, 'spread_object', object_bytes(1) + 4 * 2],
		[9, 'spread_array', array_bytes(0) + 4 * 4],
		[10, 'array', array_bytes(8)]
	];
	for (const [line, kind, bytes] of expect) {
		const s = by_line.get(line);
		assert.ok(s, `site on line ${line}`);
		assert.equal(s.kind, kind, `kind on line ${line}`);
		assert.equal(s.count, 2, `count on line ${line}`);
		assert.equal(s.bytes, 2 * bytes, `bytes on line ${line}`);
	}
	assert.equal(f.allocations, 18);
	assert.equal(f.bytes, 2 * expect.reduce((s, [, , b]) => s + b, 0));
});

test('new, rest parameters and arguments are sized', async () => {
	const m = await load_module(`class P {
	x = 1;
	y = 2;
	constructor() { (this as any).z = 3; }
}
export function make() { return new P(); }
export function rest(...xs: number[]) { return xs.length; }
export function args() { return arguments.length; }
export function no_args(a: number) { return a; }
`);
	const r = await measure(() => {
		m.make();
		m.rest(1 as never, 2 as never, 3 as never);
		(m.args as (...a: number[]) => number)(1, 2, 3);
		m.no_args(1 as never);
	});
	assert.equal(fn_of(r, 'make').sites.find((s) => s.kind === 'new')?.bytes, object_bytes(3));
	assert.equal(fn_of(r, 'rest').sites.find((s) => s.kind === 'rest')?.bytes, array_bytes(3));
	assert.equal(
		fn_of(r, 'args').sites.find((s) => s.kind === 'arguments')?.bytes,
		object_bytes(1) + 8 + 4 * 3
	);
	assert.equal(fn_of(r, 'no_args').allocations, 0);
});
