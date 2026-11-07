import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { case_key } from '../cases.ts';
import { diff_reports } from '../diff/index.ts';
import type { DiffResult } from '../diff/index.ts';
import type { LoaderConfig } from '../loader/register.ts';
import { own_file } from '../own.ts';
import { ProcessError, run_process } from '../proc.ts';
import { one_line } from '../report.ts';
import type { Report } from '../report.ts';
import { ddmin } from './ddmin.ts';
import type { Outcome, Tester } from './ddmin.ts';
import { diff_units } from './hunks.ts';
import type { TreeFiles, Unit, Units } from './hunks.ts';
import { mirror_tree, remove_tree, write_tree } from './tree.ts';
import type { FunctionChange } from '../diff/index.ts';
import { load_weights } from '../calibrate/weights.ts';
import { rank_changes } from '../weight/rank.ts';
import type { RankedChange } from '../weight/rank.ts';
import { coverage_line, sum_costs, traffic_unit } from '../weight/cost.ts';
import type { RealCost } from '../weight/cost.ts';
import type { AppWeights } from '../weight/weights.ts';

/*
 * Which part of a PR made a case slower (spec: blame). Counts are exact, so a tree made of the
 * base plus some of the PR's hunks counts the same every time, and comparing such trees answers
 * "which hunks cost these steps" without noise. Timers could not: a 2% change is inside their
 * noise, and every candidate would need many runs.
 *
 * For each regressed case, two delta-debugging searches (ddmin.ts) over the PR's hunks (hunks.ts):
 *
 *   revert   the smallest set of hunks whose undoing, from the PR, removes the regression
 *   apply    the smallest set of hunks that, applied alone on the base, reproduces it
 *
 * They name the same hunks when the hunks add up. They differ when hunks interact: two hunks that
 * only cost together (a flag and the branch that reads it) need both to be applied, but undoing
 * either one removes the cost. Both answers are reported, with the tool saying they interact.
 *
 * "Removes" and "reproduces" are judged on the extra steps E = head − base, both recounted here on
 * scratch trees: a tree reproduces the regression when it costs at least (1 − tolerance) E more
 * than the base, and is free of it when it costs at most tolerance × E more. A hunk that speeds
 * something up a little, or one that adds a few steps of its own, is not needed in either set.
 *
 * A candidate tree that does not load or whose case throws (a hunk that needs another to compile)
 * is unresolved, the standard ddmin handling. Each tree is counted once: by the sha256 of its
 * content, so the same tree reached from either search, or from another case, is never recounted.
 * One recount counts every regressed case, in one child. A budget of recounts and wall time ends
 * the search with the smallest set found so far: "narrowed to these 3 hunks".
 */

export const BLAME_SCHEMA = 'heisenbench-blame/1';
/** A case regressed when its steps grew at least this much (share of the base)... */
export const BLAME_MIN_RATIO = 0.01;
/** ...and by at least this many steps. */
export const BLAME_MIN_STEPS = 1000;
/** Share of the extra steps a tree may keep and still be free of the regression (and miss and still reproduce it). */
export const BLAME_TOLERANCE = 0.1;
export const BLAME_MAX_RECOUNTS = 60;
export const BLAME_BUDGET_MS = 10 * 60_000;
/** One recount child's own limit. */
const CHILD_LIMIT_MS = 10 * 60_000;
/** A share is reported for each hunk of a set of at most this many. */
const MAX_SHARES = 8;
const MAX_FUNCTIONS = 5;
const MAX_LINES = 5;

export interface RegressedCase {
	name: string;
	/** The bench file, relative to the root. */
	file: string;
	base_steps: number;
	pr_steps: number;
}

/** The cases whose steps grew past the threshold, biggest growth first. */
export function regressed_cases(
	diff: DiffResult,
	head: Report,
	o: { min_ratio?: number; min_steps?: number } = {}
): RegressedCase[] {
	const min_ratio = o.min_ratio ?? BLAME_MIN_RATIO;
	const min_steps = o.min_steps ?? BLAME_MIN_STEPS;
	const unstable = new Set(diff.unstable);
	const out: RegressedCase[] = [];
	for (const c of diff.cases) {
		if (unstable.has(c.name)) continue;
		const grew = c.pr_steps - c.base_steps;
		if (grew < min_steps || grew < min_ratio * c.base_steps) continue;
		const hc = head.cases.find((x) => x.name === c.name && x.error === null);
		if (hc)
			out.push({ name: c.name, file: hc.file, base_steps: c.base_steps, pr_steps: c.pr_steps });
	}
	return out.sort(
		(a, b) => b.pr_steps - b.base_steps - (a.pr_steps - a.base_steps) || (a.name < b.name ? -1 : 1)
	);
}

