import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { record_transform } from '../src/coverage/record-transform.ts';
import { load_records, recorder, replay } from '../src/coverage/recorder.ts';
import { temp_dir, write_files } from './helpers.ts';

const SOURCE = `
let counter = 0;
export function add(a, b = 1) {
	if (a < 0) return 0;
	return a + b;
}
export function next() {
	counter += 1;
	return counter;
}
export function apply(f, x) {
	return f(x);
}
export const pair = (a, b) => ({ a, b });
export function fails(x) {
	if (x) throw new TypeError('bad ' + x);
	return 'ok';
}
export function sum_list(list) {
	list.push(99);
	let s = 0;
	for (const v of list) s += v;
	return s;
}
export function outer(n) {
	const inner = (k) => k * n;
	return [1, 2].map(inner);
}
export async function later(x) {
	return x;
}
export function nothing() {}
`;

async function load(targets?: string[]): Promise<Record<string, unknown>> {
	const dir = temp_dir('abax-rec-');
	const r = record_transform(SOURCE, {
		filename: join(dir, 'mod.js'),
		id: 'pkg/dist/mod.js',
		targets: targets ? new Set(targets) : undefined
	});
	write_files(dir, { 'mod.js': r.code });
	return (await import(pathToFileURL(join(dir, 'mod.js')).href)) as Record<string, unknown>;
}

test('recording keeps inputs as they came in and outputs as they left', async () => {
	recorder.reset();
	const m = (await load()) as Record<string, (...a: unknown[]) => unknown>;
	assert.equal(m.add(2, 3), 5);
	assert.equal(m.add(2), 3);
	assert.equal(m.add(-1, 3), 0);
	assert.equal(m.add(2, 3), 5); // the same inputs again: one sample
	assert.deepEqual(m.pair(1, 'x'), { a: 1, b: 'x' });
	const list = [1, 2];
	assert.equal(m.sum_list(list), 102);
	assert.throws(() => m.fails('y'), /bad y/);
	assert.equal(m.fails(''), 'ok');
	assert.deepEqual(m.outer(3), [3, 6]);
	assert.equal(m.nothing(), undefined);
	const recs = new Map(recorder.records().map((r) => [r.id.split(' > ').slice(1).join(' > '), r]));
	const add = recs.get('add')!;
	assert.equal(add.calls, 4);
	assert.deepEqual(
		add.samples.map((s) => [s.args, s.out]),
		[
			[[2, 3], 5],
			[[2], 3],
			[[-1, 3], 0]
		]
	);
	// the argument as it was passed, not as the function left it
	assert.deepEqual(recs.get('sum_list')!.samples[0].args, [[1, 2]]);
	assert.deepEqual(recs.get('pair')!.samples[0], {
		args: [1, 'x'],
		this_value: undefined,
		out: { a: 1, b: 'x' }
	});
	assert.deepEqual(recs.get('fails')!.samples[0].threw, { name: 'TypeError', message: 'bad y' });
	// nested closures are recorded too
	assert.equal(recs.get('outer > inner')!.calls, 2);
	assert.equal(recs.get('nothing')!.samples[0].out, undefined);
	// async functions are not recorded (their output is a promise)
	assert.equal(recs.has('later'), false);
});

test('replay: reproduced, hidden state, not cloneable, not replayable', async () => {
	recorder.reset();
	const m = (await load()) as Record<string, (...a: unknown[]) => unknown>;
	m.add(4, 5);
	m.next();
	m.next();
	m.apply((x: number) => x + 1, 1);
	m.outer(2);
	assert.throws(() => m.fails('z'));
	m.sum_list([5]);
	const dir = temp_dir('abax-rec-save-');
	recorder.save(join(dir, 'samples.bin'));
	const records = load_records(join(dir, 'samples.bin'));

	// a fresh copy of the module: what a later replay sees
	const fresh = await load();
	const results = new Map(
		replay(records, fresh.__abax_rec_fns as Record<string, unknown>).map((r) => [
			r.id.split(' > ').slice(1).join(' > '),
			r
		])
	);
	assert.equal(results.get('add')?.status, 'reproduced');
	assert.equal(results.get('fails')?.status, 'reproduced');
	assert.equal(results.get('sum_list')?.status, 'reproduced');
	// next() reads module state its inputs do not carry
	assert.equal(results.get('next')?.status, 'hidden state');
	assert.equal(results.get('next')?.mismatches, 1);
	// a function argument cannot be cloned
	assert.equal(results.get('apply')?.status, 'not cloneable');
	// a nested closure has no handle for a replay
	assert.equal(results.get('outer > inner')?.status, 'not replayable');
	// a replay records nothing
	assert.equal(recorder.records().find((r) => r.id.endsWith('> add'))?.calls, 1);
});

test('targets: only the named functions are wrapped; the rest say why', () => {
	const r = record_transform(SOURCE, {
		filename: '/x/mod.js',
		id: 'pkg/dist/mod.js',
		targets: new Set(['add', 'later', 'missing'])
	});
	assert.deepEqual(r.wrapped, ['pkg/dist/mod.js > add']);
	assert.deepEqual(r.skipped, [
		{ id: 'pkg/dist/mod.js > later', reason: 'async' },
		{ id: 'pkg/dist/mod.js > missing', reason: 'not found' }
	]);
	assert.match(r.code, /export const __abax_rec_fns = \{"pkg\/dist\/mod\.js > add":add\}/);
});

test('class constructors are left alone: a derived one may not read `this` before super()', async () => {
	recorder.reset();
	const dir = temp_dir('abax-rec-ctor-');
	const source = `
class Base { constructor(x) { this.x = x; } twice() { return this.x * 2; } }
export class Derived extends Base {
	constructor(x) { super(x + 1); this.y = x; }
	sum() { return this.x + this.y; }
}
export function make(x) { return new Derived(x).sum(); }
`;
	const r = record_transform(source, { filename: join(dir, 'ctor.js'), id: 'pkg/ctor.js' });
	assert.deepEqual(
		r.skipped.map((s) => s.reason),
		['constructor', 'constructor']
	);
	write_files(dir, { 'ctor.js': r.code });
	const m = (await import(pathToFileURL(join(dir, 'ctor.js')).href)) as {
		make: (x: number) => number;
	};
	assert.equal(m.make(2), 5);
	const recs = new Map(recorder.records().map((x) => [x.id, x]));
	assert.equal(recs.get('pkg/ctor.js > make')?.samples[0].out, 5);
	assert.equal(recs.get('pkg/ctor.js > Derived > sum')?.calls, 1);
});
