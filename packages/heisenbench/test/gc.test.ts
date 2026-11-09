import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { split_result } from '@bench/compare';
import { temp_dir } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const gc = (...args: string[]) =>
	spawnSync(process.execPath, [CLI, 'gc', ...args], { encoding: 'utf8' });

function results(): string {
	const root = temp_dir('heisenbench-gc-');
	mkdirSync(join(root, 'main'));
	mkdirSync(join(root, 'shards'));
	const s = split_result({ schema: 's', meta: { kind: 'main', sha: 'a' }, head: { cases: [] } });
	writeFileSync(join(root, 'main', 'a.json'), s.text);
	for (const [name, text] of s.files) writeFileSync(join(root, 'shards', name), text);
	writeFileSync(join(root, 'shards', `${'0'.repeat(64)}.json`), '[1]');
	return root;
}

test('heisenbench gc: a dry run says what would go and deletes nothing; a run deletes it', () => {
	const root = results();
	const policy = join(temp_dir('heisenbench-gc-policy-'), 'drops.json');
	writeFileSync(policy, JSON.stringify({ drop: [{ path: 'main/a.json', why: 'old' }] }));
	const dry = gc('--root', root, '--drop', policy, '--dry-run');
	assert.equal(dry.status, 0, dry.stderr);
	assert.match(dry.stdout, /would delete: 1 run files and 2 shards/);
	assert.match(dry.stdout, /main\/a\.json .*: old/);
	assert.equal(readdirSync(join(root, 'shards')).length, 2);
	const real = gc('--root', root, '--drop', policy);
	assert.equal(real.status, 0, real.stderr);
	assert.deepEqual(readdirSync(join(root, 'shards')), []);
	assert.deepEqual(readdirSync(join(root, 'main')), []);
});

test('heisenbench gc: a run file it cannot read stops it with the list', () => {
	const root = results();
	writeFileSync(join(root, 'main', 'bad.json'), '{nope');
	const r = gc('--root', root);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /nothing is deleted/);
	assert.match(r.stderr, /main\/bad\.json: not JSON/);
	assert.equal(readdirSync(join(root, 'shards')).length, 2);
});
