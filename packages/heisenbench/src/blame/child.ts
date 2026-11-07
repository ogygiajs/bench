import '../warnings.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run_benches } from '../runner.ts';
import { watch_parent } from '../proc.ts';
import type { LoaderConfig } from '../loader/register.ts';

/*
 * Entry of a recount child (blame/index.ts): `node child.ts job.json`. Counts the named cases of
 * the bench files on one candidate tree with the runner every `heisenbench run` uses, and writes
 * the report. A file that does not load or a case that throws is in the report, as in any run.
 */

interface Job {
	root: string;
	/** Bench files, relative to the root. */
	files: string[];
	cases: string[];
	sha: string | null;
	/** The root's place in its repository (the scratch copy is in none). */
	prefix: string;
	deps: LoaderConfig['deps'];
	out: string;
}

watch_parent();
const job = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Job;
// What a bench file started and never awaited is the case's problem, not the recount's.
process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});
const report = await run_benches({
	files: job.files.map((f) => join(job.root, f)),
	root: job.root,
	names: job.cases,
	sha: job.sha,
	deps: job.deps
});
report.git.prefix = job.prefix;
writeFileSync(job.out, JSON.stringify(report));
process.exit(0);
