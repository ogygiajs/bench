import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactError, validate_heisenbench } from '../src/artifact.ts';
import {
	SHARDS_FORMAT,
	SHARD_LIMITS,
	ShardError,
	check_manifest,
	join_shards,
	load_result,
	load_result_file,
	split_result
} from '../src/shards.ts';
import type { ShardManifest } from '../src/shards.ts';

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const meta = { kind: 'pr', sha: SHA, base: BASE, pr: 12 };
const plan = { kind: 'pr', sha: SHA, base_sha: BASE, pr: '12' };

const kase = (file: string, name: string, pad = 0) => ({
	file,
	name,
	totals: { steps: name.length },
	functions: [{ id: `${file} > f`, lines: [{ line: 1, steps: 3 }] }],
	pad: 'x'.repeat(pad)
});
const report = (cases: unknown[]) => ({
	schema: 'heisenbench-report/1',
	node: 'v26',
	cases,
	engine: {
		schema: 'heisenbench-engine/1',
		cases: cases.map((c) => ({ ...(c as object), sites: [] }))
	}
});
const result = (head: unknown[], base: unknown[] | null) => ({
	schema: 'ogygia-heisenbench/1',
	meta,
	selection: { files: 2 },
	head: report(head),
	base: base ? report(base) : null,
	diff: { summary: 'ok' }
});

const two_files = () =>
	result(
		[kase('a.bench.ts', 'a1'), kase('a.bench.ts', 'a2'), kase('b.bench.ts', 'b1')],
		[kase('a.bench.ts', 'a1'), kase('a.bench.ts', 'a2'), kase('b.bench.ts', 'b-changed')]
	);

const reader = (files: Map<string, string>) => (name: string) => Buffer.from(files.get(name)!);

/** An artifact directory: result.json, section.md and shards/ as written by the measure job. */
function artifact(
	text: string,
	files: Map<string, string | Buffer>,
	extra: Record<string, string> = {}
): string {
	const dir = mkdtempSync(join(tmpdir(), 'shards-'));
	writeFileSync(join(dir, 'result.json'), text);
	writeFileSync(join(dir, 'section.md'), '#### Heisenbench');
	mkdirSync(join(dir, 'shards'));
	for (const [name, t] of files) writeFileSync(join(dir, 'shards', name), t);
	for (const [name, t] of Object.entries(extra)) writeFileSync(join(dir, 'shards', name), t);
	return dir;
}

test('a result splits into a manifest and shards and joins back the same', () => {
	const r = two_files();
	const s = split_result(r);
	assert.equal(s.manifest.format, SHARDS_FORMAT);
	assert.deepEqual(s.manifest.meta, meta);
	assert.deepEqual(
		s.manifest.shards.map((e) => [e.of, e.group, e.part]),
		[
			['body', '', 0],
			['head.cases', 'a.bench.ts', 0],
			['head.cases', 'b.bench.ts', 0],
			['head.engine', 'a.bench.ts', 0],
			['head.engine', 'b.bench.ts', 0],
			['base.cases', 'a.bench.ts', 0],
			['base.cases', 'b.bench.ts', 0],
			['base.engine', 'a.bench.ts', 0],
			['base.engine', 'b.bench.ts', 0]
		]
	);
	for (const e of s.manifest.shards) {
		assert.equal(e.name, `${e.sha256}.json`);
		assert.equal(e.sha256, createHash('sha256').update(s.files.get(e.name)!).digest('hex'));
		assert.equal(e.bytes, Buffer.byteLength(s.files.get(e.name)!));
	}
	// an unchanged bench file is one shard for both sides; a changed one is two
	const named = (of: string, group: string) =>
		s.manifest.shards.find((e) => e.of === of && e.group === group)!.name;
	assert.equal(named('head.cases', 'a.bench.ts'), named('base.cases', 'a.bench.ts'));
	assert.notEqual(named('head.cases', 'b.bench.ts'), named('base.cases', 'b.bench.ts'));
	assert.equal(s.files.size, 7);
	assert.deepEqual(join_shards(s.manifest, reader(s.files)).result, r);
	assert.deepEqual(load_result(s.text, reader(s.files)), r);
	// the same input writes the same names: the next run's unchanged shards are already stored
	assert.deepEqual([...split_result(two_files()).files.keys()], [...s.files.keys()]);
});

