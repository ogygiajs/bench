import '../warnings.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cases, set_current_file } from '../bench.ts';
import { run_growth } from '../growth/index.ts';
import { register_heisenbench } from '../loader/register.ts';
import { watch_parent } from '../proc.ts';
import { one_line } from '../report.ts';

/*
 * Entry of a receipt child (receipt/count.ts): `node --import preload.ts child.ts job.json`.
 *
 *   list    the cases the bench files define (imported once, nothing counted)
 *   growth  one case grown over the sizes, alone in this process
 *
 * Counting a case is blame's recount child (blame/child.ts), one case per process too.
 */

interface Job {
	kind: 'list' | 'growth';
	root: string;
	/** Bench files, relative to the root. */
	files: string[];
	cases?: string[];
	sizes?: number[];
	out: string;
}

watch_parent();
const job = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Job;
process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

if (job.kind === 'list') {
	// the counting loader, as a count has it: it compiles `.svelte` and loads what Node alone cannot
	register_heisenbench({ root: job.root, deps: true });
	const list: Array<{ name: string; file: string; scaled: boolean }> = [];
	const errors: Array<{ file: string; error: string }> = [];
	for (const file of job.files) {
		set_current_file(file);
		const start = cases().length;
		try {
			await import(pathToFileURL(join(job.root, file)).href);
		} catch (e) {
			errors.push({ file, error: one_line(e) });
			continue;
		}
		for (const c of cases().slice(start))
			list.push({ name: c.name, file, scaled: c.scale !== undefined });
	}
	writeFileSync(job.out, JSON.stringify({ cases: list, errors }));
} else {
	const report = await run_growth({
		files: job.files.map((f) => join(job.root, f)),
		root: job.root,
		names: job.cases,
		sizes: job.sizes,
		scaled: true,
		deps: true
	});
	writeFileSync(job.out, JSON.stringify(report));
}
process.exit(0);
