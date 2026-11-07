import '../warnings.ts';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run_benches } from '../runner.ts';
import { watch_parent } from '../proc.ts';
import type { LoaderConfig } from '../loader/register.ts';
import { GROWTH_SCHEMA, grow_case } from '../growth/index.ts';
import type { GrowthReport } from '../growth/index.ts';
import { Measurer, load_cases } from '../growth/measure.ts';
import { run_recorded_growth } from '../growth/recorded.ts';
import { alias_records, read_record_dir } from '../coverage/replay-run.ts';
import { install_twin } from '../mutation/twin.ts';
import { get_runtime } from '../runtime/index.ts';

/*
 * Entry of a recount child (blame/index.ts, mutation/index.ts): `node child.ts job.json`. Counts
 * the named cases of the bench files on one candidate tree with the runner every `heisenbench run`
 * uses, and writes the report. A file that does not load or a case that throws is in the report, as
 * in any run.
 *
 * The mutation layer also asks for: the twin check (`twin`: every value a hooked function hands to
 * the twin hook is fingerprinted, mutation/twin.ts, and written next to the report), growth of the
 * named cases (`growth`: the growth report, as `heisenbench growth` counts it), or growth from
 * recorded calls of some modules (`recorded`: as `heisenbench growth --recorded` does).
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
	/** Write the twin records here (null: the hook only passes values through). */
	twin?: string | null;
	/** Grow the named cases at these sizes instead of counting them once. */
	growth?: { sizes: number[]; cap: number } | null;
	/** Grow the recorded calls of these modules instead. */
	recorded?: { dir: string; alias: string | null; modules: string[]; cap: number } | null;
	/** List the cases of the bench files (and which declare `scale`) instead; nothing is counted. */
	list?: boolean;
	/** Steps one run of a counted case may take (a mutant that runs away stops there and fails). */
	cap?: number | null;
}

watch_parent();
const job = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Job;
// What a bench file started and never awaited is the case's problem, not the recount's.
process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});
// A hooked tree calls the hook whatever is asked; the lane's own path never reaches a fingerprint.
const roots = [...new Set([job.root, realpathSync(job.root), pathToFileURL(job.root).href])].sort(
	(a, b) => b.length - a.length
);
const twin = install_twin(roots, typeof job.twin === 'string');

if (job.list) {
	const loaded = await load_cases({
		files: job.files.map((f) => join(job.root, f)),
		root: job.root,
		deps: job.deps
	});
	writeFileSync(
		job.out,
		JSON.stringify(
			loaded.map((c) => ({ name: c.name, file: c.file, scale: c.scale !== undefined }))
		)
	);
} else if (job.growth) {
	const loaded = await load_cases({
		files: job.files.map((f) => join(job.root, f)),
		root: job.root,
		deps: job.deps
	});
	const wanted = new Set(job.cases);
	const m = new Measurer(job.root);
	const report: GrowthReport = { schema: GROWTH_SCHEMA, sizes: job.growth.sizes, cases: [] };
	for (const c of loaded) {
		if (!wanted.has(c.name)) continue;
		report.cases.push(await grow_case(c, m, job.growth.sizes, job.growth.cap));
	}
	writeFileSync(job.out, JSON.stringify(report));
} else if (job.recorded) {
	let records = read_record_dir(job.recorded.dir);
	if (job.recorded.alias)
		records = alias_records(
			records,
			JSON.parse(readFileSync(job.recorded.alias, 'utf8')) as Record<string, string>
		);
	const report = await run_recorded_growth({
		root: job.root,
		deps: job.deps,
		records,
		modules: new Set(job.recorded.modules),
		cap: job.recorded.cap
	});
	writeFileSync(job.out, JSON.stringify(report));
} else {
	if (job.cap) get_runtime().cap = job.cap;
	const report = await run_benches({
		files: job.files.map((f) => join(job.root, f)),
		root: job.root,
		// no names: every case of the files (the mutation layer's own base count)
		names: job.cases.length > 0 ? job.cases : undefined,
		sha: job.sha,
		deps: job.deps
	});
	report.git.prefix = job.prefix;
	writeFileSync(job.out, JSON.stringify(report));
	if (typeof job.twin === 'string') writeFileSync(job.twin, JSON.stringify(twin()));
}
process.exit(0);
