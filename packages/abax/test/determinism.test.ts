import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AbaxIoError, Determinism } from '../src/runtime/determinism.ts';
import { run_case } from '../src/runner.ts';
import { load_module, builtins, temp_dir } from './helpers.ts';

test('clock and randomness are identical in every window', () => {
	const det = new Determinism();
	const sample = () => {
		det.open('replay');
		try {
			return [
				Date.now(),
				Date.now(),
				performance.now(),
				new Date().toISOString(),
				Math.random(),
				Math.random(),
				crypto.randomUUID(),
				randomUUID(),
				randomBytes(4).toString('hex'),
				Array.from(crypto.getRandomValues(new Uint8Array(4))),
				process.hrtime.bigint()
			];
		} finally {
			det.close();
		}
	};
	const a = sample();
	const b = sample();
	assert.deepEqual(a, b);
	assert.equal(a[1], (a[0] as number) + 1, 'each clock read advances one step');
	assert.notEqual(a[4], a[5]);
	assert.ok(Date.now() > 1_750_000_000_000, 'the real clock is back after close');
});

test('fake timers run in due order and move the clock', async () => {
	const det = new Determinism();
	det.open('replay');
	const seen: Array<[string, number]> = [];
	try {
		setTimeout(() => seen.push(['30', Date.now()]), 30);
		setTimeout(() => seen.push(['10', Date.now()]), 10);
		const t = setTimeout(() => seen.push(['never', 0]), 15);
		clearTimeout(t);
		setTimeout(() => {
			seen.push(['20', Date.now()]);
			setTimeout(() => seen.push(['20+5', Date.now()]), 5);
		}, 20);
		setImmediate(() => seen.push(['now', Date.now()]));
		const r = await det.settle();
		assert.equal(r.runaway, false);
	} finally {
		det.close();
	}
	assert.deepEqual(
		seen.map((s) => s[0]),
		['now', '10', '20', '20+5', '30']
	);
	const epoch = det.epoch;
	assert.ok(seen[1][1] >= epoch + 10 && seen[2][1] >= epoch + 20);
});

test('a runaway interval ends the run instead of hanging it', async () => {
	const det = new Determinism({ max_timer_runs: 50 });
	det.open('replay');
	let n = 0;
	try {
		setInterval(() => n++, 1);
		const r = await det.settle();
		assert.equal(r.runaway, true);
	} finally {
		det.close();
	}
	assert.equal(n, 50);
});

test('fs reads are recorded once and replayed; writes and unrecorded reads throw', () => {
	const dir = temp_dir();
	const file = join(dir, 'data.txt');
	writeFileSync(file, 'first');
	const det = new Determinism();
	det.open('record');
	try {
		assert.equal(readFileSync(file, 'utf8'), 'first');
	} finally {
		det.close();
	}
	writeFileSync(file, 'second');
	det.open('replay');
	try {
		assert.equal(readFileSync(file, 'utf8'), 'first');
		assert.throws(() => readFileSync(join(dir, 'other.txt'), 'utf8'), AbaxIoError);
		assert.throws(() => writeFileSync(file, 'x'), AbaxIoError);
	} finally {
		det.close();
	}
	assert.equal(readFileSync(file, 'utf8'), 'second');
});

test('weak references made in the window never clear', () => {
	const det = new Determinism();
	det.open('replay');
	try {
		const ref = new WeakRef({ a: 1 });
		assert.deepEqual(ref.deref(), { a: 1 });
	} finally {
		det.close();
	}
});

test('double-run self-check: stable work passes, drifting work is "unstable"', async () => {
	const m = await load_module(`let calls = 0;
export function drift() {
	calls++;
	let s = 0;
	for (let i = 0; i < calls; i++) s += i;
	return s;
}
export async function steady() {
	let s = 0;
	const n = Math.floor(Math.random() * 10) + (Date.now() % 7);
	for (let i = 0; i < n; i++) s += i;
	await new Promise((r) => setTimeout(r, 25));
	return s;
}
`);
	const det = new Determinism();
	const steady = await run_case({ name: 'steady', fn: () => m.steady(), file: '' }, det, builtins);
	assert.equal(steady.stable, true);
	assert.ok(steady.a.snap.steps > 0);
	assert.equal(steady.a.timers, 1);
	const drift = await run_case({ name: 'drift', fn: () => m.drift(), file: '' }, det, builtins);
	assert.equal(drift.stable, false);
});
