import { readFileSync, writeFileSync } from 'node:fs';
import { register_plain } from './plain.ts';
import { load_cases } from './cases.ts';
import { compare_time, time_case } from './time.ts';
import type { TimeOptions } from './time.ts';
import { real_bytes } from './alloc.ts';
import type { BytesOptions } from './alloc.ts';
import { find_leaks } from './leak.ts';
import type { LeakOptions } from './leak.ts';

/*
 * Entry of a measure child (see spawn.ts): `node [flags] child.ts job.json`. Loads the bench files
 * on the plain build and runs one layer. Errors per case are reported, not thrown.
 */

interface Job {
	kind: string;
	out: string;
	/** One root (single-side layers) or [base, pr] (time_ab). */
	roots: string[];
	/** Bench files per root, relative to it. */
	files: string[][];
	filter?: string | null;
	options?: Record<string, unknown>;
}

export interface CaseResult<T> {
	name: string;
	file: string;
	result: T | null;
	error: string | null;
}

function message(e: unknown): string {
	return e instanceof Error ? (e.stack ?? e.message) : String(e);
}

async function each<T>(
	job: Job,
	fn: (c: Awaited<ReturnType<typeof load_cases>>[number]) => Promise<T>
): Promise<Array<CaseResult<T>>> {
	const list = await load_cases(job.roots[0], job.files[0], job.filter);
	const out: Array<CaseResult<T>> = [];
	for (const c of list) {
		try {
			out.push({ name: c.name, file: c.file, result: await fn(c), error: null });
		} catch (e) {
			out.push({ name: c.name, file: c.file, result: null, error: message(e) });
		}
	}
	return out;
}

async function main(): Promise<void> {
	const job = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Job;
	register_plain({ roots: job.roots });
	const o = job.options ?? {};
	let result: unknown;
	switch (job.kind) {
		case 'time':
			result = await each(job, (c) => time_case(c, o as TimeOptions));
			break;
		case 'time_ab': {
			const base = await load_cases(job.roots[0], job.files[0], job.filter);
			const pr = await load_cases(job.roots[1], job.files[1], job.filter);
			result = await compare_time(base, pr, o as TimeOptions & { repeats?: number });
			break;
		}
		case 'bytes':
			result = await each(job, (c) => real_bytes(c, job.roots[0], o as BytesOptions));
			break;
		case 'leaks':
			result = await each(job, (c) => find_leaks(c, job.roots[0], o as LeakOptions));
			break;
		default:
			throw new Error(`abax: unknown measure job ${job.kind}`);
	}
	writeFileSync(job.out, JSON.stringify(result));
}

await main();