test('a result without a base, or without an engine layer, round trips', () => {
	const r = result([kase('a.bench.ts', 'a1')], null);
	const { engine: _, ...plain } = r.head;
	for (const x of [r, { ...r, head: plain }]) {
		const s = split_result(x);
		assert.deepEqual(load_result(s.text, reader(s.files)), x);
	}
});

test('a result over 40 MB is cut into shards of at most 40 MB, in order', () => {
	const MiB = 1 << 20;
	// 45 cases of about 1 MiB from one bench file: one group, over the shard size
	const big = Array.from({ length: 45 }, (_, i) => kase('big.bench.ts', `c${i}`, MiB));
	const r = result(big, null);
	assert.ok(JSON.stringify(r).length > 40 * MiB);
	const s = split_result(r);
	const parts = s.manifest.shards.filter((e) => e.of === 'head.cases');
	assert.ok(parts.length >= 2, `${parts.length} parts`);
	assert.deepEqual(
		parts.map((e) => e.part),
		parts.map((_, i) => i)
	);
	for (const e of s.manifest.shards) assert.ok(e.bytes <= SHARD_LIMITS.shard);
	const back = load_result(s.text, reader(s.files)) as typeof r;
	assert.deepEqual(
		back.head.cases.map((c) => c.name),
		big.map((c) => c.name)
	);
	assert.throws(() => split_result(result([kase('x', 'one', 100)], null), 50), /over the 50 byte/);
});

test('a run file from before shards reads as it is', () => {
	const r = two_files();
	const none = () => assert.fail('no shard is read');
	assert.deepEqual(load_result(JSON.stringify(r), none), r);
	const dir = mkdtempSync(join(tmpdir(), 'old-'));
	writeFileSync(join(dir, 'x.json'), JSON.stringify(r));
	assert.deepEqual(load_result_file(join(dir, 'x.json')), r);
	assert.throws(() => load_result('{nope', none), SyntaxError);
});

test('the results branch layout: a manifest in pr/ finds heisenbench/shards/', () => {
	const r = two_files();
	const s = split_result(r);
	const root = mkdtempSync(join(tmpdir(), 'results-'));
	mkdirSync(join(root, 'pr'));
	mkdirSync(join(root, 'shards'));
	writeFileSync(join(root, 'pr', '12.json'), s.text);
	for (const [name, t] of s.files) writeFileSync(join(root, 'shards', name), t);
	assert.deepEqual(load_result_file(join(root, 'pr', '12.json')), r);
});

test('a manifest is refused for a bad name, size, count, total, order or format', () => {
	const s = split_result(two_files());
	const m = (patch: (m: ShardManifest) => void): ShardManifest => {
		const copy = structuredClone(s.manifest);
		patch(copy);
		return copy;
	};
	const cases: Array<[ShardManifest, RegExp]> = [
		[m((x) => (x.shards[1].name = '../../etc/passwd')), /not a sha256/],
		[m((x) => (x.shards[1].name = `${'A'.repeat(64)}.json`)), /not a sha256/],
		[m((x) => (x.shards[1].name = `${'0'.repeat(64)}.json`)), /not named by its sha256/],
		[m((x) => (x.shards[1].bytes = SHARD_LIMITS.shard + 1)), /over the .* byte limit/],
		[m((x) => (x.shards[1].of = 'meta' as never)), /is of "meta"/],
		[m((x) => x.shards.reverse()), /body must be the first/],
		[m((x) => (x.shards = [])), /no shards/],
		[m((x) => (x.format = 'heisenbench-shards/9' as never)), /unknown run file format/]
	];
	for (const [bad, why] of cases) assert.throws(() => check_manifest(bad), why);
	// one shard listed many times still counts its size every time
	const many = m((x) => {
		x.shards = [x.shards[0], ...Array.from({ length: 30 }, () => x.shards[1])];
	});
	assert.throws(
		() => check_manifest(many, { ...SHARD_LIMITS, count: 10 }),
		/31 shards, over the 10 limit/
	);
	assert.throws(
		() => check_manifest(many, { ...SHARD_LIMITS, total: 1000 }),
		/add up to .* over the 1000 byte limit/
	);
	assert.doesNotThrow(() => check_manifest(many));
});

