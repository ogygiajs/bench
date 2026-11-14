import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load_prices } from '../src/prices.ts';
import { fn_of, load_module, measure } from './helpers.ts';

const { prices } = load_prices();
const { prop_read, prop_write, update, call, arith, assign } = prices.ops;

type Counter = { inc(): void; read(): number };

test('a variable a closure shares costs what a field costs: a read is a property read, a write a property write', async () => {
	const m = await load_module(`export function closure() {
	let n = 0;
	return { inc() { n++; }, read() { return n; } };
}
export class Field {
	#n = 0;
	inc() { this.#n++; }
	read() { return this.#n; }
}`);
	const run = (c: Counter) => {
		for (let i = 0; i < 10; i++) c.inc();
		c.read();
	};
	const a = await measure(() => run((m.closure as () => Counter)()));
	const b = await measure(() => run(new (m.Field as unknown as new () => Counter)()));
	const inc = fn_of(a, 'closure > inc');
	const read = fn_of(a, 'closure > read');
	assert.equal(inc.blocks[0].price, prop_read + prop_write + update);
	assert.equal(read.blocks[0].price, prop_read);
	assert.equal(inc.self_steps, fn_of(b, 'Field > inc').self_steps);
	assert.equal(read.self_steps, fn_of(b, 'Field > read').self_steps);
});

test('a local no closure uses costs nothing to read or write', async () => {
	const m = await load_module(`export function local(k: number) {
	let n = k;
	n++;
	return n;
}`);
	const r = await measure(() => m.local(1 as never));
	assert.equal(fn_of(r, 'local').blocks[0].price, assign + update);
});

test('the declaring function pays for a variable it shares with a closure, on every use', async () => {
	const m = await load_module(`export function owner(k: number) {
	let n = k;
	n += 1;
	const get = () => n;
	return get();
}`);
	const r = await measure(() => m.owner(1 as never));
	const declare = assign;
	const shared_add = prop_read + prop_write + assign + arith;
	const closure = prices.ops.alloc + 9 * prices.ops.alloc_word + assign;
	assert.equal(fn_of(r, 'owner').blocks[0].price, declare + shared_add + closure + call);
	assert.equal(fn_of(r, 'owner > get').blocks[0].price, prop_read);
});

test('a const a closure reads from its function costs a property read: each call makes a new context', async () => {
	const m = await load_module(`export function make(k: number) {
	const n = k + 1;
	return () => n;
}`);
	const r = await measure(() => (m.make(1 as never) as unknown as () => number)());
	assert.equal(fn_of(r, 'make > <anonymous>').blocks[0].price, prop_read);
});

test('a module variable nothing reassigns costs nothing; one that is reassigned costs a slot access', async () => {
	const m = await load_module(`const fixed = 3;
let moving = 0;
export function f() { return fixed; }
export function g() { moving++; return moving; }`);
	const r = await measure(() => {
		m.f();
		m.g();
	});
	assert.equal(fn_of(r, 'f').blocks[0].price, 0);
	assert.equal(fn_of(r, 'g').blocks[0].price, prop_read + prop_write + update + prop_read);
});

test('a getter costs a call, as the method that does the same work does', async () => {
	const m = await load_module(`export class Box {
	#v = 1;
	get v() { return this.#v; }
	value() { return this.#v; }
}
export const literal = { get v() { return 1; }, value() { return 1; } };
export function by_getter(b: Box) { return b.v; }
export function by_method(b: Box) { return b.value(); }`);
	const Box = m.Box as unknown as new () => object;
	const g = await measure(() => m.by_getter(new Box() as never));
	const meth = await measure(() => m.by_method(new Box() as never));
	const getter_total = fn_of(g, 'by_getter').self_steps + fn_of(g, 'Box > get v').self_steps;
	const method_total = fn_of(meth, 'by_method').self_steps + fn_of(meth, 'Box > value').self_steps;
	assert.equal(getter_total, method_total);
	const lit = await measure(() => {
		void (m.literal as unknown as { v: number }).v;
	});
	assert.equal(fn_of(lit, 'literal > get v').blocks[0].price, call);
});
