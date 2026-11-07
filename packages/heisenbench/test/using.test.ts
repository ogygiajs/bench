import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fn_of, load_module, measure, rt } from './helpers.ts';
import type { CaseReport } from '../src/report.ts';

function edge(r: CaseReport, from: string, to: string): number {
	const short = (id: string) => (id === '<root>' ? id : id.slice(id.indexOf(' > ') + 3));
	return r.edges.find((e) => short(e.from) === from && short(e.to) === to)?.count ?? 0;
}

const SOURCE = `export const log: string[] = [];

class Res {
	name: string;
	fail: boolean;
	constructor(name: string, fail = false) {
		this.name = name;
		this.fail = fail;
	}
	async [Symbol.asyncDispose]() {
		await null;
		log.push('dispose ' + this.name);
		if (this.fail) throw new Error('dispose ' + this.name);
	}
}

class Sync {
	[Symbol.dispose]() {
		log.push('dispose sync');
	}
}

export function leaf() {
	return 1;
}

export async function scoped() {
	await using a = new Res('a'), b = new Res('b');
	using s = new Sync();
	await using none = null;
	log.push('body');
	return 'done';
}

export async function other() {
	await null;
	leaf();
	await null;
	leaf();
	await null;
	leaf();
}

export async function both() {
	await Promise.all([scoped(), other()]);
}

export async function throws_both() {
	await using r = new Res('r', true);
	throw new Error('body');
}

export async function loop(names: string[]) {
	for (await using r of names.map((n) => new Res(n))) {
		if (r.name === 'skip') continue;
		log.push('use ' + r.name);
	}
}

export const noop = () => {};
export function empty() {}
export class Empty {
	method() {}
}
`;

type M = {
	log: string[];
	both: () => Promise<void>;
	scoped: () => Promise<string>;
	throws_both: () => Promise<void>;
	loop: (names: string[]) => Promise<void>;
	noop: () => void;
	empty: () => void;
	Empty: new () => { method(): void };
};

test('await using: disposal awaits suspend the frame; interleaved calls keep their callers', async () => {
	const m = await load_module<M>(SOURCE);
	m.log.length = 0;
	const r = await measure(() => m.both());
	assert.deepEqual(m.log, ['body', 'dispose sync', 'dispose b', 'dispose a']);
	// `other` runs its leaf calls while `scoped` waits on its disposals
	assert.equal(edge(r, 'other', 'leaf'), 3);
	assert.equal(edge(r, 'scoped', 'leaf'), 0);
	// the dispose methods are called from inside the scoped frame, the first one synchronously
	assert.ok(
		edge(r, 'scoped', 'Res > [computed]') >= 1,
		r.edges.map((e) => `${e.from} -> ${e.to} ${e.count}`).join('\n')
	);
	assert.equal(rt.depth, 0);
	const scoped = fn_of(r, 'scoped');
	assert.equal(scoped.calls, 1);
	assert.ok(scoped.inclusive_steps < r.totals.steps, 'scoped does not own what other ran');
	// the three disposal awaits of the block are counted as awaits
	assert.ok((scoped.units?.await ?? 0) >= 3);
});

test('await using: return value, error chaining and per-iteration disposal match the language', async () => {
	const m = await load_module<M>(SOURCE);
	m.log.length = 0;
	assert.equal(await m.scoped(), 'done');
	const err = await m.throws_both().then(
		() => null,
		(e: unknown) => e
	);
	assert.ok(err instanceof SuppressedError);
	assert.equal((err as SuppressedError).error.message, 'dispose r');
	assert.equal(((err as SuppressedError).suppressed as Error).message, 'body');
	m.log.length = 0;
	await m.loop(['x', 'skip', 'y']);
	assert.deepEqual(m.log, ['use x', 'dispose x', 'dispose skip', 'use y', 'dispose y']);
	assert.equal(rt.depth, 0);
});

test('functions with an empty body are instrumented into valid code', async () => {
	const m = await load_module<M>(SOURCE);
	const r = await measure(() => {
		m.noop();
		m.empty();
		new m.Empty().method();
	});
	assert.equal(fn_of(r, 'noop').calls, 1);
	assert.equal(fn_of(r, 'empty').calls, 1);
	assert.equal(fn_of(r, 'Empty > method').calls, 1);
});
