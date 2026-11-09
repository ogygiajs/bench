import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GcError, apply_gc, parse_drops, plan_gc, render_gc, scan_results } from '../src/gc.ts';
import { split_result } from '../src/shards.ts';

const kase = (file: string, name: string) => ({ file, name, totals: { steps: name.length } });
const run = (sha: string, head: Array<[string, string]>) => ({
	schema: 'ogygia-heisenbench/1',
	meta: { kind: 'main', sha },
	head: { cases: head.map(([f, n]) => kase(f, n)) },
	base: null
});

/** A results tree: run files at `files` (a manifest's shards go to shards/), and plain files. */
function tree(files: Record<string, object>, plain: Record<string, string> = {}): string {
	const root = mkdtempSync(join(tmpdir(), 'gc-'));
	mkdirSync(join(root, 'shards'));
	for (const [path, result] of Object.entries(files)) {
		const s = split_result(result as Record<string, unknown>);
		mkdirSync(join(root, path, '..'), { recursive: true });
		writeFileSync(join(root, path), s.text);
		for (const [name, text] of s.files) writeFileSync(join(root, 'shards', name), text);
	}
	for (const [path, text] of Object.entries(plain)) {
		mkdirSync(join(root, path, '..'), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return root;
}

const listing = (root: string) => ({
	shards: readdirSync(join(root, 'shards')).sort(),
	main: readdirSync(join(root, 'main')).sort()
});

test('mark and sweep: shards no run file lists go, listed ones stay', () => {
	const root = tree({ 'main/a.json': run('a', [['x.bench.ts', 'x1']]) });
	const kept = listing(root).shards;
	writeFileSync(join(root, 'shards', `${'0'.repeat(64)}.json`), '[1]');
	writeFileSync(join(root, 'shards', `${'1'.repeat(64)}.json`), '[22]');
	const scan = scan_results(root);
	assert.deepEqual(scan.errors, []);
	const plan = plan_gc(scan, []);
	assert.deepEqual(
		plan.drop_shards.map((s) => s.name),
		[`${'0'.repeat(64)}.json`, `${'1'.repeat(64)}.json`]
	);
	assert.equal(plan.bytes_freed, 3 + 4);
	assert.equal(plan.kept_files, 1);
	apply_gc(root, plan);
	assert.deepEqual(listing(root).shards, kept);
	// a second sweep finds nothing
	assert.equal(plan_gc(scan_results(root), []).drop_shards.length, 0);
});

test('retention drops: the run files named go first, then the shards only they listed', () => {
	const root = tree(
		{
			'main/a.json': run('a', [['x.bench.ts', 'x1']]),
			'main/b.json': run('b', [['x.bench.ts', 'x2']])
		},
		// a run file from before shards is a run file too, and lists no shard
		{ 'main/old.json': JSON.stringify(run('old', [['x.bench.ts', 'x0']])) }
	);
	const before = listing(root).shards.length;
	const drops = parse_drops(
		JSON.stringify({
			drop: [
				{ path: 'main/a.json', why: 'old' },
				{ path: 'main/old.json', why: 'older' }
			]
		})
	);
	const plan = plan_gc(scan_results(root), drops);
	assert.deepEqual(
		plan.drop_files.map((f) => f.path),
		['main/a.json', 'main/old.json']
	);
	// a's body and its x.bench.ts shard: b lists other ones
	assert.equal(plan.drop_shards.length, 2);
	apply_gc(root, plan);
	assert.deepEqual(listing(root).main, ['b.json']);
	assert.equal(listing(root).shards.length, before - 2);
	assert.deepEqual(scan_results(root).errors, []);
	assert.match(render_gc(plan, false), /deleted: 2 run files and 2 shards/);
	assert.throws(
		() => plan_gc(scan_results(root), [{ path: '../../etc/passwd', why: 'x' }]),
		/not a run file/
	);
});

test('shared shards survive while one run file still lists them', () => {
	// the same bench file counted alike in two runs: one shard, listed by both
	const root = tree({
		'main/a.json': run('a', [['x.bench.ts', 'same']]),
		'main/b.json': run('b', [['x.bench.ts', 'same']])
	});
	const plan = plan_gc(scan_results(root), [{ path: 'main/a.json', why: 'old' }]);
	// only a's body goes; the shared case shard stays for b
	assert.equal(plan.drop_shards.length, 1);
	apply_gc(root, plan);
	assert.deepEqual(scan_results(root).errors, []);
	const both = plan_gc(scan_results(root), [{ path: 'main/b.json', why: 'old' }]);
	assert.equal(both.drop_shards.length, 2);
});

test('a dry run changes nothing', () => {
	const root = tree({ 'main/a.json': run('a', [['x.bench.ts', 'x1']]) });
	writeFileSync(join(root, 'shards', `${'0'.repeat(64)}.json`), '[1]');
	const before = listing(root);
	const plan = plan_gc(scan_results(root), [{ path: 'main/a.json', why: 'old' }]);
	assert.match(render_gc(plan, true), /would delete: 1 run files and 3 shards/);
	assert.deepEqual(listing(root), before);
});

test('a run file or shard that cannot be read stops the sweep: nothing is deleted', () => {
	/** The first shard main/a.json lists. */
	const listed = (r: string): string =>
		(
			JSON.parse(readFileSync(join(r, 'main', 'a.json'), 'utf8')) as {
				shards: Array<{ name: string }>;
			}
		).shards[0].name;
	const broken: Array<[string, (root: string) => void, RegExp]> = [
		['not JSON', (r) => writeFileSync(join(r, 'main', 'bad.json'), '{nope'), /bad\.json: not JSON/],
		[
			'a manifest that does not check',
			(r) =>
				writeFileSync(join(r, 'main', 'bad.json'), JSON.stringify({ format: 'x', shards: [] })),
			/unknown run file format/
		],
		['a listed shard missing', (r) => rmSync(join(r, 'shards', listed(r))), /is missing/],
		[
			'a listed shard changed',
			(r) => {
				const name = listed(r);
				writeFileSync(join(r, 'shards', name), 'x'.repeat(scan_results(r).shards.get(name)!));
			},
			/does not hash to its name/
		],
		[
			'a stray file in shards/',
			(r) => writeFileSync(join(r, 'shards', 'notes.json'), '{}'),
			/shards\/notes\.json: not a shard/
		]
	];
	for (const [what, harm, why] of broken) {
		const root = tree({ 'main/a.json': run('a', [['x.bench.ts', 'x1']]) });
		writeFileSync(join(root, 'shards', `${'0'.repeat(64)}.json`), '[1]');
		harm(root);
		const scan = scan_results(root);
		assert.ok(scan.errors.length > 0, what);
		assert.throws(() => plan_gc(scan, []), GcError, what);
		assert.throws(() => plan_gc(scan, []), why, what);
	}
});