export interface BlameOptions {
	/** A git repository that has both commits. */
	repo: string;
	/** The run root, checked out at `head` and installed. Never written to. */
	root: string;
	base: string;
	head: string;
	cases: RegressedCase[];
	/** Only hunks of these files (repository paths): the regressed cases' import graphs. */
	paths?: readonly string[] | null;
	/** The root's place in the repository (Report.git.prefix). */
	prefix?: string;
	deps?: LoaderConfig['deps'];
	max_recounts?: number;
	budget_ms?: number;
	/** Trees counted side by side (each in its own scratch copy). */
	jobs?: number;
	tolerance?: number;
	/** Where the scratch copies and the counts go (default: a new temporary directory, removed after). */
	work?: string;
	/** Node flags for the recount children (default: this process's); paths into the root are moved to the scratch copy. */
	node_args?: readonly string[];
	env?: NodeJS.ProcessEnv;
	log?: (line: string) => void;
	/**
	 * App and real-traffic weights (merged, as `heisenbench diff --weights` takes them): the
	 * blamed change is priced with the comment's cost function (weight/cost.ts).
	 */
	weights?: AppWeights | null;
	/** Requests per day for the real cost (default: the profiles' rate). */
	requests_per_day?: number;
}

/** What a blamed change costs on the imported traffic (weight/cost.ts), per hunk and in all. */
export interface BlameCost {
	/** The unit of traffic (`real request`). */
	unit: string;
	/** Every changed function the traffic runs, added up; null when it runs none. */
	total: RealCost | null;
	/** The same per hunk: each function goes to the hunk holding most of its changed steps. */
	hunks: Array<{ unit: number; cost: RealCost | null }>;
	/** Changed functions priced, and those the traffic does not run. */
	priced: number;
	not_in_traffic: number;
	/** How much of the traffic's sampled time mapped to counted functions. */
	coverage: string | null;
}

export interface BlameUnit {
	id: number;
	kind: Unit['kind'];
	file: string;
	/** Head lines. */
	lines: [number, number];
	old_lines: [number, number];
	/** The diff with 3 unchanged lines around it (only for the hunks a case names). */
	text?: string;
}

export interface BlameLine {
	line: number;
	delta_steps: number;
	/** The hunk this line is in, or null (an unchanged line whose count changed). */
	unit: number | null;
}

export interface BlameFunction {
	module: string;
	function: string;
	line: number;
	delta_self_steps: number;
	/** `with`: the function exists only with the change; `without`: only without it (its lines are that tree's). */
	only: 'with' | 'without' | null;
	lines: BlameLine[];
	/** With weights: this function's change on the imported traffic (null: the traffic does not run it). */
	cost?: RealCost | null;
}

export type BlameStatus =
	/** Both searches finished. */
	| 'found'
	/** The budget ran out first: the sets are narrowed, not minimal. */
	| 'narrowed'
	/** The PR's hunks do not make the case slower on the scratch trees: the cost is elsewhere. */
	| 'outside'
	/** The base or the head tree did not count. */
	| 'invalid'
	/** The budget ran out before the case was looked at. */
	| 'skipped';

export interface SearchSide {
	units: number[];
	/** The search finished (the set is 1-minimal). */
	complete: boolean;
	/** Extra steps over the base: with the set undone (revert), or with only the set applied (apply). */
	extra: number | null;
}

export interface CaseBlame {
	case: string;
	file: string;
	/** Steps in the two reports. */
	base_steps: number;
	pr_steps: number;
	status: BlameStatus;
	note: string | null;
	/** Recounted on the scratch trees: the base's version of every hunk, and the head's. */
	anchors: { base: number | null; head: number | null };
	/** head − base, recounted. */
	extra: number;
	/** The share of the reports' change that the hunks account for (1: all of it). */
	explained: number | null;
	revert: SearchSide;
	apply: SearchSide;
	/** Per named hunk, its share of the extra steps: undone alone from the PR, applied alone on the base. */
	shares: Array<{
		unit: number;
		revert: number | null;
		apply: number | null;
		/** False when neither the head without it nor the base with only it loads and runs. */
		runs_alone: boolean;
	}>;
	/** The hunks only cost together, or the two searches name different hunks. */
	interacts: boolean;
	/** Where the steps went, from the head against the head with the revert set undone. */
	functions: BlameFunction[];
	/** With real-traffic weights: what the revert set's change costs that traffic (absent: no weights). */
	cost?: BlameCost | null;
	/** Trees that did not load or run for this case. */
	invalid: number;
}

