import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunFile } from '@bench/compare';
import { RETENTION, retention_drops } from '../src/retention.ts';
import type { PrState } from '../src/retention.ts';

const NOW = new Date('2026-12-31T12:00:00Z');
const sha = (c: string) => c.repeat(40);
const file = (path: string, meta: Record<string, unknown> | null): RunFile => ({
	path,
	bytes: 10,
	sharded: true,
	meta,
	shards: []
});
const days_ago = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

test('a PR’s runs go 30 days after it closed; an open or unknown PR’s runs stay', () => {
	const files = [
		file('pr/1.json', { kind: 'pr', pr: 1, sha: sha('1') }),
		file('commit/1111111111111111111111111111111111111111.json', {
			kind: 'pr',
			pr: 1,
			sha: sha('1')
		}),
		file('pr/2.json', { kind: 'pr', pr: 2 }),
		file('pr/3.json', { kind: 'pr', pr: 3 }),
		file('pr/4.json', { kind: 'pr', pr: 4 })
	];
	const prs = new Map<number, PrState>([
		[1, { state: 'closed', closed_at: days_ago(RETENTION.pr_days + 1) }],
		[2, { state: 'closed', closed_at: days_ago(RETENTION.pr_days - 1) }],
		[3, { state: 'open', closed_at: null }]
		// 4: its state could not be read
	]);
	assert.deepEqual(
		retention_drops(files, prs, new Map(), NOW).map((d) => [d.path, d.why]),
		[
			['commit/1111111111111111111111111111111111111111.json', 'PR #1 closed 31 days ago'],
			['pr/1.json', 'PR #1 closed 31 days ago']
		]
	);
});

test('main runs stay 180 days; older, the newest of each month stays for good', () => {
	const main = (c: string) => [
		file(`main/${sha(c)}.json`, { kind: 'main', sha: sha(c) }),
		file(`commit/${sha(c)}.json`, { kind: 'main', sha: sha(c) })
	];
	const files = [
		...['a', 'b', 'c', 'd', 'e', 'f'].flatMap(main),
		file('main/latest.json', { kind: 'main', sha: sha('a') }),
		file('main/app-weights.json', null),
		file('registry/receipts/x/1.0.0.json', { kind: 'receipt' })
	];
	const dates = new Map([
		[sha('a'), '2026-06-03T10:00:00Z'], // June, older: dropped
		[sha('b'), '2026-06-20T10:00:00Z'], // June's newest: kept
		[sha('c'), '2026-05-01T10:00:00Z'], // May's only: kept
		[sha('d'), days_ago(RETENTION.main_days - 1)] // recent: kept
		// e has no date (not in the clone): kept; f the same
	]);
	const drops = retention_drops(files, new Map(), dates, NOW);
	assert.deepEqual(
		drops.map((d) => d.path),
		[`commit/${sha('a')}.json`, `main/${sha('a')}.json`]
	);
	assert.match(drops[0].why, /not the newest of 2026-06/);
	// latest.json is kept even though its commit's other files go
	assert.ok(!drops.some((d) => d.path === 'main/latest.json'));
});

test('the policy is one object: a shorter window drops more', () => {
	const files = [file('pr/1.json', { kind: 'pr', pr: 1 })];
	const prs = new Map<number, PrState>([[1, { state: 'closed', closed_at: days_ago(10) }]]);
	assert.equal(retention_drops(files, prs, new Map(), NOW).length, 0);
	assert.equal(retention_drops(files, prs, new Map(), NOW, { ...RETENTION, pr_days: 7 }).length, 1);
});
