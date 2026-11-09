/**
 * Slow creep across main: each case's steps over the earlier full runs of main (the results
 * branch's `heisenbench/main/<sha>.json`), in ogygia's first-parent order, with this run as the
 * newest point, through Heisenbench's change-point model (@bench/heisenbench/trend). Report-only: it
 * adds lines to the full run's summary and never changes a count or a verdict.
 *
 * The history is a checkout or a partial clone of the results branch (`--history <dir>`): a git
 * directory is read with `git show` (a blobless clone fetches only the runs it reads), any other
 * directory as files under `heisenbench/main/`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SHARDS_DIR, SHARD_NAME, load_result, load_result_file } from '@bench/compare';
import type { ShardReader } from '@bench/compare';
import { detect_trend } from '@bench/heisenbench/trend';
import type { TrendCreep, TrendOptions } from '@bench/heisenbench/trend';

/** First-parent commits looked back over, and full runs of main read at most. */
export const TREND_LOOKBACK = 500;
export const TREND_RUNS = 60;

/** What one full run of main says about each case: its steps, or null when it failed. */
export interface RunPoint {
	sha: string;
	/** The counter: the Heisenbench commit and the Node that counted. */
	counter: string;
	cases: Record<string, number | null>;
}

export interface TrendCaseCreep extends TrendCreep {
	case: string;
}

/** The commits where some cases moved 2% or more at once: steps, which each PR's comment shows. */
export interface TrendStepCommit {
	sha: string;
	cases: number;
	up: number;
	down: number;
	/** The counter changed at this commit too. */
	counter_changed: boolean;
}

export interface TrendRun {
	/** The full runs of main the model saw, oldest first. */
	runs: string[];
	/** Cases with at least two counted points. */
	cases: number;
	creeps: TrendCaseCreep[];
	steps: TrendStepCommit[];
	/** Why nothing was looked at (no history, a single run), or null. */
	note: string | null;
	error: string | null;
	ms: number;
}

export interface ResultLike {
	meta: { sha: string; heisenbench: string | null; node: string };
	head: {
		node?: string;
		cases: Array<{ name: string; error: string | null; totals: { steps: number } }>;
	} | null;
}

/** The point a result.json gives (null: it counted nothing). */
export function point_of(r: ResultLike): RunPoint | null {
	if (!r.head) return null;
	const cases: Record<string, number | null> = {};
	for (const c of r.head.cases) cases[c.name] = c.error ? null : c.totals.steps;
	return {
		sha: r.meta.sha,
		counter: `${r.meta.heisenbench ?? '?'} ${r.head.node ?? r.meta.node}`,
		cases
	};
}

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		maxBuffer: 1 << 30,
		stdio: ['ignore', 'pipe', 'ignore']
	});
}

/** The first-parent commits up to `sha`, oldest first. */
export function main_order(repo: string, sha: string, max = TREND_LOOKBACK): string[] {
	return git(repo, ['rev-list', '--first-parent', `--max-count=${max}`, sha])
		.trim()
		.split('\n')
		.filter(Boolean)
		.reverse();
}

