import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/*
 * Child processes Heisenbench starts (measure layers, engine health, the counted app server), and the
 * rules that keep them from outliving the run:
 *
 * - each one is tracked while it runs; Ctrl-C or a kill of the parent (SIGINT, SIGTERM, SIGHUP)
 *   kills every tracked child, with its own children (its process group), before the parent exits;
 * - a child watches its parent and exits when the parent is gone (a SIGKILL that no handler sees);
 * - a child that runs past its time limit is killed with its whole group.
 */

const live = new Set<ChildProcess>();

const POSIX = process.platform !== 'win32';

function kill_tree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	try {
		// A detached child leads its own process group: the minus sign reaches everything in it.
		if (POSIX) process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// already gone
		}
	}
}

/** Track a child until it exits (killed with the parent; see exit_on_signals). */
export function track(child: ChildProcess): ChildProcess {
	live.add(child);
	child.once('exit', () => live.delete(child));
	return child;
}

/** Kill every tracked child and its group. */
export function kill_children(signal: NodeJS.Signals = 'SIGKILL'): void {
	for (const c of live) kill_tree(c, signal);
	live.clear();
}

const SIGNALS: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };
let handling = false;

/** In the CLI: a signal kills the children first, then exits with 128 + its number. */
export function exit_on_signals(): void {
	if (handling) return;
	handling = true;
	for (const [name, n] of Object.entries(SIGNALS)) {
		process.once(name as NodeJS.Signals, () => {
			kill_children();
			process.stderr.write(`\nheisenbench: stopped (${name})\n`);
			process.exit(128 + n);
		});
	}
	process.once('exit', () => kill_children());
}

/** In a child: exit when the parent that started it is gone. */
export function watch_parent(): void {
	const parent = process.ppid;
	const t = setInterval(() => {
		if (process.ppid !== parent) process.exit(1);
	}, 500);
	t.unref();
	process.once('disconnect', () => process.exit(1));
}

export interface RunResult {
	stdout: string;
	stderr: string;
}

export class ProcessError extends Error {
	stdout: string;
	stderr: string;
	code: number | null;
	signal: NodeJS.Signals | null;
	timed_out: boolean;
	constructor(
		message: string,
		o: {
			stdout: string;
			stderr: string;
			code: number | null;
			signal: NodeJS.Signals | null;
			timed_out: boolean;
		}
	) {
		super(message);
		this.stdout = o.stdout;
		this.stderr = o.stderr;
		this.code = o.code;
		this.signal = o.signal;
		this.timed_out = o.timed_out;
	}
}

/**
 * Run a command to its end, tracked, in its own process group, with a time limit that kills the
 * group. Output is kept up to `max_buffer` bytes per stream (the end is kept).
 */
export function run_process(
	cmd: string,
	args: readonly string[],
	o: { cwd?: string; env?: NodeJS.ProcessEnv; timeout_ms?: number; max_buffer?: number } = {}
): Promise<RunResult> {
	const max = o.max_buffer ?? 64 * 1024 * 1024;
	return new Promise((resolve, reject) => {
		const child = track(
			spawn(cmd, args, {
				cwd: o.cwd,
				env: o.env ?? process.env,
				stdio: ['ignore', 'pipe', 'pipe'],
				detached: POSIX
			})
		);
		let stdout = '';
		let stderr = '';
		const keep = (s: string, d: Buffer): string => {
			const t = s + d.toString('utf8');
			return t.length > max ? t.slice(t.length - max) : t;
		};
		child.stdout!.on('data', (d: Buffer) => (stdout = keep(stdout, d)));
		child.stderr!.on('data', (d: Buffer) => (stderr = keep(stderr, d)));
		let timed_out = false;
		const timer =
			o.timeout_ms === undefined
				? null
				: setTimeout(() => {
						timed_out = true;
						kill_tree(child, 'SIGKILL');
					}, o.timeout_ms);
		timer?.unref();
		child.once('error', (e) => {
			if (timer) clearTimeout(timer);
			reject(new ProcessError(e.message, { stdout, stderr, code: null, signal: null, timed_out }));
		});
		child.once('close', (code, signal) => {
			if (timer) clearTimeout(timer);
			if (code === 0 && !timed_out) return resolve({ stdout, stderr });
			const why = timed_out
				? `did not finish within ${Math.round((o.timeout_ms ?? 0) / 1000)} s`
				: signal
					? `was killed (${signal})`
					: `exited with ${code}`;
			reject(new ProcessError(why, { stdout, stderr, code, signal, timed_out }));
		});
	});
}
