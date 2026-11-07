#!/usr/bin/env node
/**
 * The runs `heisenbench history` reads: each first-parent commit of main, counted with one set of
 * bench files, so a line's steps at two commits differ only by what the code did.
 *
 *   node suites/ogygia/src/history.ts --repo <url or clone> [--to <rev>] [--max 20]
 *       [--bench <rev>] [--work dir] [--cache dir] [--out dir] [--history <results dir>]
 *
 * The newest `--max` first-parent commits up to `--to` (default: the clone's main) are counted with
 * the bench files of `--bench` (default `--to`) laid over each tree, as correlate.ts does: one fixed
 * set of cases with one input each, so a case that a later PR added (#187's flag inventory) counts
 * the old code too. A case whose code did not exist yet fails to load on that commit and is left
 * out there. Only `heisenbench run` runs (steps per line is all a history needs), with `--cache`:
 * a case whose code and inputs did not change from one commit to the next is reused, not counted.
 *
 * Each commit writes `<out>/<sha>.json`: `{ meta: { kind: 'history', sha, heisenbench, node,
 * bench }, head: <report> }`, the shape of a results-branch run, so `heisenbench history --reports`
 * reads the results branch and these together. A commit is skipped when `<out>` already holds it
 * from the same Heisenbench commit and bench files, or when `--history` (the results branch) holds
 * a run of it from the same Heisenbench commit.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { clone, prepare_tree, remove_tree, rev_parse } from './checkout.ts';
import { bench_packages, overlay } from './correlate.ts';
import { HEISENBENCH_DIR, run_tree } from './run.ts';
import { read_result, stored_runs } from './trend.ts';

export interface HistoryMeta {
	kind: 'history';
	sha: string;
	/** The bench repository commit (the Heisenbench that counted). */
	heisenbench: string | null;
	node: string;
	/** The commit whose bench files counted it. */
	bench: string;
	/** How many cases were reused from the cache, and counted. */
	reused: number;
	counted: number;
	ms: number;
}

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
}

function bench_repo_sha(): string | null {
	try {
		return git(HEISENBENCH_DIR, ['rev-parse', 'HEAD']);
	} catch {
		return null;
	}
}

/** The newest `max` first-parent commits up to `to`, oldest first. */
export function history_commits(repo: string, to: string, max: number): string[] {
	if (max <= 0) return [];
	return git(repo, ['rev-list', '--first-parent', `--max-count=${max}`, to])
		.split('\n')
		.filter(Boolean)
		.reverse();
}

/** Whether a run file already holds this commit, counted by `counter` with the bench files of `bench`. */
export function done_before(path: string, counter: string | null, bench: string): boolean {
	if (!existsSync(path)) return false;
	const r = JSON.parse(readFileSync(path, 'utf8')) as { meta?: Partial<HistoryMeta> };
	return r.meta?.heisenbench === counter && r.meta?.bench === bench;
}

export interface BackfillOptions {
	repo: string;
	to?: string;
	max?: number;
	bench?: string;
	work: string;
	cache: string | null;
	out: string;
	history?: string | null;
	log?: (line: string) => void;
}

export interface BackfillSummary {
	commits: number;
	counted: number;
	skipped: number;
	reused: number;
	cases_counted: number;
	ms: number;
}

export async function backfill(o: BackfillOptions): Promise<BackfillSummary> {
	const t0 = performance.now();
	const log = o.log ?? (() => {});
	const repo = clone(o.repo, o.work, []);
	const to = rev_parse(repo, o.to ?? 'main');
	const bench = rev_parse(repo, o.bench ?? to);
	const packages = bench_packages(repo, bench);
	const commits = history_commits(repo, to, o.max ?? 20);
	const counter = bench_repo_sha();
	const stored = o.history ? stored_runs(o.history) : new Set<string>();
	mkdirSync(o.out, { recursive: true });
	const summary: BackfillSummary = {
		commits: commits.length,
		counted: 0,
		skipped: 0,
		reused: 0,
		cases_counted: 0,
		ms: 0
	};
	log(
		`history: ${commits.length} commits up to ${to.slice(0, 12)}, bench files of ${bench.slice(0, 12)}`
	);
	for (const sha of commits) {
		const id = sha.slice(0, 12);
		const path = join(o.out, `${sha}.json`);
		if (done_before(path, counter, bench)) {
			log(`${id} done before`);
			summary.skipped++;
			continue;
		}
		if (o.history && stored.has(sha) && read_result(o.history, sha).meta.heisenbench === counter) {
			log(`${id} on the results branch, counted by this Heisenbench`);
			summary.skipped++;
			continue;
		}
		const c0 = performance.now();
		const tree = overlay(
			repo,
			bench,
			prepare_tree(repo, o.work, sha, HEISENBENCH_DIR, log),
			packages
		);
		const run = await run_tree(
			tree,
			tree.benches,
			join(o.work, 'history', id),
			log,
			null,
			['run'],
			{ cache: o.cache ? { dir: o.cache, verify: 0 } : null }
		);
		remove_tree(o.work, sha);
		if (!run.report) {
			log(`${id}: no bench file loaded`);
			continue;
		}
		const reused = run.report.cache?.reused ?? 0;
		const counted = run.report.cache?.counted ?? run.report.cases.length;
		const meta: HistoryMeta = {
			kind: 'history',
			sha,
			heisenbench: counter,
			node: process.version,
			bench,
			reused,
			counted,
			ms: Math.round(performance.now() - c0)
		};
		writeFileSync(path, JSON.stringify({ meta, head: run.report }) + '\n');
		summary.counted++;
		summary.reused += reused;
		summary.cases_counted += counted;
		log(
			`${id}: ${run.report.cases.length} cases (${reused} reused, ${counted} counted), ${run.load_errors.length} bench file(s) did not load, ${Math.round(meta.ms / 1000)} s`
		);
	}
	summary.ms = Math.round(performance.now() - t0);
	return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const { values } = parseArgs({
		options: {
			repo: { type: 'string', default: 'https://github.com/ogygiajs/ogygia.git' },
			to: { type: 'string' },
			max: { type: 'string', default: '20' },
			bench: { type: 'string' },
			work: { type: 'string', default: '.work' },
			cache: { type: 'string' },
			out: { type: 'string', default: 'out/history' },
			history: { type: 'string' }
		}
	});
	const max = Number(values.max);
	if (!Number.isInteger(max) || max < 0) throw new Error('--max takes a whole number of commits');
	const s = await backfill({
		repo: values.repo,
		to: values.to,
		max,
		bench: values.bench,
		work: resolve(values.work),
		cache: values.cache ? resolve(values.cache) : null,
		out: resolve(values.out),
		history: values.history ? resolve(values.history) : null,
		log: (l) => console.log(`[history] ${l}`)
	});
	console.log(
		`[history] ${s.counted} commits counted, ${s.skipped} skipped; ${s.reused} cases reused, ${s.cases_counted} counted; ${Math.round(s.ms / 1000)} s`
	);
}