export interface Recount {
	hash: string;
	applied: number[];
	ms: number;
	steps: Record<string, number | null>;
	error: string | null;
}

export interface BlameResult {
	schema: typeof BLAME_SCHEMA;
	base: string;
	head: string;
	tolerance: number;
	budget: { recounts: number; ms: number };
	/** Every hunk the search ran over (the text only for the named ones). */
	units: BlameUnit[];
	cases: CaseBlame[];
	/** Cases that share their cause, as one group. */
	groups: Array<{ cases: string[]; revert: number[]; apply: number[] }>;
	spent: { recounts: number; reused: number; ms: number };
	exhausted: boolean;
	recounts: Recount[];
}

interface Count {
	hash: string;
	file: string;
	/** Steps per case key; null: the case did not count in this tree. */
	steps: Map<string, number | null>;
	errors: Map<string, string>;
	ms: number;
	error: string | null;
}

const PATH_FLAGS = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader']);

/** Node flags with every path into `root` moved into `lane` (relative ones resolved first). */
export function move_args(args: readonly string[], root: string, lane: string): string[] {
	const move = (v: string): string => {
		if (!(v.startsWith('.') || isAbsolute(v))) return v; // a package name
		const abs = resolve(v);
		return abs === root || abs.startsWith(root + sep) ? lane + abs.slice(root.length) : abs;
	};
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const eq = a.indexOf('=');
		if (eq !== -1 && PATH_FLAGS.has(a.slice(0, eq)))
			out.push(a.slice(0, eq + 1) + move(a.slice(eq + 1)));
		else if (PATH_FLAGS.has(a) && i + 1 < args.length) out.push(a, move(args[++i]));
		else out.push(a);
	}
	return out;
}

class Lanes {
	#free: string[] = [];
	#made = 0;
	#waiting: Array<(dir: string) => void> = [];
	root: string;
	work: string;
	jobs: number;
	fixed: TreeFiles;
	prefix: string;
	constructor(root: string, work: string, jobs: number, fixed: TreeFiles, prefix: string) {
		this.root = root;
		this.work = work;
		this.jobs = jobs;
		this.fixed = fixed;
		this.prefix = prefix;
	}

