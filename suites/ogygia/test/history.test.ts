import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { done_before, history_commits } from '../src/history.ts';

function git(dir: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd: dir,
		encoding: 'utf8',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 't',
			GIT_AUTHOR_EMAIL: 't@t',
			GIT_COMMITTER_NAME: 't',
			GIT_COMMITTER_EMAIL: 't@t'
		}
	}).trim();
}

test('history backfill: the newest first-parent commits, oldest first; a run counted alike is skipped', () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'history-suite-')));
	git(dir, 'init', '-q', '-b', 'main');
	const shas: string[] = [];
	for (let i = 0; i < 4; i++) {
		writeFileSync(join(dir, 'f.txt'), String(i));
		git(dir, 'add', '-A');
		git(dir, 'commit', '-q', '-m', `c${i}`);
		shas.push(git(dir, 'rev-parse', 'HEAD'));
	}
	// a side branch merged into main: its commit is not on the first-parent line
	git(dir, 'checkout', '-q', '-b', 'side', shas[2]);
	writeFileSync(join(dir, 'g.txt'), 'side');
	git(dir, 'add', '-A');
	git(dir, 'commit', '-q', '-m', 'side');
	const side = git(dir, 'rev-parse', 'HEAD');
	git(dir, 'checkout', '-q', 'main');
	git(dir, 'merge', '-q', '--no-ff', '-m', 'merge', 'side');
	const merge = git(dir, 'rev-parse', 'HEAD');
	assert.deepEqual(history_commits(dir, 'main', 3), [shas[2], shas[3], merge]);
	assert.ok(!history_commits(dir, 'main', 10).includes(side));
	assert.deepEqual(history_commits(dir, 'main', 0), []);

	const file = join(dir, 'run.json');
	assert.equal(done_before(file, 'hb1', shas[3]), false);
	writeFileSync(file, JSON.stringify({ meta: { heisenbench: 'hb1', bench: shas[3] }, head: null }));
	assert.equal(done_before(file, 'hb1', shas[3]), true);
	assert.equal(done_before(file, 'hb2', shas[3]), false, 'another Heisenbench counts it again');
	assert.equal(done_before(file, 'hb1', shas[2]), false, 'other bench files count it again');
});
