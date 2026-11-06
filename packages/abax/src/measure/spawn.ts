import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * The plain-build layers run in a child process each: the counting loader is registered process
 * wide in the parent, and each layer needs its own engine flags (--expose-gc for leaks, no
 * inlining for real bytes). A job goes in as a JSON file; the result comes back as one.
 */

const CHILD = fileURLToPath(new URL('./child.ts', import.meta.url));

/** Engine flags per job kind. */
const FLAGS: Record<string, string[]> = {
	time: [],
	time_ab: [],
	// Inlining moves a callee's allocations into its caller's frame in the heap profile; without it
	// every sampled allocation is charged to the function that made it (escape analysis inside one
	// function still runs, which is what the elision check looks for).
	bytes: ['--expose-gc', '--no-turbo-inlining', '--no-maglev-inlining'],
	leaks: ['--expose-gc'],
	calibrate_prices: [],
	calibrate_time: []
};

export async function run_child<T>(
	job: { kind: string } & Record<string, unknown>,
	opts: { cwd?: string; timeout_ms?: number } = {}
): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), 'abax-job-'));
	const job_file = join(dir, 'job.json');
	const out = join(dir, 'out.json');
	writeFileSync(job_file, JSON.stringify({ ...job, out }));
	try {
		await new Promise<void>((resolve, reject) => {
			execFile(
				process.execPath,
				['--no-warnings', ...(FLAGS[job.kind] ?? []), CHILD, job_file],
				{
					cwd: opts.cwd ?? process.cwd(),
					timeout: opts.timeout_ms ?? 30 * 60_000,
					maxBuffer: 64 * 1024 * 1024
				},
				(err, _stdout, stderr) => {
					if (err) reject(new Error(`abax: ${job.kind} child failed: ${stderr || err.message}`));
					else resolve();
				}
			);
		});
		return JSON.parse(readFileSync(out, 'utf8')) as T;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
