import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cases, set_current_file } from '../bench.ts';
import type { BenchCase } from '../bench.ts';
import { GENERATION } from '../loader/core.ts';

/**
 * Import bench files of one root (with whatever loader is registered) and return their cases.
 * `generation`: a fresh copy of the files and of what they import (the loader passes the query on,
 * see plain.ts), with its own module state and its own compiled code.
 */
export async function load_cases(
	root: string,
	files: readonly string[],
	filter?: string | null,
	generation?: string
): Promise<BenchCase[]> {
	const start = cases().length;
	for (const f of files) {
		const abs = resolve(root, f);
		set_current_file(relative(root, abs).split(sep).join('/'));
		const query = generation ? `?${GENERATION}${generation}` : '';
		await import(pathToFileURL(abs).href + query);
	}
	const list = cases().slice(start);
	return filter ? list.filter((c) => c.name.includes(filter)) : list;
}

/** Run a case once outside any measuring window: setup, call, teardown. */
export async function call_case(c: BenchCase): Promise<void> {
	const ctx = c.setup ? await c.setup() : undefined;
	await c.fn(ctx);
	if (c.teardown) await c.teardown(ctx);
}

/** Whether calling the case returns a promise (decides how tinybench times it). */
export async function is_async_case(c: BenchCase): Promise<boolean> {
	const ctx = c.setup ? await c.setup() : undefined;
	const r = c.fn(ctx);
	const async = r != null && typeof (r as { then?: unknown }).then === 'function';
	if (async) await r;
	if (c.teardown) await c.teardown(ctx);
	return async;
}
