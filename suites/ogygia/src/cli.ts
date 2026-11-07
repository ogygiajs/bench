#!/usr/bin/env node
/**
 * Heisenbench on ogygia: count the bench files of an ogygia commit, against its base for a PR.
 *
 *   node suites/ogygia/src/cli.ts --sha <pr head> --base <pr base> [--pr <n>]    a PR
 *   node suites/ogygia/src/cli.ts --sha <commit> [--kind main]                   a full run
 *
 * Options: --repo <url or path> (default the ogygia repository), --work <dir> (clones and trees,
 * default .work), --out <dir> (default out), --run-url <url> (linked from the comment),
 * --measure <layers> (the plain-build layers every `heisenbench run` adds: `time,bytes,leaks`, `all` or
 * `none`; default none for a PR, all for a full run), --time on|off (a PR's time layer, default on),
 * --weights <app-weights.json> (a PR: rank the changed functions by main's real-app weights; a
 * missing file is said in one line), --search-budget <seconds> (a PR's worst-case search over the
 * changed cases that declare an input, both sides; default 240, 0 turns it off).
 *
 * A PR: both commits are checked out and installed, the PR is measured against the merge base of
 * the two, and only the bench files whose import graph reaches a changed file run: counted, health
 * checked and grown on both trees, then timed with both trees in one process, taking turns. Real
 * bytes and leaks cost about 15 s a case a side, so a PR leaves them to the main and nightly runs
 * unless --measure asks. A full run (no --base): every bench file of the one commit, with every
 * plain-build layer. Writes to --out:
 *
 *   section.md    the `heisenbench` section of the PR comment (a full run: a summary of every case)
 *   result.json   meta, selection, both reports, the diff and the time comparison (the results
 *                 branch keeps this)
 *   head/, base/  the per-file reports and Heisenbench's log; time/ the time comparison (the artifact)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { diffReports, diffSections, gitDiff } from '@bench/heisenbench';
import {
	changed_files,
	clone,
	merge_base as find_merge_base,
	prepare_tree,
	rev_parse
} from './checkout.ts';
import { import_graphs } from './graph.ts';
import { HEISENBENCH_DIR, empty_report, run_time, run_tree } from './run.ts';
import { RESULT_SCHEMA, render_full_summary, render_pr_section } from './section.ts';
import type { Meta, Result } from './section.ts';
import { SEARCH_BUDGET_MS, cases_with_inputs, pick_cases, run_searches } from './search.ts';
import { select_all, select_changed } from './select.ts';
import { rank_by_weights } from './weights.ts';

const { values } = parseArgs({
	options: {
		sha: { type: 'string' },
		base: { type: 'string' },
		pr: { type: 'string' },
		kind: { type: 'string' },
		repo: { type: 'string', default: 'https://github.com/ogygiajs/ogygia.git' },
		work: { type: 'string', default: '.work' },
		out: { type: 'string', default: 'out' },
		'run-url': { type: 'string' },
		measure: { type: 'string' },
		time: { type: 'string', default: 'on' },
		weights: { type: 'string' },
		'search-budget': { type: 'string', default: String(SEARCH_BUDGET_MS / 1000) }
	}
});

const LAYERS = /^(all|none|(time|bytes|leaks)(,(time|bytes|leaks))*)$/;

const SHA = /^[0-9a-f]{7,40}$/;
const log = (line: string): void => console.log(`[heisenbench] ${line}`);

function bench_repo_sha(): string | null {
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: HEISENBENCH_DIR, encoding: 'utf8' }).trim();
	} catch {
		return null;
	}
}

async function main(): Promise<void> {
	if (!values.sha || !SHA.test(values.sha)) throw new Error('--sha <commit> is required');
	if (values.base !== undefined && !SHA.test(values.base)) throw new Error('bad --base');
	const pr = values.pr ? Number(values.pr) : null;
	if (pr !== null && !(Number.isInteger(pr) && pr > 0)) throw new Error('bad --pr');
	const work = resolve(values.work);
	const out = resolve(values.out);
	mkdirSync(out, { recursive: true });

	const repo = clone(values.repo, work, [values.sha, ...(values.base ? [values.base] : [])]);
	const sha = rev_parse(repo, values.sha);
	const base = values.base ? rev_parse(repo, values.base) : null;
	const mb = base ? find_merge_base(repo, sha, base) : null;
	const kind = (values.kind ?? (base ? 'pr' : 'main')) as Meta['kind'];
	const layers = values.measure ?? (mb ? 'none' : 'all');
	if (!LAYERS.test(layers)) throw new Error('--measure takes time,bytes,leaks, all or none');
	const measure = layers === 'none' ? null : layers;
	const search_s = Number(values['search-budget']);
	if (!(Number.isFinite(search_s) && search_s >= 0)) throw new Error('bad --search-budget');
	const search_ms = Math.round(search_s * 1000);
	const meta: Meta = {
		kind,
		pr,
		sha,
		base,
		merge_base: mb,
		heisenbench: bench_repo_sha(),
		node: process.version,
		run_url: values['run-url'] ?? null,
		measure
	};

	const head = prepare_tree(repo, work, sha, HEISENBENCH_DIR, log);
	let selection;
	if (mb) {
		const changed = changed_files(repo, mb, sha);
		const graphs = import_graphs(head.dir, head.benches);
		selection = select_changed(graphs, changed);
		log(
			`${changed.length} changed files; ${selection.selected.length} of ${head.benches.length} bench files reach them`
		);
	} else {
		selection = select_all(head.benches, 'a full run');
	}

	const result: Result = {
		schema: RESULT_SCHEMA,
		meta,
		selection,
		head: null,
		base: null,
		diff: null,
		load_errors: { head: [], base: [] },
		time: null
	};

	if (selection.selected.length > 0) {
		// Both trees side by side, each on half the cores (one at a time when measuring time). Engine
		// health checks that V8 does the same thing twice everywhere, PRs included: only that check
		// can mark a function unstable, and an unstable one is never a finding in the comment.
		const base_tree = mb ? prepare_tree(repo, work, mb, HEISENBENCH_DIR, log) : null;
		const present = new Set(base_tree?.benches ?? []);
		const base_files = selection.selected.filter((f) => present.has(f));
		const timed = measure !== null && (measure === 'all' || measure.split(',').includes('time'));
		const jobs = Math.max(1, Math.floor(availableParallelism() / (base_tree ? 2 : 1)));
		const tree_o = { jobs, check: true };
		const run_head = () =>
			run_tree(head, selection.selected, join(out, 'head'), log, measure, undefined, tree_o);
		const run_base = () =>
			base_tree
				? run_tree(base_tree, base_files, join(out, 'base'), log, measure, undefined, tree_o)
				: Promise.resolve(null);
		const [head_run, base_run] = timed
			? [await run_head(), await run_base()]
			: await Promise.all([run_head(), run_base()]);
		result.head = head_run.report;
		result.load_errors.head = head_run.load_errors;
		if (mb && base_tree && base_run) {
			result.load_errors.base = base_run.load_errors;
			result.base = base_run.report;
			if (result.head) {
				const base_report = result.base ?? empty_report(mb, result.head);
				result.base = base_report;
				const files = gitDiff(repo, mb, sha);
				result.diff = {
					...diffReports(base_report, result.head, { files }),
					...diffSections(base_report, result.head, files)
				};
			}
			if (values.time !== 'off') {
				result.time = await run_time(head, base_tree, base_files, join(out, 'time'), log);
			}
			if (result.diff && result.head && values.weights !== undefined) {
				result.weights = rank_by_weights(resolve(values.weights), result.diff, result.head);
				log(
					`real-app weight: ${result.weights.status}${result.weights.note ? ` (${result.weights.note})` : ''}`
				);
			}
			if (result.diff && result.head && search_ms > 0) {
				const pick = pick_cases(result.diff, result.head, (file) =>
					cases_with_inputs(file, readFileSync(join(head.dir, file), 'utf8'))
				);
				const base_cases = new Set(result.base?.cases.map((c) => c.name) ?? []);
				result.search = await run_searches(
					head,
					base_tree,
					pick,
					join(out, 'search'),
					log,
					search_ms,
					base_cases
				);
			}
		}
	}

	const md = mb ? render_pr_section(result) : render_full_summary(result);
	writeFileSync(join(out, 'section.md'), md);
	writeFileSync(join(out, 'result.json'), JSON.stringify(result) + '\n');
	console.log(md);
}

await main();
