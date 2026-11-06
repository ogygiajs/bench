/**
 * A child process in a process group of its own, so a time limit stops everything it started.
 * Abax spawns children of its own (the engine-health and measure children); `spawnSync`'s
 * `timeout` kills only the direct child and leaves those running, holding the CPU the next
 * command measures on, and its pipes open.
 *
 * The group is killed when the time is up, and again once the child exits (a grandchild that
 * outlived its parent goes with it). The groups still running when this process is stopped are
 * killed too.
 */
import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';

export interface GroupResult {
	/** Exit code, or null when a signal ended it. */
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	/** The time limit ended it. */
	timed_out: boolean;
	/** It could not start. */
	error: Error | null;
}

/** Output kept per stream: the newest part, when a child writes more. */
const KEEP = 1 << 26;

const running = new Set<number>();
let hooked = false;

function kill_group(pid: number): void {
	try {
		process.kill(-pid, 'SIGKILL');
	} catch {
		// already gone
	}
}

function hook_exit(): void {
	if (hooked) return;
	hooked = true;
	process.on('exit', () => {
		for (const pid of running) kill_group(pid);
	});
	for (const sig of ['SIGINT', 'SIGTERM'] as const) {
		process.once(sig, () => {
			for (const pid of running) kill_group(pid);
			process.kill(process.pid, sig);
		});
	}
}

function keep(chunks: string[], size: { n: number }, s: string): void {
	chunks.push(s);
	size.n += s.length;
	while (size.n > KEEP && chunks.length > 1) size.n -= chunks.shift()!.length;
}

/** Run `cmd` in its own process group; SIGKILL the whole group after `limit_ms`. */
export function spawn_group(
	cmd: string,
	args: readonly string[],
	opts: Pick<SpawnOptions, 'cwd' | 'env'>,
	limit_ms: number
): Promise<GroupResult> {
	hook_exit();
	return new Promise((resolve) => {
		const out: string[] = [];
		const err: string[] = [];
		const out_n = { n: 0 };
		const err_n = { n: 0 };
		let timed_out = false;
		let error: Error | null = null;
		const child = spawn(cmd, args, {
			...opts,
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const pid = child.pid;
		if (pid !== undefined) running.add(pid);
		child.stdout!.setEncoding('utf8').on('data', (s: string) => keep(out, out_n, s));
		child.stderr!.setEncoding('utf8').on('data', (s: string) => keep(err, err_n, s));
		const timer = setTimeout(() => {
			timed_out = true;
			if (pid !== undefined) kill_group(pid);
		}, limit_ms);
		let done = false;
		const finish = (status: number | null, signal: NodeJS.Signals | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			if (pid !== undefined) {
				kill_group(pid);
				running.delete(pid);
			}
			resolve({ status, signal, stdout: out.join(''), stderr: err.join(''), timed_out, error });
		};
		child.on('error', (e) => {
			error = e;
			if (pid === undefined) finish(null, null);
		});
		// A grandchild that outlived the child would keep the pipes open, and `close` from firing:
		// the group goes as soon as the child exits.
		child.on('exit', () => {
			if (pid !== undefined) kill_group(pid);
		});
		// `close`: the child exited and its pipes are drained.
		child.on('close', (status, signal) => finish(status, signal));
	});
}
