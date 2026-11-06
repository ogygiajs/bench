import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn_group } from '../src/spawn.ts';
import type { GroupResult } from '../src/spawn.ts';
import { command_error } from '../src/run.ts';

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function gone(pid: number): Promise<boolean> {
	for (let i = 0; i < 40; i++) {
		if (!alive(pid)) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return false;
}

/** A child that starts a grandchild sharing its pipes, writes the grandchild's pid, then `then`. */
function parent_script(pid_file: string, then: string): string {
	return `
		const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
		require('node:fs').writeFileSync(${JSON.stringify(pid_file)}, String(c.pid));
		console.log('started');
		${then}
	`;
}

test('the time limit kills the child and the processes it started', async () => {
	const pid_file = join(mkdtempSync(join(tmpdir(), 'spawn-')), 'pid');
	const t0 = Date.now();
	const r = await spawn_group(
		process.execPath,
		['-e', parent_script(pid_file, 'setInterval(() => {}, 1000);')],
		{},
		1500
	);
	assert.equal(r.timed_out, true);
	assert.equal(r.signal, 'SIGKILL');
	assert.match(r.stdout, /started/);
	assert.ok(Date.now() - t0 < 10_000);
	assert.ok(await gone(Number(readFileSync(pid_file, 'utf8'))), 'the grandchild was killed');
});

test('a child that exits leaves no process behind, and its exit code comes back', async () => {
	const pid_file = join(mkdtempSync(join(tmpdir(), 'spawn-')), 'pid');
	const t0 = Date.now();
	const r = await spawn_group(
		process.execPath,
		['-e', parent_script(pid_file, 'setTimeout(() => process.exit(3), 200);')],
		{},
		60_000
	);
	assert.equal(r.status, 3);
	assert.equal(r.timed_out, false);
	// the grandchild held the pipes open; it went with the group, so this did not wait a minute
	assert.ok(Date.now() - t0 < 10_000);
	assert.ok(await gone(Number(readFileSync(pid_file, 'utf8'))));
});

test('a command that cannot start says so', async () => {
	const r = await spawn_group('/nonexistent/abax-test-binary', [], {}, 5000);
	assert.ok(r.error);
	assert.match(command_error(r, false, 'abax run', 15)!, /did not start/);
});

const result = (over: Partial<GroupResult>): GroupResult => ({
	status: 0,
	signal: null,
	stdout: '',
	stderr: '',
	timed_out: false,
	error: null,
	...over
});

test('exit 0 or 1 with its part written is clean; anything else is an error, report or not', () => {
	assert.equal(command_error(result({}), true, 'abax run', 15), null);
	assert.equal(command_error(result({ status: 1 }), true, 'abax run', 15), null);
	assert.equal(
		command_error(result({ status: 134, stderr: 'abort\nat measure' }), true, 'abax run', 15),
		'abax run exited with 134\nabort\nat measure'
	);
	assert.equal(
		command_error(result({ status: null, signal: 'SIGSEGV' }), true, 'abax health', 15),
		'abax health was killed by SIGSEGV'
	);
	assert.equal(
		command_error(
			result({ status: null, signal: 'SIGKILL', timed_out: true }),
			true,
			'abax growth',
			5
		),
		'abax growth did not finish within 5 min'
	);
	assert.equal(
		command_error(result({ stderr: 'SyntaxError: x' }), false, 'abax run', 15),
		'SyntaxError: x'
	);
	assert.match(command_error(result({}), false, 'abax run', 15)!, /wrote nothing/);
});