test('a tampered or resized shard is refused', () => {
	const s = split_result(two_files());
	const name = s.manifest.shards[1].name;
	const text = s.files.get(name)!;
	const tampered = new Map(s.files).set(name, text.replace('"a1"', '"a9"'));
	assert.throws(() => join_shards(s.manifest, reader(tampered)), /does not hash to its name/);
	const longer = new Map(s.files).set(name, text + ' ');
	assert.throws(() => join_shards(s.manifest, reader(longer)), /the manifest says/);
	assert.throws(() => join_shards(s.manifest, reader(longer)), ShardError);
});

test('the publish check takes a sharded artifact and the shards it lists, checked', () => {
	const s = split_result(two_files());
	const a = validate_heisenbench(artifact(s.text, s.files), plan);
	assert.equal(a.result, s.text);
	assert.deepEqual([...a.shards.keys()].sort(), [...s.files.keys()].sort());
	assert.equal(a.section, '#### Heisenbench');
});

test('the publish check refuses extra, missing, linked, tampered or oversize shards', () => {
	const s = split_result(two_files());
	const first = s.manifest.shards[1].name;
	const without = new Map(s.files);
	without.delete(first);
	const tampered = new Map(s.files).set(first, s.files.get(first)!.replace('"a1"', '"a9"'));
	const longer = new Map(s.files).set(first, s.files.get(first)! + ' ');
	const cases: Array<[string, RegExp]> = [
		[artifact(s.text, s.files, { [`${'f'.repeat(64)}.json`]: '[]' }), /not in the manifest/],
		[artifact(s.text, s.files, { 'notes.md': 'x' }), /notes\.md is not in the manifest/],
		[artifact(s.text, without), new RegExp(`${first} is missing`)],
		[artifact(s.text, tampered), /does not hash to its name/],
		[artifact(s.text, longer), /over the \d+ byte limit/]
	];
	const linked = artifact(s.text, without);
	symlinkSync('/etc/hosts', join(linked, 'shards', first));
	cases.push([linked, /not a regular file/]);
	const no_dir = artifact(s.text, new Map());
	rmdirSync(join(no_dir, 'shards'));
	cases.push([no_dir, /shards\/ is missing/]);
	for (const [dir, why] of cases) {
		assert.throws(() => validate_heisenbench(dir, plan), ArtifactError);
		assert.throws(() => validate_heisenbench(dir, plan), why);
	}
});

test('the publish check holds a manifest to its plan, its size and its body', () => {
	const r = two_files();
	const other = split_result({ ...r, meta: { ...meta, pr: 13 } });
	assert.throws(
		() => validate_heisenbench(artifact(other.text, other.files), plan),
		/meta\.pr is 13/
	);
	// a manifest whose meta says one thing and whose body says another
	const s = split_result(r);
	const lying = JSON.stringify({ ...s.manifest, meta: { ...meta, sha: BASE } });
	const body_lies = split_result({ ...r, meta: { ...meta, sha: BASE } });
	const swapped = JSON.stringify({ ...s.manifest, shards: body_lies.manifest.shards });
	assert.throws(
		() => validate_heisenbench(artifact(lying, s.files), plan),
		/body shard has other meta/
	);
	assert.throws(
		() => validate_heisenbench(artifact(swapped, body_lies.files), plan),
		/body shard has other meta/
	);
	const padded = JSON.stringify({ ...s.manifest, pad: 'x'.repeat(SHARD_LIMITS.manifest) });
	assert.throws(() => validate_heisenbench(artifact(padded, s.files), plan), /manifest over/);
	// shards next to a whole result are refused too
	assert.throws(
		() => validate_heisenbench(artifact(JSON.stringify(r), s.files), plan),
		/not a manifest/
	);
});
