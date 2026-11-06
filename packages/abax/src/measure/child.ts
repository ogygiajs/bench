import { readFileSync, writeFileSync } from 'node:fs';
import { register_plain } from './plain.ts';
import { load_cases } from './cases.ts';
import { compare_time, time_case } from './time.ts';
import type { CompareOptions, TimeOptions } from './time.ts';
import { real_bytes } from './alloc.ts';
import type { BytesOptions } from './alloc.ts';
import { find_leaks } from './leak.ts';
import type { LeakOptions } from './leak.ts';
import { time_builtins } from '../calibrate/prices.ts';
import { watch_parent } from '../proc.ts';

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
			// every round after the first on fresh copies of both builds (see time.ts)
			let generation = 0;
			const load = async (side: 'base' | 'pr', round: number) => {
				if (round === 0) return side === 'base' ? base : pr;
				const i = side === 'base' ? 0 : 1;
				return load_cases(job.roots[i], job.files[i], job.filter, `t${++generation}`);
			};
			result = await compare_time(base, pr, { ...(o as CompareOptions), load });
			break;
		}
		case 'bytes':
			result = await each(job, (c) => real_bytes(c, job.roots[0], o as BytesOptions));
			break;
		case 'leaks':
			result = await each(job, (c) => find_leaks(c, job.roots[0], o as LeakOptions));
			break;
		case 'calibrate_prices': {
			const p = o as { keys: string[]; sizes?: number[]; time_ms?: number; warmup_ms?: number };
			result = await time_builtins(p.keys, p.sizes, p);
			break;
		}
		default:
			throw new Error(`abax: unknown measure job ${job.kind}`);
	}
	writeFileSync(job.out, JSON.stringify(result));
}

watch_parent();
await main();
// A timer or socket a bench module left open must not keep the child (and the run) alive.
process.exit(0);
