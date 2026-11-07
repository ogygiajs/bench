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
	const dir = temp_dir('heisenbench-rec-');
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
		out: { a: 1, b: 'x' },
		sizes: [1, 1]
	});
	// each argument's size at entry, and the sizes every call came with
	assert.deepEqual(recs.get('sum_list')!.samples[0].sizes, [4], 'two elements, two numbers');
	assert.deepEqual(add.sizes, { sized: 4, min: 1, max: 2 });
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
	const step = 1;
	m.apply((x: number) => x + step, 1);
	m.outer(2);
	assert.throws(() => m.fails('z'));
	m.sum_list([5]);
	const dir = temp_dir('heisenbench-rec-save-');
	recorder.save(join(dir, 'samples.bin'));
	const records = load_records(join(dir, 'samples.bin'));

	// a fresh copy of the module: what a later replay sees
	const fresh = await load();
	const results = new Map(
		replay(records, fresh.__heisenbench_rec_fns as Record<string, unknown>).map((r) => [
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
	// a function argument that closes over state cannot be cloned (growth keeps a stand-in of it,
	// which never stands for the output)
	assert.equal(results.get('apply')?.status, 'not cloneable');
	assert.equal(records.find((r) => r.id.endsWith('> apply'))?.samples[0].stand_ins, true);
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
	assert.match(r.code, /export const __heisenbench_rec_fns = \{"pkg\/dist\/mod\.js > add":add\}/);
});

test('class constructors are left alone: a derived one may not read `this` before super()', async () => {
	recorder.reset();
	const dir = temp_dir('heisenbench-rec-ctor-');
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

test('a recorded function serializes as written (toString), and a native one still looks native', async () => {
	recorder.reset();
	const m = (await load()) as Record<string, (...a: unknown[]) => unknown>;
	const text = (name: string, end: string) =>
		SOURCE.slice(SOURCE.indexOf(name), SOURCE.indexOf(end, SOURCE.indexOf(name)) + end.length);
	assert.equal(m.add.toString(), text('function add', '\n}'));
	assert.equal(m.nothing.toString(), 'function nothing() {}');
	assert.equal(m.pair.toString(), '(a, b) => ({ a, b })');
	assert.equal(String(m.fails), text('function fails', '\n}'));
	// a serialized recorded function runs where the recorder is not
	const again = new Function(`return (${m.add.toString()})`)() as (a: number, b?: number) => number;
	assert.equal(again(2, 3), 5);
	assert.match(Function.prototype.toString.toString(), /\[native code\]/);
	assert.match(Math.max.toString(), /\[native code\]/);
});

test('inputs with functions: a closed function and a Node module replay; one that closes over state does not', async () => {
	recorder.reset();
	const m = (await load()) as Record<string, (...a: unknown[]) => unknown>;
	const path = process.getBuiltinModule('node:path');
	m.apply((x: number) => x * 2 + Math.max(x, 1), 3);
	m.apply(path.basename, 'a/b.txt');
	m.pair({ join: path.join, posix: path }, (p: string) => `/@id/${p}`);
	const records = recorder.records();
	const apply = records.find((r) => r.id.endsWith('> apply'))!;
	assert.equal(apply.samples.length, 2);
	assert.equal(apply.uncloneable, 0, 'both kept as they were');
	const fresh = await load();
	const results = new Map(
		replay(records, fresh.__heisenbench_rec_fns as Record<string, unknown>).map((r) => [
			r.id.split(' > ').slice(1).join(' > '),
			r
		])
	);
	assert.equal(results.get('apply')?.status, 'reproduced');
	assert.equal(results.get('pair')?.status, 'reproduced');
});

test('samples cover the sizes a function saw: one per half octave, besides the first five', async () => {
	recorder.reset();
	const m = (await load()) as Record<string, (...a: unknown[]) => unknown>;
	for (let n = 1; n <= 4000; n = Math.ceil(n * 1.2))
		m.sum_list(Array.from({ length: n }, (_, i) => i));
	const r = recorder.records().find((x) => x.id.endsWith('> sum_list'))!;
	const sizes = r.samples.map((s) => s.sizes![0]);
	assert.ok(r.samples.length > 15, `${r.samples.length} samples`);
	assert.ok(
		Math.max(...sizes) >= r.sizes!.max / Math.SQRT2,
		'a call of the largest half octave is kept'
	);
	assert.equal(r.sizes!.min, 2);
});

test('reading an input never records itself: a recorded getter read while sizing or cloning', async () => {
	recorder.reset();
	const dir = temp_dir('heisenbench-rec-getter-');
	const source = `
export function named(n) {
	return { get name() { return 'x'.repeat(n); } };
}
export function name_of(o) {
	return o.name;
}
`;
	const r = record_transform(source, { filename: join(dir, 'g.js'), id: 'pkg/g.js' });
	write_files(dir, { 'g.js': r.code });
	const m = (await import(pathToFileURL(join(dir, 'g.js')).href)) as {
		named: (n: number) => { name: string };
		name_of: (o: { name: string }) => string;
	};
	assert.equal(m.name_of(m.named(3)), 'xxx');
	const recs = new Map(recorder.records().map((x) => [x.id.split(' > ').slice(1).join(' > '), x]));
	assert.equal(recs.get('name_of')?.calls, 1);
	const getter = [...recs].find(([path]) => path.startsWith('named > '))?.[1];
	assert.equal(getter?.calls, 1, 'only the call name_of made');
});
