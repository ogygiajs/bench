import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run_process } from '../proc.ts';
import { own_file } from '../own.ts';
import type { ProcessError } from '../proc.ts';

/**
 * A layer child's time limit: under the 15 minutes the ogygia suite gives one command on one
 * file, so a stuck child is reported as this layer's failure instead of costing the whole file.
 */
const CHILD_LIMIT_MS = 12 * 60_000;

/*
 * The plain-build layers run in a child process each: the counting loader is registered process
 * wide in the parent, and each layer needs its own engine flags (--expose-gc for leaks, no
 * inlining for real bytes). A job goes in as a JSON file; the result comes back as one.
 */

const CHILD = own_file('measure/child');

/** Engine flags per job kind. */
const FLAGS: Record<string, string[]> = {
	time: [],
	time_ab: [],
	audit_time: [],
	// Inlining moves a callee's allocations into its caller's frame in the heap profile; without it
	// every sampled allocation is charged to the function that made it (escape analysis inside one
	// function still runs, which is what the elision check looks for). Optimized code compiles on
	// the main thread, where the warm-up triggers it: compiled on a helper thread, it could come
	// in after the warm-up on a busy machine, and the measured calls ran unoptimized (an escaping
	// object read as 450 B a call instead of 0, beside 48 busy processes on 16 cores).
	bytes: [
		'--expose-gc',
		'--no-turbo-inlining',
		'--no-maglev-inlining',
		'--no-concurrent-recompilation'
	],
	leaks: ['--expose-gc'],
	calibrate_prices: [],
	calibrate_time: []
};

export async function run_child<T>(
	job: { kind: string } & Record<string, unknown>,
	opts: { cwd?: string; timeout_ms?: number } = {}
): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), 'heisenbench-job-'));
	const job_file = join(dir, 'job.json');
	const out = join(dir, 'out.json');
	writeFileSync(job_file, JSON.stringify({ ...job, out }));
	try {
		try {
			await run_process(
				process.execPath,
				['--no-warnings', ...(FLAGS[job.kind] ?? []), CHILD, job_file],
				{ cwd: opts.cwd ?? process.cwd(), timeout_ms: opts.timeout_ms ?? CHILD_LIMIT_MS }
			);
		} catch (e) {
			const err = e as ProcessError;
			const tail = (err.stderr ?? '').trim().split('\n').slice(-6).join('\n');
			throw new Error(
				`heisenbench: the ${job.kind} child ${err.message}${tail ? `: ${tail}` : ''}`
			);
		}
		return JSON.parse(readFileSync(out, 'utf8')) as T;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
