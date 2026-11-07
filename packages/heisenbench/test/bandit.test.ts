import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bandit, beta, density_reward } from '../src/search/bandit.ts';
import { GrammarPlan, Rng, arms_of } from '../src/search/mutate.ts';

/*
 * The bandit schedule of the worst-case search: Beta draws from the seeded generator, the density
 * reward, and an arm that keeps paying off is run more than its fixed-schedule share.
 */

test('Beta draws are in (0, 1), have the right mean, and repeat with the seed', () => {
	const draw = (seed: number) => {
		const r = new Rng(seed);
		return Array.from({ length: 2000 }, () => beta(r, 3, 7));
	};
	const a = draw(5);
	assert.deepEqual(a, draw(5));
	assert.notDeepEqual(a, draw(6));
	assert.ok(a.every((x) => x > 0 && x < 1));
	const mean = a.reduce((n, x) => n + x, 0) / a.length;
	assert.ok(Math.abs(mean - 0.3) < 0.02, String(mean));
});

test('the reward is the density gain, squashed into [0, 1)', () => {
	assert.equal(density_reward(10, 10), 0);
	assert.equal(density_reward(10, 5), 0);
	assert.equal(density_reward(0, 0), 0);
	assert.equal(density_reward(0, 3), 1);
	// a 25% gain is worth 1/2; a doubling more; a tenfold gain nearly 1
	assert.equal(density_reward(4, 5), 0.5);
	assert.ok(density_reward(4, 8) > 0.75 && density_reward(4, 8) < 0.85);
	assert.ok(density_reward(1, 10) > 0.95 && density_reward(1, 10) < 1);
});

test('an arm that keeps paying off is run more than its share; one that never does, less', () => {
	const r = new Rng(1);
	const b = new Bandit();
	const choices = [
		{ arm: 'a', weight: 1 },
		{ arm: 'b', weight: 1 },
		{ arm: 'c', weight: 1 }
	];
	const runs = { a: 0, b: 0, c: 0 };
	for (let i = 0; i < 600; i++) {
		const arm = b.pick(choices, r) as 'a' | 'b' | 'c';
		runs[arm]++;
		// `b` makes the input denser one try in two, the others never
		b.reward(arm, arm === 'b' && r.int(2) === 0 ? 0.8 : 0);
	}
	assert.ok(runs.b > 300, JSON.stringify(runs));
	assert.ok(runs.a < 150 && runs.c < 150, JSON.stringify(runs));
	const stats = b.stats();
	assert.equal(stats[0].arm, 'b');
	assert.equal(
		stats.reduce((n, s) => n + s.tries, 0),
		600
	);
	assert.equal(stats.find((s) => s.arm === 'a')!.gains, 0);
});

test("before any reward, the arms are run at the fixed schedule's shares", () => {
	const r = new Rng(3);
	const b = new Bandit();
	const choices = [
		{ arm: 'big', weight: 3 },
		{ arm: 'small', weight: 1 }
	];
	let big = 0;
	for (let i = 0; i < 4000; i++) if (b.pick(choices, r) === 'big') big++;
	assert.ok(Math.abs(big / 4000 - 0.75) < 0.03, String(big));
});

test("the arms of an input are the operators that can change it, at the fixed schedule's shares", () => {
	const plan = new GrammarPlan();
	const sum = (xs: { weight: number }[]) => xs.reduce((n, x) => n + x.weight, 0);

	// no strings: the plain edits only. Half the time the array itself, else one of its five
	// places (the object, the array, three numbers)
	const nums = arms_of({ xs: [3, 1, 2] }, plan);
	const share = (prefix: string) => sum(nums.filter((a) => a.arm.startsWith(prefix)));
	assert.ok(nums.every((a) => !a.arm.startsWith('node: ') && !a.arm.startsWith('string: ')));
	assert.ok(nums.some((a) => a.arm === 'array: sort down'));
	assert.ok(Math.abs(share('array: ') - 0.6) < 1e-9);
	assert.ok(Math.abs(share('number: ') - 0.3) < 1e-9);
	assert.ok(Math.abs(share('object: ') - 0.1) < 1e-9);
	// a one-key object cannot swap two values
	assert.ok(!nums.some((a) => a.arm === 'object: swap two values'));

	// a JSON string: five tries in six are grammar edits, by their fixed weights
	const doc = arms_of({ doc: '{"a":"b","c":[1,2]}' }, plan);
	const node = doc.filter((a) => a.arm.startsWith('node: '));
	assert.equal(node.length, 11);
	assert.ok(Math.abs(sum(node) - 5 / 6) < 1e-9);
	assert.ok(Math.abs(sum(doc) - 1) < 1e-9);
	const run = node.find((a) => a.arm === 'node: run')!.weight;
	const wrap = node.find((a) => a.arm === 'node: wrap')!.weight;
	assert.ok(run > 2 * wrap);

	// plain text: half its edits are the plain string edits
	const text = arms_of({ text: 'the quick brown fox' }, plan);
	const edit = text.find((a) => a.arm === 'string: edit')!.weight;
	assert.ok(edit > 5 / 12, String(edit));
	assert.ok(Math.abs(sum(text) - 1) < 1e-9);
});
