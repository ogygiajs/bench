import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cases, set_current_file } from './bench.ts';
import type { BenchCase } from './bench.ts';
import { GENERATION } from './loader/core.ts';

/*
 * Fresh module state per measured run (spec 3). Every run of a case gets its own copy of the
 * bench file and of everything it imports: the file is imported again as `lib.bench.ts?abax_gen=N`
 * and the loader passes the same query to each file that copy imports (LoaderCore.with_generation),
 * so caches, counters and singletons held in module scope start empty on every run. Without it a
 * memo filled by the warm-up run makes the measured runs take the warm path, and a module counter
 * makes two identical runs differ ("unstable").
 *
 * Why a cache-busting import and not a fresh vm context or worker per run: the copies run in the
 * same isolate and realm, so the priced built-in wrappers, the deterministic clock and the shadow
 * stack are the very same objects; and every copy of a file reports into the same counters (the
 * counter module is keyed by file, not URL), so the counts of the three runs line up block for
 * block and stay exact. A worker would need the counters shipped back and every module transformed
 * again per run; a vm context has its own built-ins, which the wrappers would have to patch per run.
 *
 * Cost: ES modules are never unloaded, so each copy stays in memory until the process ends (three
 * copies of a case's module graph per case). CommonJS dependencies are cached by file name and stay
 * shared. `fresh: false` (`abax run --state shared`) runs every case on one copy instead.
 */

let generation = 0;

export function next_generation(): number {
	return ++generation;
}

/** Each case's position among the cases its bench file defines (from one import of the files). */
export function positions(list: readonly BenchCase[]): Map<BenchCase, number> {
	const seen = new Map<string, number>();
	const out = new Map<BenchCase, number>();
	for (const c of list) {
		const n = seen.get(c.file) ?? 0;
		out.set(c, n);
		seen.set(c.file, n + 1);
	}
	return out;
}

/**
 * A copy of the case from a fresh import of its bench file: the case at the same `position` among
 * the cases the file defines.
 */
export async function fresh_copy(c: BenchCase, root: string, position: number): Promise<BenchCase> {
	if (!c.file) return c;
	const all = cases();
	const start = all.length;
	set_current_file(c.file);
	await import(`${pathToFileURL(resolve(root, c.file)).href}?${GENERATION}${next_generation()}`);
	const added = all.slice(start);
	// The copies are not cases of the run: keep the list as the runner built it.
	all.length = start;
	const copy = added.filter((x) => x.file === c.file)[position];
	if (!copy || copy.name !== c.name)
		throw new Error(`abax: ${c.name} not found again in ${c.file}`);
	return copy;
}
