import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ArtifactError,
	read_file,
	validate_heisenbench,
	validate_apps,
	validate_weights
} from '../src/artifact.ts';

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function dir_with(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'artifact-'));
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
	return dir;
}

const heisenbench_result = (meta: Record<string, unknown>) =>
	JSON.stringify({ schema: 'ogygia-heisenbench/1', meta, selection: {} });

const pr_plan = { kind: 'pr', sha: SHA, base_sha: BASE, pr: '12' };
const pr_meta = { kind: 'pr', sha: SHA, base: BASE, pr: 12 };

test('a Heisenbench artifact that matches the plan passes, as uploaded', () => {
	const result = heisenbench_result(pr_meta);
	const dir = dir_with({ 'result.json': result, 'section.md': '#### Heisenbench\n\nok' });
	assert.deepEqual(validate_heisenbench(dir, pr_plan), {
		result,
		shards: new Map(),
		section: '#### Heisenbench\n\nok'
	});
});

test('a Heisenbench artifact for another commit, PR, base or kind is rejected', () => {
	for (const meta of [
		{ ...pr_meta, sha: 'c'.repeat(40) },
		{ ...pr_meta, pr: 13 },
		{ ...pr_meta, base: null },
		{ ...pr_meta, kind: 'main' }
	]) {
		const dir = dir_with({ 'result.json': heisenbench_result(meta), 'section.md': 'x' });
		assert.throws(() => validate_heisenbench(dir, pr_plan), ArtifactError);
	}
	const main = dir_with({
		'result.json': heisenbench_result({ kind: 'main', sha: SHA, base: null, pr: null }),
		'section.md': 'x'
	});
	assert.doesNotThrow(() => validate_heisenbench(main, { kind: 'main', sha: SHA }));
});

test('bad JSON, a wrong schema, a missing file or section markers are rejected', () => {
	const cases: Array<[Record<string, string>, RegExp]> = [
		[{ 'result.json': '{nope', 'section.md': 'x' }, /not JSON/],
		[{ 'result.json': '[1]', 'section.md': 'x' }, /not a JSON object/],
		[
			{ 'result.json': JSON.stringify({ schema: 'other', meta: pr_meta }), 'section.md': 'x' },
			/schema/
		],
		[{ 'result.json': heisenbench_result(pr_meta) }, /section\.md is missing/],
		[
			{
				'result.json': heisenbench_result(pr_meta),
				'section.md': 'a <!-- /section:heisenbench --> b'
			},
			/section markers/
		]
	];
	for (const [files, why] of cases) {
		assert.throws(() => validate_heisenbench(dir_with(files), pr_plan), why);
	}
});

test('only plain, regular, small, UTF-8 files are read', () => {
	const dir = dir_with({ 'a.md': 'hello', 'big.md': 'x'.repeat(100), 'bin.md': '' });
	writeFileSync(join(dir, 'bin.md'), Buffer.from([0xff, 0xfe, 0x00]));
	symlinkSync('/etc/hosts', join(dir, 'link.md'));
	mkdirSync(join(dir, 'sub.md'));
	assert.equal(read_file(dir, 'a.md', 10), 'hello');
	assert.throws(() => read_file(dir, 'big.md', 10), /over the 10 byte limit/);
	assert.throws(() => read_file(dir, 'bin.md', 10), /not UTF-8/);
	assert.throws(() => read_file(dir, 'link.md', 10), /not a regular file/);
	assert.throws(() => read_file(dir, 'sub.md', 10), /not a regular file/);
	assert.throws(() => read_file(dir, '../a.md', 10), /not a file name/);
	assert.equal(read_file(dir, 'none.md', 10, true), null);
});

test('an app run is kept under its sha, or the weekly run under its validated version', () => {
	const run = (meta: Record<string, unknown>) => JSON.stringify({ meta });
	const pr = dir_with({
		'run.json': run({ mode: 'pr', sha: SHA, pr: 4, ogygia: '0.0.0-x' }),
		'comment.md': '#### App benchmark'
	});
	assert.equal(validate_apps(pr, { kind: 'pr', sha: SHA, pr: '4' }).name, SHA);
	// a PR run needs its comment
	const no_comment = dir_with({ 'run.json': run({ mode: 'pr', sha: SHA, pr: 4 }) });
	assert.throws(() => validate_apps(no_comment, { kind: 'pr', sha: SHA, pr: '4' }), /comment\.md/);
	const weekly = dir_with({ 'run.json': run({ mode: 'main', sha: null, ogygia: '0.12.3' }) });
	const a = validate_apps(weekly, { kind: 'main', sha: '' });
	assert.equal(a.name, 'v0.12.3');
	assert.equal(a.comment, null);
	for (const ogygia of ['../../x', '1.2', null, '1.2.3/../x']) {
		const bad = dir_with({ 'run.json': run({ mode: 'main', sha: null, ogygia }) });
		assert.throws(() => validate_apps(bad, { kind: 'main', sha: '' }), /not a version/);
	}
	const other = dir_with({ 'run.json': run({ mode: 'main', sha: BASE }) });
	assert.throws(() => validate_apps(other, { kind: 'main', sha: SHA }), /meta\.sha/);
});

test('weights must be app weights counted on the plan’s commit', () => {
	const w = (sha: string) =>
		JSON.stringify({
			schema: 'heisenbench-app-weights/1',
			source: { sha },
			units: {},
			functions: {}
		});
	assert.ok(validate_weights(dir_with({ 'app-weights.json': w(SHA) }), { kind: 'main', sha: SHA }));
	assert.throws(
		() => validate_weights(dir_with({ 'app-weights.json': w(BASE) }), { kind: 'main', sha: SHA }),
		/source\.sha/
	);
});
