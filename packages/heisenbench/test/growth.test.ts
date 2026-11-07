import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fit_growth, fit_noisy } from '../src/growth/fit.ts';
import { clone, input_size, scale_input } from '../src/growth/scale.ts';
import { Rng, mutate } from '../src/search/mutate.ts';

const KS = [1, 10, 100];

test('curve classes are fitted from exact counts', () => {
	const cls = (f: (k: number) => number, ks = KS) => fit_growth(ks, ks.map(f)).class;
	assert.equal(
		cls(() => 500),
		'constant'
	);
	assert.equal(
		cls((k) => 40 + 9 * Math.log(k)),
		'log'
	);
	assert.equal(
		cls((k) => 1000 + 5 * k),
		'linear',
		'a large constant part does not hide a line'
	);
	assert.equal(
		cls((k) => 7 * k * Math.log(k) + 3 * k + 20),
		'n log n'
	);
	assert.equal(
		cls((k) => 2 * k * k + 30 * k + 4),
		'quadratic'
	);
	assert.equal(
		cls((k) => k * k * k + k),
		'cubic'
	);
	assert.equal(
		cls((k) => k ** 4 + 10 * k),
		'quartic'
	);
	const six = fit_growth(
		KS,
		KS.map((k) => k ** 6 + 10)
	);
	assert.equal(six.class, 'polynomial');
	assert.equal(six.power, 6, 'a power past quartic is named by its fitted power');
	const ladder = [1, 2, 4, 8];
	assert.equal(
		cls((k) => 20 * 2 ** (3 * k), ladder),
		'exponential',
		'local slopes that keep doubling: exponential'
	);
	assert.equal(
		cls((k) => 1000 + k ** 8, ladder),
		'polynomial',
		'a high power with a constant part settles: not exponential'
	);
	assert.equal(fit_growth(KS, [4270184, 42654, 4231]).class, 'shrinks');
	assert.equal(
		fit_growth(KS, [4270184, 42654, 423051]).class,
		'irregular',
		'down then up: the scaled input may be invalid, never "worse"'
	);
	assert.equal(
		cls((k) => 3 * (5 + 2 * k)),
		'linear',
		'three times the work is still linear'
	);
	const sizes = [1, 2, 4, 8, 16, 32];
	assert.equal(
		cls((k) => 10 + k * k, sizes),
		'quadratic'
	);
	assert.ok(Math.abs(fit_growth(KS, [3, 300, 30000]).exponent - 2) < 1e-9);
});

test('noisy points: superlinear only when the power, the fit and the work per unit all say so', () => {
	// steps of different inputs: a line with a constant part, a quadratic with noise, and a line
	// made to look steep by one trivial call at the smallest size
	const xs = [40, 60, 90, 130, 200, 300, 450, 700, 1000, 1500];
	const noise = [1.1, 0.9, 1.2, 0.85, 1.05, 0.95, 1.15, 0.9, 1.1, 1];
	const line = fit_noisy(
		xs,
		xs.map((x, i) => (500 + 20 * x) * noise[i])
	);
	assert.equal(line.superlinear, false);
	assert.ok(line.class === 'linear' || line.class === 'log', line.class);
	const quad = fit_noisy(
		xs,
		xs.map((x, i) => (200 + x * x) * noise[i])
	);
	assert.equal(quad.superlinear, true);
	assert.equal(quad.class, 'quadratic');
	assert.ok(quad.power > 1.7 && quad.power < 2.2, String(quad.power));
	const one_trivial = fit_noisy(
		[10, ...xs.slice(4)],
		[5, ...xs.slice(4).map((x) => 3000 + 20 * x)]
	);
	assert.equal(one_trivial.superlinear, false, 'no single call decides');
});

test('the generic scaler grows every collection once, linearly', () => {
	const ctx = {
		rows: [
			{ id: 1, tags: ['a', 'b'] },
			{ id: 2, tags: ['c'] }
		],
		query: 'ab',
		n: 7,
		index: new Map([
			['x', 1],
			['y', 2]
		]),
		ids: new Set([1, 2, 3]),
		path: { name: 'a', next: { name: 'b', next: null } }
	};
	const s = scale_input(ctx, 3);
	assert.equal(s.rows.length, 6);
	assert.deepEqual(s.rows[2], { id: 1, tags: ['a', 'b'] }, 'inner arrays are copied, not grown');
	assert.notEqual(s.rows[2], s.rows[0], 'repeated elements are distinct objects');
	assert.equal(s.query, 'ababab');
	assert.equal(s.n, 7);
	assert.deepEqual([...s.index.keys()], ['x', 'y', 'x~1', 'y~1', 'x~2', 'y~2']);
	assert.deepEqual([...s.ids], [1, 2, 3, 5, 6, 7, 9, 10, 11]);
	let depth = 0;
	for (let p: { next: unknown } | null = s.path; p; p = p.next as { next: unknown } | null) depth++;
	assert.equal(depth, 6, 'a chain gets three times deeper');
	assert.deepEqual(ctx.rows.length, 2, 'the input itself is untouched');
	assert.equal(scale_input(ctx, 1).rows.length, 2);
	assert.ok(input_size(scale_input(ctx, 10)) > 8 * input_size(ctx));
});

test('the generic scaler leaves a cycle a cycle: a link back to an ancestor is never followed', () => {
	const posts = [{ id: 1 }, { id: 2 }];
	const o: Record<string, unknown> = { name: 'a', posts };
	o.self = o;
	const parent: Record<string, unknown> = { kids: [] as unknown[] };
	(parent.kids as unknown[]).push({ up: parent, v: 1 });
	const s = scale_input({ o, parent }, 4);
	const so = s.o as { name: string; posts: Array<{ id: number }>; self: unknown };
	assert.equal(so.self, so, 'the self link points at the copy');
	assert.equal(so.posts.length, 8);
	assert.equal(so.name, 'aaaa');
	const kids = (s.parent as { kids: Array<{ up: unknown; v: number }> }).kids;
	assert.equal(kids.length, 4);
	for (const k of kids) assert.equal(k.up, s.parent, 'a parent link points at the scaled parent');
	assert.notEqual(kids[0], kids[1], 'repeats still share nothing but the ancestors');
	assert.equal(o.self, o, 'the input itself is untouched');
});

test('clone keeps shared and cyclic structure', () => {
	const shared = { v: 1 };
	const a: Record<string, unknown> = { x: shared, y: shared };
	a.self = a;
	const b = clone(a);
	assert.notEqual(b, a);
	assert.equal(b.x, b.y);
	assert.equal(b.self, b);
});

test('mutations are seeded: the same seed makes the same inputs', () => {
	const input = { text: 'hello world', xs: [3, 1, 2], n: 5 };
	const walk = (seed: number): string[] => {
		const r = new Rng(seed);
		let cur: unknown = input;
		const out: string[] = [];
		for (let i = 0; i < 50; i++) {
			const m = mutate(cur, r);
			cur = m.input;
			out.push(m.what + ' ' + JSON.stringify(cur));
		}
		return out;
	};
	assert.deepEqual(walk(7), walk(7));
	assert.notDeepEqual(walk(7), walk(8));
	assert.deepEqual(
		input,
		{ text: 'hello world', xs: [3, 1, 2], n: 5 },
		'the input is never changed'
	);
});

test('number mutations never grow a number', () => {
	const r = new Rng(3);
	for (let i = 0; i < 200; i++) {
		const v = (mutate({ n: 50 }, r).input as { n: unknown }).n;
		if (typeof v === 'number' && !Number.isNaN(v)) assert.ok(Math.abs(v) <= 50, String(v));
	}
});
