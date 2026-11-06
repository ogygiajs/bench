import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/run.ts';

// The bench files of a tree run side by side (a PR run spent 15 min running them one at a time).

test('pool runs every task, at most `jobs` at once', async () => {
	let running = 0;
	let most = 0;
	const done: number[] = [];
	const tasks = Array.from({ length: 10 }, (_, i) => async () => {
		running++;
		most = Math.max(most, running);
		await new Promise((r) => setTimeout(r, 5 + ((i * 7) % 11)));
		done.push(i);
		running--;
	});
	await pool(tasks, 3);
	assert.equal(most, 3);
	assert.deepEqual(
		[...done].sort((a, b) => a - b),
		Array.from({ length: 10 }, (_, i) => i)
	);
	// one job: one at a time, in order (the time layer's case)
	const order: number[] = [];
	await pool(
		Array.from({ length: 4 }, (_, i) => async () => {
			order.push(i);
		}),
		1
	);
	assert.deepEqual(order, [0, 1, 2, 3]);
	await pool([], 4);
});
