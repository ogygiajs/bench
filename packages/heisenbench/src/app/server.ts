import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CaseReport } from '../report.ts';
import { own_file } from '../own.ts';
import { track } from '../proc.ts';
import { with_conditions } from '../loader/conditions-env.ts';
import type { UnstableFunction } from './stability.ts';
import type { LoadedModules } from './types.ts';

/*
 * The parent side of the counted server (server-child.ts): start it on a counted build, let the
 * browser session talk to it over HTTP, count requests inside the measuring window.
 */

export interface AppRequest {
	method?: string;
	/** Path and query, e.g. `/product/4`. */
	path: string;
	body?: string;
	headers?: Record<string, string>;
}

/** One counted server case: `requests` in order, the whole list `repeat` times. */
export interface CountedServerCase {
	name: string;
	requests: AppRequest[];
	repeat: number;
}

export interface ServerCaseResult {
	name: string;
	report?: CaseReport;
	/** Functions whose counts differed between the two measured runs. */
	unstable?: UnstableFunction[];
	/** Response status of each request of the last run. */
	statuses?: number[];
	error?: string;
}

export type ParentMessage =
	| {
			type: 'init';
			/** `.svelte-kit/output/server` of the counted build. */
			server_dir: string;
			/** Directories of static files, searched in order before the app answers. */
			static_dirs: string[];
			env: Record<string, string>;
	  }
	| { type: 'listen' }
	| { type: 'close' }
	| { type: 'count'; cases: CountedServerCase[]; origin: string; out: string };

export type ChildMessage =
	| { type: 'ready' }
	| { type: 'listening'; base: string }
	| { type: 'closed' }
	| { type: 'counted'; out: string }
	| { type: 'error'; message: string };

const CHILD = own_file('app/server-child');

export class CountedServer {
	#child: ChildProcess;
	#log = '';
	#waiting: Array<(m: ChildMessage) => void> = [];

	private constructor(child: ChildProcess) {
		this.#child = child;
		child.stdout?.on('data', (d) => (this.#log = (this.#log + d).slice(-8000)));
		child.stderr?.on('data', (d) => (this.#log = (this.#log + d).slice(-8000)));
		child.on('message', (m) => this.#waiting.shift()?.(m as ChildMessage));
		child.on('exit', (code) => {
			for (const w of this.#waiting.splice(0)) {
				w({ type: 'error', message: `server child exited (${code}):\n${this.#log}` });
			}
		});
	}

	static async start(o: {
		server_dir: string;
		static_dirs: string[];
		env?: Record<string, string>;
		cwd?: string;
	}): Promise<CountedServer> {
		const child = track(
			fork(CHILD, [], {
				cwd: o.cwd,
				execArgv: ['--no-warnings'],
				env: with_conditions({ ...process.env, NODE_ENV: 'production' }),
				stdio: ['ignore', 'pipe', 'pipe', 'ipc']
			})
		);
		const s = new CountedServer(child);
		await s.#ask({
			type: 'init',
			server_dir: o.server_dir,
			static_dirs: o.static_dirs,
			env: o.env ?? {}
		});
		return s;
	}

	get log(): string {
		return this.#log;
	}

	#ask(m: ParentMessage): Promise<ChildMessage> {
		return new Promise((resolve, reject) => {
			this.#waiting.push((r) => (r.type === 'error' ? reject(new Error(r.message)) : resolve(r)));
			this.#child.send(m);
		});
	}

	/** Serve the app over HTTP; resolves to its base URL. */
	async listen(): Promise<string> {
		const r = await this.#ask({ type: 'listen' });
		if (r.type !== 'listening') throw new Error(`heisenbench: unexpected ${r.type}`);
		return r.base;
	}

	async close_http(): Promise<void> {
		await this.#ask({ type: 'close' });
	}

	/** Count the cases (each: warm-up, then two measured runs) against `origin`. */
	async count(
		cases: CountedServerCase[],
		origin: string,
		tmp: string
	): Promise<{ results: ServerCaseResult[]; loaded: LoadedModules }> {
		const out = join(tmp, `server-count-${process.pid}-${Date.now()}.json`);
		await this.#ask({ type: 'count', cases, origin, out });
		try {
			return JSON.parse(readFileSync(out, 'utf8')) as {
				results: ServerCaseResult[];
				loaded: LoadedModules;
			};
		} finally {
			rmSync(out, { force: true });
		}
	}

	async stop(): Promise<void> {
		// A child killed by a signal has no exit code, only a signal code: it is gone all the same.
		if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
		await new Promise<void>((r) => {
			this.#child.once('exit', () => r());
			this.#child.kill('SIGTERM');
			setTimeout(() => this.#child.kill('SIGKILL'), 3000).unref();
		});
	}
}