	take(): Promise<string> {
		const dir = this.#free.pop();
		if (dir) return Promise.resolve(dir);
		if (this.#made < this.jobs) {
			const d = join(this.work, `tree-${this.#made++}`);
			remove_tree(d); // one a stopped run left
			mirror_tree(this.root, d);
			write_tree(d, this.fixed, this.prefix);
			return Promise.resolve(d);
		}
		return new Promise((r) => this.#waiting.push(r));
	}

	give(dir: string): void {
		const w = this.#waiting.shift();
		if (w) w(dir);
		else this.#free.push(dir);
	}

	remove(): void {
		for (let i = 0; i < this.#made; i++) remove_tree(join(this.work, `tree-${i}`));
	}
}

/** The units a set leaves applied, sorted. */
function ids(s: Iterable<number>): number[] {
	return [...s].sort((a, b) => a - b);
}

export async function blame_regressions(o: BlameOptions): Promise<BlameResult> {
	const started = Date.now();
	const log = o.log ?? (() => {});
	const given_root = resolve(o.root);
	const root = realpathSync(given_root);
	const tolerance = o.tolerance ?? BLAME_TOLERANCE;
	const max_recounts = o.max_recounts ?? BLAME_MAX_RECOUNTS;
	const budget_ms = o.budget_ms ?? BLAME_BUDGET_MS;
	const jobs = Math.max(1, o.jobs ?? Math.min(4, Math.floor(availableParallelism() / 2)));
	const prefix = o.prefix ?? '';
	const own_work = o.work === undefined;
	const made = own_work ? mkdtempSync(join(tmpdir(), 'heisenbench-blame-')) : resolve(o.work!);
	mkdirSync(join(made, 'counts'), { recursive: true });
	// Module ids are paths from the root as the loader sees them, resolved through links
	// (`/var` is `/private/var` on macOS): the scratch root must be one already.
	const work = realpathSync(made);

	const units: Units = diff_units(o.repo, o.base, o.head, {
		paths: o.paths ? new Set(o.paths) : null,
		prefix
	});
	const all = units.units.map((u) => u.id);
	const head_set = new Set(all);
	const files = [...new Set(o.cases.map((c) => c.file))].sort();
	const names = [...new Set(o.cases.map((c) => c.name))].sort();
	log(`blame: ${o.cases.length} case(s), ${all.length} hunk(s) in ${units.paths.length} file(s)`);

	const lanes = new Lanes(root, work, jobs, units.fixed, prefix);
	const node_args = o.node_args ?? process.execArgv;
	const env = o.env ?? process.env;
	const cache = new Map<string, Promise<Count>>();
	const recounts: Recount[] = [];
	let reused = 0;
	let exhausted = false;

	const run_count = async (applied: ReadonlySet<number>, hash: string): Promise<Count> => {
		const lane = await lanes.take();
		const t0 = Date.now();
		const out = join(work, 'counts', `${hash}.json`);
		const job_file = join(work, 'counts', `${hash}.job.json`);
		let error: string | null = null;
		try {
			write_tree(lane, units.tree(applied), prefix);
			writeFileSync(
				job_file,
				JSON.stringify({
					root: lane,
					files,
					cases: names,
					sha: null,
					prefix,
					deps: o.deps ?? true,
					out
				})
			);
			const left = budget_ms - (Date.now() - started);
			// a preload in the root (ogygia maps Vite-only specifiers to stubs) loads from the copy
			const move = (args: readonly string[]) =>
				move_args(move_args(args, given_root, lane), root, lane);
			const opts = (env.NODE_OPTIONS ?? '').split(' ').filter(Boolean);
			await run_process(process.execPath, [...move(node_args), own_file('blame/child'), job_file], {
				cwd: lane,
				env: { ...env, NODE_OPTIONS: move(opts).join(' ') },
				timeout_ms: Math.min(CHILD_LIMIT_MS, Math.max(60_000, left))
			});
		} catch (e) {
			const tail =
				e instanceof ProcessError
					? (e.stderr || e.stdout).trim().split('\n').slice(-3).join(' ')
					: '';
			error = `the recount ${one_line(e)}${tail ? `: ${tail}` : ''}`;
		} finally {
			lanes.give(lane);
		}
		const steps = new Map<string, number | null>();
		const errors = new Map<string, string>();
		let report: Report | null = null;
		if (error === null) {
			try {
				report = JSON.parse(readFileSync(out, 'utf8')) as Report;
			} catch (e) {
				error = `no report: ${one_line(e)}`;
			}
		}
		for (const c of o.cases) {
			const key = case_key(c);
			const got = report?.cases.find((x) => x.file === c.file && x.name === c.name);
			const load = report?.load_errors?.find((l) => l.file === c.file);
			if (got && got.error === null) steps.set(key, got.totals.steps);
			else {
				steps.set(key, null);
				errors.set(key, error ?? got?.error ?? load?.error ?? 'the case is not in this tree');
			}
		}
		const ms = Date.now() - t0;
		const rec: Recount = { hash, applied: ids(applied), ms, steps: {}, error };
		for (const c of o.cases) rec.steps[case_key(c)] = steps.get(case_key(c)) ?? null;
		recounts.push(rec);
		log(
			`recount ${recounts.length}: ${applied.size} of ${all.length} hunk(s) applied, ${ms} ms${error ? ` (${error})` : ''}`
		);
		return { hash, file: out, steps, errors, ms, error };
	};

	/** The count of a tree: cached, started now, or null when the budget allows no new one. */
	const count = (applied: ReadonlySet<number>): { p: Promise<Count>; fresh: boolean } | null => {
		const hash = units.hash(applied);
		const hit = cache.get(hash);
		if (hit) {
			reused++;
			return { p: hit, fresh: false };
		}
		if (cache.size >= max_recounts || Date.now() - started >= budget_ms) {
			exhausted = true;
			return null;
		}
		const p = run_count(applied, hash);
		cache.set(hash, p);
		return { p, fresh: true };
	};

	const result: BlameResult = {
		schema: BLAME_SCHEMA,
		base: o.base,
		head: o.head,
		tolerance,
		budget: { recounts: max_recounts, ms: budget_ms },
		units: units.units.map((u) => ({
			id: u.id,
			kind: u.kind,
			file: u.file,
			lines: u.new_lines,
			old_lines: u.old_lines
		})),
		cases: [],
		groups: [],
		spent: { recounts: 0, reused: 0, ms: 0 },
		exhausted: false,
		recounts
	};

	try {
		// The two anchors of every case: the base's version of every hunk, and the head's.
		const a0 = count(new Set());
		const a1 = count(head_set);
		const [c0, c1] = await Promise.all([a0?.p ?? null, a1?.p ?? null]);
		const found: Array<{ revert: number[]; apply: number[] }> = [];

		for (const rc of o.cases) {
			const key = case_key(rc);
			const blame: CaseBlame = {
				case: rc.name,
				file: rc.file,
				base_steps: rc.base_steps,
				pr_steps: rc.pr_steps,
				status: 'found',
				note: null,
				anchors: { base: c0?.steps.get(key) ?? null, head: c1?.steps.get(key) ?? null },
				extra: 0,
				explained: null,
				revert: { units: [], complete: false, extra: null },
				apply: { units: [], complete: false, extra: null },
				shares: [],
				interacts: false,
				functions: [],
				invalid: 0
			};
			result.cases.push(blame);
			const s0 = blame.anchors.base;
			const s1 = blame.anchors.head;
			if (s0 === null || s1 === null) {
				const which = s0 === null ? c0 : c1;
				blame.status = which ? 'invalid' : 'skipped';
				blame.note = which
					? `the ${s0 === null ? 'base' : 'head'} tree did not count: ${which.errors.get(key) ?? which.error ?? 'unknown'}`
					: 'the budget ran out';
				continue;
			}
			const extra = s1 - s0;
			blame.extra = extra;
			const reported = rc.pr_steps - rc.base_steps;
			blame.explained = reported > 0 ? extra / reported : null;
			if (extra <= 0 || (reported > 0 && extra < tolerance * reported)) {
				blame.status = 'outside';
				blame.note =
					'the base and the head versions of these hunks count alike: the extra steps come from outside them (a dependency, the lockfile, a file no bench file imports)';
				continue;
			}

			const seen_invalid = new Set<string>();
			const steps_of = async (applied: ReadonlySet<number>): Promise<number | null | undefined> => {
				const got = count(applied);
				if (!got) return undefined;
				const c = await got.p;
				const s = c.steps.get(key) ?? null;
				if (s === null) seen_invalid.add(c.hash);
				return s;
			};
			const reproduces = (s: number) => s - s0 >= (1 - tolerance) * extra;
			const free_of = (s: number) => s - s0 <= tolerance * extra;
			const tester = (
				state: (cand: number[]) => Set<number>,
				judge: (s: number) => boolean
			): Tester<number> => ({
				async first_failing(cands) {
					let i = 0;
					while (i < cands.length) {
						const batch: Array<{ i: number; p: Promise<Count> }> = [];
						let fresh = 0;
						let out = false;
						while (i < cands.length && fresh < jobs) {
							const got = count(state(cands[i]));
							if (!got) {
								out = true;
								break;
							}
							if (got.fresh) fresh++;
							batch.push({ i, p: got.p });
							i++;
						}
						for (const b of batch) {
							const c = await b.p;
							const s = c.steps.get(key) ?? null;
							const outcome: Outcome = s === null ? 'unresolved' : judge(s) ? 'fail' : 'pass';
							if (s === null) seen_invalid.add(c.hash);
							if (outcome === 'fail') return b.i;
						}
						if (out) return null;
					}
					return -1;
				}
			});
			const apply_state = (cand: number[]) => new Set(cand);
			const revert_state = (cand: number[]) => {
				const s = new Set(all);
				for (const u of cand) s.delete(u);
				return s;
			};
			const apply_tester = tester(apply_state, reproduces);
			const revert_tester = tester(revert_state, free_of);

			// A set an earlier case was blamed on is where this case starts, when it holds here too:
			// cases that share a cause find it in the trees already counted.
			const start = async (side: 'apply' | 'revert'): Promise<number[]> => {
				const t = side === 'apply' ? apply_tester : revert_tester;
				const sets = [...new Set(found.map((f) => f[side].join(',')))]
					.map((s) => (s === '' ? [] : s.split(',').map(Number)))
					.filter((s) => s.length > 0 && s.length < all.length)
					.sort((a, b) => a.length - b.length);
				const at = sets.length > 0 ? await t.first_failing(sets) : -1;
				return at !== null && at >= 0 ? sets[at] : all;
			};
			const apply = await ddmin(await start('apply'), apply_tester);
			const revert = await ddmin(await start('revert'), revert_tester);
			blame.apply = { units: ids(apply.set), complete: apply.complete, extra: null };
			blame.revert = { units: ids(revert.set), complete: revert.complete, extra: null };
			const sa = await steps_of(apply_state(apply.set));
			const sr = await steps_of(revert_state(revert.set));
			if (typeof sa === 'number') blame.apply.extra = sa - s0;
			if (typeof sr === 'number') blame.revert.extra = sr - s0;
			found.push({ revert: blame.revert.units, apply: blame.apply.units });
			if (!apply.complete || !revert.complete) {
				blame.status = 'narrowed';
				blame.note = `the budget ran out: narrowed to ${blame.revert.units.length} of ${all.length} hunks`;
			}

			// Each named hunk alone, both ways: its share of the extra steps, and whether the hunks add up.
			const named = ids(new Set([...blame.revert.units, ...blame.apply.units]));
			const single_revert = new Map<number, number | null>();
			const single_apply = new Map<number, number | null>();
			// a hunk that does not run without the others (null: did not count; undefined: no budget)
			const alone_invalid = new Set<number>();
			if (named.length <= MAX_SHARES) {
				for (const u of named) {
					const r =
						blame.revert.units.length === 1 && blame.revert.units[0] === u
							? sr
							: await steps_of(revert_state([u]));
					const a =
						blame.apply.units.length === 1 && blame.apply.units[0] === u
							? sa
							: await steps_of(apply_state([u]));
					single_revert.set(u, typeof r === 'number' ? (s1 - r) / extra : null);
					single_apply.set(u, typeof a === 'number' ? (a - s0) / extra : null);
					if (r === null && a === null) alone_invalid.add(u);
				}
			}
			blame.shares = named.map((u) => ({
				unit: u,
				revert: single_revert.get(u) ?? null,
				apply: single_apply.get(u) ?? null,
				runs_alone: !alone_invalid.has(u)
			}));
			const same_sets = blame.revert.units.join(',') === blame.apply.units.join(',');
			const adds_up = (set: number[], m: Map<number, number | null>, joint: number | null) => {
				if (set.length < 2 || joint === null) return true;
				const parts = set.map((u) => m.get(u));
				if (parts.some((p) => p === null || p === undefined)) return true;
				const sum = (parts as number[]).reduce((x, y) => x + y, 0);
				return Math.abs(sum - joint) <= tolerance;
			};
			const joint_apply = blame.apply.extra === null ? null : blame.apply.extra / extra;
			const joint_revert =
				blame.revert.extra === null ? null : (extra - blame.revert.extra) / extra;
			blame.interacts =
				!same_sets ||
				!adds_up(blame.apply.units, single_apply, joint_apply) ||
				!adds_up(blame.revert.units, single_revert, joint_revert);

			// Where the steps went: the head against the head with the revert set undone.
			const without = revert_state(revert.set);
			const c_without = await count(without)?.p;
			if (c_without && c1 && c_without.steps.get(key) != null) {
				const w = where(
					rc,
					c_without.file,
					c1.file,
					units,
					without,
					head_set,
					new Set([...revert.set, ...apply.set]),
					prefix,
					o.weights ?? null,
					o.requests_per_day
				);
				blame.functions = w.functions;
				if (o.weights) blame.cost = w.cost;
			}
			blame.invalid = seen_invalid.size;
		}

		// Cases with the same answer are one cause.
		const groups = new Map<string, { cases: string[]; revert: number[]; apply: number[] }>();
		for (const c of result.cases) {
			if (c.status !== 'found' && c.status !== 'narrowed') continue;
			const k = `${c.revert.units.join(',')}|${c.apply.units.join(',')}`;
			const g = groups.get(k) ?? { cases: [], revert: c.revert.units, apply: c.apply.units };
			g.cases.push(c.case);
			groups.set(k, g);
		}
		result.groups = [...groups.values()];
		const named = new Set(result.cases.flatMap((c) => [...c.revert.units, ...c.apply.units]));
		for (const u of result.units) if (named.has(u.id)) u.text = units.text(units.units[u.id]);
	} finally {
		await Promise.allSettled(cache.values());
		lanes.remove();
		if (own_work) remove_tree(work);
	}
	result.exhausted = exhausted;
	result.spent = { recounts: recounts.length, reused, ms: Date.now() - started };
	log(
		`blame: ${recounts.length} recount(s), ${reused} reused, ${Math.round(result.spent.ms / 1000)} s`
	);
	return result;
}

/**
 * The functions and lines whose steps changed between two counted trees, biggest first, and, with
 * weights, what the change costs: every changed function ranked by the same `rank_changes` the
 * comment's other findings go through (real cost on imported traffic, with its range), and those
 * costs added up per hunk (a function goes to the hunk that holds most of its changed steps) and
 * for the whole set.
 */
function where(
	rc: RegressedCase,
	from_file: string,
	to_file: string,
	units: Units,
	from: ReadonlySet<number>,
	to: ReadonlySet<number>,
	changed: ReadonlySet<number>,
	prefix: string,
	weights: AppWeights | null,
	requests_per_day: number | undefined
): { functions: BlameFunction[]; cost: BlameCost | null } {
	const read = (f: string) => {
		const r = JSON.parse(readFileSync(f, 'utf8')) as Report;
		r.cases = r.cases.filter((c) => c.file === rc.file && c.name === rc.name);
		return r;
	};
	const d = diff_reports(read(from_file), read(to_file), { files: units.file_diffs(from, to) });
	// module ids are relative to the root, hunk paths to the repository
	const lead = prefix ? prefix.replace(/\/$/, '') + '/' : '';
	const unit_at = (module: string, line: number): number | null => {
		for (const id of changed) {
			const u = units.units[id];
			if (u.file !== lead + module) continue;
			if (line >= u.new_lines[0] && line <= u.new_lines[1]) return id;
		}
		return null;
	};
	const moved = d.changes.filter((c) => c.findings.length > 0 && c.delta.self_steps !== 0);
	const ranked = weights
		? rank_changes(d, weights, load_weights(), { requests_per_day })
		: ([] as RankedChange[]);
	const cost_of = new Map(ranked.map((r) => [`${r.module} > ${r.function}`, r.cost ?? null]));
	/** The hunk with most of a function's changed steps (lines of the tree with the change). */
	const home = (c: FunctionChange): number | null => {
		if (c.pr === null) return null;
		const by = new Map<number, number>();
		for (const f of c.findings) {
			const u = unit_at(f.module, f.line);
			if (u !== null) by.set(u, (by.get(u) ?? 0) + Math.abs(f.delta.steps));
		}
		let best: number | null = null;
		for (const [u, s] of by) if (best === null || s > by.get(best)!) best = u;
		return best;
	};
	const functions = [...moved]
		.sort((a, b) => Math.abs(b.delta.self_steps) - Math.abs(a.delta.self_steps))
		.slice(0, MAX_FUNCTIONS)
		.map((c) => ({
			module: c.module,
			function: c.function,
			line: c.line,
			delta_self_steps: c.delta.self_steps,
			only: c.base === null ? ('with' as const) : c.pr === null ? ('without' as const) : null,
			lines: [...c.findings]
				.filter((f) => f.delta.steps !== 0)
				.sort((a, b) => Math.abs(b.delta.steps) - Math.abs(a.delta.steps))
				.slice(0, MAX_LINES)
				.map((f) => ({
					line: f.line,
					delta_steps: f.delta.steps,
					unit: c.pr === null ? null : unit_at(f.module, f.line)
				})),
			...(weights ? { cost: cost_of.get(`${c.module} > ${c.function}`) ?? null } : {})
		}));
	const traffic = traffic_unit(weights);
	if (!weights || !traffic) return { functions, cost: null };
	const all: RealCost[] = [];
	const per_unit = new Map<number, RealCost[]>();
	let outside = 0;
	for (const c of moved) {
		const cost = cost_of.get(`${c.module} > ${c.function}`) ?? null;
		if (!cost) {
			outside++;
			continue;
		}
		all.push(cost);
		const u = home(c);
		if (u !== null) per_unit.set(u, [...(per_unit.get(u) ?? []), cost]);
	}
	return {
		functions,
		cost: {
			unit: traffic.key,
			total: sum_costs(all),
			hunks: [...per_unit]
				.sort((a, b) => a[0] - b[0])
				.map(([unit, cs]) => ({ unit, cost: sum_costs(cs) })),
			priced: all.length,
			not_in_traffic: outside,
			coverage: coverage_line(weights)
		}
	};
}