/** The full runs of main the history holds, by sha. */
export function stored_runs(history: string): Set<string> {
	const dir = join(history, 'heisenbench', 'main');
	const names = existsSync(join(history, '.git'))
		? git(history, ['ls-tree', '--name-only', 'HEAD', 'heisenbench/main/'])
				.split('\n')
				.map((f) => f.replace(/^heisenbench\/main\//, ''))
		: existsSync(dir)
			? readdirSync(dir)
			: [];
	const shas = new Set<string>();
	for (const n of names) {
		const m = /^([0-9a-f]{40})\.json$/.exec(n);
		if (m) shas.add(m[1]);
	}
	return shas;
}

/** A full run of main the history holds, as its result.json says it. */
export function read_result(history: string, sha: string): ResultLike {
	const path = `heisenbench/main/${sha}.json`;
	if (!existsSync(join(history, '.git')))
		return load_result_file(join(history, path)) as unknown as ResultLike;
	// a blobless clone: only the blobs read here are fetched
	const read: ShardReader = (name, max) => {
		if (!SHARD_NAME.test(name)) throw new Error(`not a shard name: ${name}`);
		const bytes = execFileSync('git', ['show', `HEAD:heisenbench/${SHARDS_DIR}/${name}`], {
			cwd: history,
			maxBuffer: max + 1,
			stdio: ['ignore', 'pipe', 'ignore']
		});
		return bytes;
	};
	return load_result(git(history, ['show', `HEAD:${path}`]), read) as unknown as ResultLike;
}

/** Each case's series over the runs (oldest first) through the model. Pure. */
export function trend_of(points: RunPoint[], opts: Partial<TrendOptions> = {}): TrendRun {
	const t0 = performance.now();
	const names = new Set<string>();
	for (const p of points) for (const n of Object.keys(p.cases)) names.add(n);
	const creeps: TrendCaseCreep[] = [];
	const by_commit = new Map<string, TrendStepCommit>();
	let cases = 0;
	for (const name of [...names].sort()) {
		const series = points.map((p) => ({
			sha: p.sha,
			steps: p.cases[name] ?? null,
			counter: p.counter
		}));
		const r = detect_trend(series, opts);
		if (r.points < 2) continue;
		cases++;
		for (const c of r.creeps) creeps.push({ case: name, ...c });
		for (const s of r.steps) {
			const e = by_commit.get(s.sha) ?? {
				sha: s.sha,
				cases: 0,
				up: 0,
				down: 0,
				counter_changed: s.counter_changed
			};
			e.cases++;
			if (s.ratio > 0) e.up++;
			else e.down++;
			by_commit.set(s.sha, e);
		}
	}
	// still rising first, then the biggest rise; ties by case name (the sort above)
	const rank = { rising: 0, held: 1, reverted: 2 } as const;
	creeps.sort((a, b) => rank[a.status] - rank[b.status] || b.ratio - a.ratio);
	const order = new Map(points.map((p, i) => [p.sha, i]));
	const steps = [...by_commit.values()].sort((a, b) => order.get(a.sha)! - order.get(b.sha)!);
	return {
		runs: points.map((p) => p.sha),
		cases,
		creeps,
		steps,
		note: points.length < 2 ? 'one full run of main so far, nothing to compare' : null,
		error: null,
		ms: Math.round(performance.now() - t0)
	};
}

export interface TrendInput {
	/** The ogygia clone (for the commit order). */
	repo: string;
	/** The results branch: a git directory or a checkout; null when the run was not given one. */
	history: string | null;
	/** This run's result: the newest point. */
	result: ResultLike;
	runs?: number;
	lookback?: number;
	options?: Partial<TrendOptions>;
}

/** The trend of a full run: never throws, a failure is said in `error`. */
export function run_trend(input: TrendInput): TrendRun {
	const t0 = performance.now();
	const empty = (note: string | null, error: string | null): TrendRun => ({
		runs: [],
		cases: 0,
		creeps: [],
		steps: [],
		note,
		error,
		ms: Math.round(performance.now() - t0)
	});
	if (!input.history) return empty('no history of main was given', null);
	if (!existsSync(input.history)) return empty('the history of main is not there', null);
	try {
		const sha = input.result.meta.sha;
		const order = main_order(input.repo, sha, input.lookback ?? TREND_LOOKBACK);
		const stored = stored_runs(input.history);
		const wanted = order
			.filter((s) => s !== sha && stored.has(s))
			.slice(-((input.runs ?? TREND_RUNS) - 1));
		const points: RunPoint[] = [];
		for (const s of wanted) {
			const p = point_of(read_result(input.history, s));
			if (p) points.push(p);
		}
		const own = point_of(input.result);
		if (own) points.push(own);
		const run = trend_of(points, input.options);
		run.ms = Math.round(performance.now() - t0);
		return run;
	} catch (e) {
		return empty(null, e instanceof Error ? e.message : String(e));
	}
}
