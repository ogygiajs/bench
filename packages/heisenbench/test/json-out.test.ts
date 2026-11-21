import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { write_json } from '../src/json-out.ts';
import { temp_dir } from './helpers.ts';

/** A seeded generator (mulberry32): the same values on every run. */
function random(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const STRINGS = [
	'',
	'a',
	'line\nbreak',
	'tab\there',
	'quote " and \\',
	'naïve café ☕',
	'  ',
	'\ud800',
	'{"a":1}'
];
const NUMBERS = [0, -0, 1, -1.5, 1e21, 1e-7, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity];

/** Values JSON.stringify treats in every way it has: skipped, nulled, toJSON, holes, deep and empty. */
function value(next: () => number, depth: number): unknown {
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
	const r = next();
	if (depth > 5 || r < 0.3) {
		return pick<unknown>([
			pick(STRINGS),
			pick(NUMBERS),
			true,
			false,
			null,
			undefined,
			() => 1,
			Symbol('s'),
			new Date(Math.floor(next() * 1e12)),
			{ toJSON: (key: string) => `key:${key}` },
			{ toJSON: () => ({ nested: [1, undefined] }) },
			new Number(3),
			new String('boxed'),
			new Map([[1, 2]])
		]);
	}
	if (r < 0.6) {
		const a: unknown[] = [];
		const n = Math.floor(next() * 5);
		for (let i = 0; i < n; i++) a.push(value(next, depth + 1));
		if (next() < 0.1) a.length += 2;
		return a;
	}
	const o: Record<string, unknown> = next() < 0.1 ? Object.create(null) : {};
	const n = Math.floor(next() * 5);
	for (let i = 0; i < n; i++)
		o[pick(['a', 'b', '1', '0', '', 'é', 'x y', `k${i}`])] = value(next, depth + 1);
	return o;
}

test('write_json writes the bytes JSON.stringify(value, null, tab) does, for every kind of value', () => {
	const dir = temp_dir('heisenbench-json-');
	const file = join(dir, 'out.json');
	const next = random(7);
	for (let i = 0; i < 2000; i++) {
		const v = value(next, 0);
		write_json(file, v);
		assert.equal(readFileSync(file, 'utf8'), JSON.stringify(v, null, '\t') + '\n', `value ${i}`);
	}
});

test('write_json writes a report-shaped value the same, in pieces bigger than one write', () => {
	const dir = temp_dir('heisenbench-json-');
	const file = join(dir, 'report.json');
	const cases = Array.from({ length: 3000 }, (_, i) => ({
		name: `case ${i}`,
		totals: { steps: i * 7, allocations: i },
		functions: Array.from({ length: 20 }, (_, j) => ({
			path: `f${j}`,
			line: j,
			lines: { [j]: i + j }
		})),
		error: null,
		skipped: undefined
	}));
	const report = {
		schema: 'heisenbench-report',
		git: { sha: null, prefix: '' },
		cases,
		load_errors: undefined
	};
	write_json(file, report);
	const text = readFileSync(file, 'utf8');
	assert.ok(text.length > 4 << 20, 'more than one chunk');
	assert.equal(text, JSON.stringify(report, null, '\t') + '\n');
});

test('write_json that fails leaves the file it was writing as it was, and no temporary file', () => {
	const dir = temp_dir('heisenbench-json-');
	const file = join(dir, 'r.json');
	writeFileSync(file, '{"old":true}\n');
	const cyclic: Record<string, unknown> = { a: { b: { c: {} } } };
	(cyclic.a as { b: { c: Record<string, unknown> } }).b.c.back = cyclic;
	assert.throws(() => write_json(file, cyclic), TypeError);
	assert.throws(() => write_json(file, { cases: [{ big: 1n }] }), TypeError);
	assert.equal(readFileSync(file, 'utf8'), '{"old":true}\n');
	assert.deepEqual(readdirSync(dir), ['r.json']);
});

test('write_json writes through a symlink, and into a file that is not a regular one', () => {
	const dir = temp_dir('heisenbench-json-');
	writeFileSync(join(dir, 'real.json'), '');
	symlinkSync(join(dir, 'real.json'), join(dir, 'link.json'));
	write_json(join(dir, 'link.json'), { a: [1] });
	assert.equal(readFileSync(join(dir, 'real.json'), 'utf8'), '{\n\t"a": [\n\t\t1\n\t]\n}\n');
	write_json('/dev/null', { a: 1 });
});
