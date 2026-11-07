import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync
} from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { regressed_cases } from '../blame/index.ts';
import { Lanes, run_child } from '../blame/lanes.ts';
import { remove_tree } from '../blame/tree.ts';
import type { TreeFiles } from '../blame/hunks.ts';
import { source_inventory } from '../coverage/gate.ts';
import type { SourceFunction } from '../coverage/gate.ts';
import { diff_reports } from '../diff/index.ts';
import { shown } from '../diff/markdown.ts';
import { GROWTH_RANK } from '../growth/fit.ts';
import type { GrowthClass } from '../growth/fit.ts';
import { DEFAULT_SIZES, GROWTH_SCHEMA, diff_growth } from '../growth/index.ts';
import type { GrowthCase, GrowthReport } from '../growth/index.ts';
import { causes } from '../growth/recorded.ts';
import type { RecordedGrowthReport } from '../growth/recorded.ts';
import { package_of } from '../identity.ts';
import type { LoaderConfig } from '../loader/register.ts';
import { OWN_DIR } from '../own.ts';
import { load_prices } from '../prices.ts';
import { one_line } from '../report.ts';
import type { CaseReport, Report } from '../report.ts';
import { Rng } from '../search/mutate.ts';
import { load_weights } from '../calibrate/weights.ts';
import { cost_context, cost_text, exposure_cost, traffic_unit } from '../weight/cost.ts';
import { basis_of } from '../weight/rank.ts';
import type { Basis } from '../weight/rank.ts';
import { canonical_function } from '../weight/weights.ts';
import type { AppWeights } from '../weight/weights.ts';
import { OPERATORS, make_mutant, plan_module, rewrite } from './operators.ts';
import type { ModulePlan, Mutant, Operator, PlannedFunction } from './operators.ts';
import { twin_difference } from './twin.ts';
import type { TwinSummary } from './twin.ts';
import { suggest } from './suggest.ts';

/*
 * The benchmarks tested by mutants (spec: mutation score). Mutation testing asks whether the tests
 * notice injected bugs; this asks whether the bench cases notice injected slowdowns. Every measured
 * function gets behavior-preserving performance mutants (operators.ts), and the same rules a PR
 * comment uses decide whether a case notices:
 *
 *   double, alloc, cache   caught when the step table of `heisenbench diff` would show a change:
 *                          a function whose own steps, allocations or bytes moved in some case
 *                          (exact counts: any change shows). "Loud" when a case also grew past
 *                          blame's threshold (1% and 1,000 steps), the line the comment leads with.
 *   quadratic              caught when growth flags a class change: a case that declares `scale`
 *                          (what CI grows) turns from linear to quadratic or worse, or growth from
 *                          recorded calls (`--records`) newly finds the function growing. The
 *                          extra steps at the bench's own input size are not enough: at one size a
 *                          quadratic loop looks like a constant cost.
 *
 * Each mutant is counted on a scratch copy of the root (blame's lanes, tree.ts), against the same
 * function with the twin hook alone (twin.ts): the mutant must return, throw and build what the
 * original does on every call the bench cases make, or it changed behavior and is discarded. Only
 * the cases that ran the function in the base count are recounted: a case that never calls it
 * cannot change. A function no case runs gets every mutant missed without a recount.
 *
 * Every tree is counted once: by the sha256 of its content, the cases and what counts them, in
 * memory, and on disk under `--work` across runs. The recount budget is spent in a fixed order (a
 * function is started only when all of its recounts fit), so the same seed gives the same report;
 * the wall-time budget is a safety net that can end a run early.
 */

export const MUTATION_SCHEMA = 'heisenbench-mutation/1';
/** Functions mutated when sampling (the reached ones; the unreached cost nothing). */
export const DEFAULT_SAMPLE = 60;
/**
 * Recounts reserved at most: a function reserves its control, a repeat of it, one per mutant and
 * three growths for a quadratic one (ogygia main reserves about 3,800 for 632 functions, spends
 * about 2,300).
 */
export const MUTATION_MAX_RECOUNTS = 6000;
export const MUTATION_BUDGET_MS = 60 * 60_000;
/**
 * Steps one growth run may take (the root's and the mutant's alike): a quadratic mutant at 100x
 * stops here and is fitted on the doubling ladder below it, in seconds instead of minutes.
 */
export const MUTATION_CAP = 5e8;
const CHILD_LIMIT_MS = 15 * 60_000;
/** A growth child's limit: CI's for `heisenbench growth` of one bench file (suites/ogygia run.ts). */
export const GROWTH_LIMIT_MS = 5 * 60_000;
/** Recounts a function may need beyond its control and one per mutant (growth of a quadratic mutant). */
const GROWTH_RESERVE = 3;

export type MutantStatus =
	/** A case noticed it. */
	| 'caught'
	| 'missed'
	/** It changed what the function returns or throws on the bench's inputs: not a slowdown. */
	| 'discarded'
	/** No case runs the function: missed without a recount (the twin cannot check it either). */
	| 'unreached'
	/** The rewrite did not load (an operator's bug, not the benchmarks'): left out of the score. */
	| 'invalid'
	/** Not in the sample, or the budget ran out first. */
	| 'skipped';

export interface MutantResult {
	operator: Operator;
	line: number;
	what: string;
	status: MutantStatus;
	/** What noticed it. */
	by: 'steps' | 'growth' | 'recorded growth' | null;
	/** A case grew by at least 1% and 1,000 steps (blame's threshold). */
	loud: boolean | null;
	/** The case that grew most: by how many steps, and that over its count. */
	delta_steps: number | null;
	delta_share: number | null;
	/** Quadratic: the step table showed the extra steps at the bench's own size. */
	noticed_steps?: boolean;
	/** Quadratic: each grown case's class, original and mutant. */
	growth?: Array<{ case: string; base: GrowthClass | null; mutant: GrowthClass | null }>;
	/** Quadratic, missed: the hottest case without `scale`, grown the generic way. */
	generic?: { case: string; base: GrowthClass | null; mutant: GrowthClass | null } | null;
	note: string | null;
}

export interface FunctionWeightInfo {
	basis: Basis;
	/** What the ranking sorts by (CPU s/day, steps per unit, or steps per bench run). */
	value: number;
	text: string;
}

export interface FunctionResult {
	id: string;
	module: string;
	path: string;
	package: string;
	line: number;
	end_line: number;
	/** The cases that ran it in the base count (`file > name`). */
	cases: string[];
	/** Of those, the ones that declare `scale`. */
	scale_cases: string[];
	calls: number;
	/** Its inclusive steps over every case that ran it. */
	inclusive_steps: number;
	sampled: boolean;
	/** Why it takes no mutant at all (a generator, no body, not found in the source). */
	skip: string | null;
	mutants: MutantResult[];
	weight: FunctionWeightInfo;
	/** A bench case that would catch what was missed (markdown), for the ranked ones. */
	suggestion?: string | null;
}

export interface Score {
	/** Mutants of every function of the inventory. */
	mutants: number;
	unreached: number;
	/** Of the reached functions' mutants: evaluated and found, and the rest. */
	caught: number;
	missed: number;
	discarded: number;
	invalid: number;
	skipped: number;
	loud: number;
	/** caught / (caught + missed + unreached), estimated for a sample; null: nothing to judge. */
	score: number | null;
	/** The same over the functions a case runs only: caught / (caught + missed). */
	run_score: number | null;
	/** The reached part comes from a sample. */
	estimated: boolean;
}

export interface PackageScore {
	package: string;
	functions: number;
	reached: number;
	scores: Record<Operator, Score>;
}

export interface MissedFunction {
	id: string;
	package: string;
	operators: Operator[];
	reason: string;
	weight: FunctionWeightInfo;
	suggestion: string | null;
}

export interface MutationReport {
	schema: typeof MUTATION_SCHEMA;
	seed: number;
	sample: {
		mode: 'sample' | 'all';
		size: number;
		evaluated: number;
		reached: number;
		functions: number;
	};
	operators: Operator[];
	sizes: number[];
	cap: number;
	/** Which ranking the missed functions are in. */
	basis: Basis;
	totals: Record<Operator, Score>;
	packages: PackageScore[];
	functions: FunctionResult[];
	missed: MissedFunction[];
	/** Inventory functions not found in the source (listed, never guessed), and files that did not read. */
	unmatched: string[];
	errors: Array<{ file: string; error: string }>;
	/** The recount budget ran out before every sampled function was evaluated. */
	exhausted: boolean;
	cost: {
		ms: number;
		recounts: number;
		growth: number;
		/** Trees found in this run's cache, and in the cache of `--work` from an earlier run. */
		reused: number;
		cached: number;
	};
}

export interface MutationOptions {
	/** The run root, installed. Never written to. */
	root: string;
	/** Bench files (relative to the root or absolute). */
	files: string[];
	/** Source files whose functions get mutants (absolute or relative to the root). */
	sources: string[];
	/** The counted base (`heisenbench run` of the same files on the root); counted here when absent. */
	report?: Report | null;
	operators?: readonly Operator[];
	/** Reached functions to mutate (stratified by package), or 'all'. */
	sample?: number | 'all';
	seed?: number;
	/** Only functions of these modules (ids relative to the root). */
	modules?: ReadonlySet<string> | null;
	/** Also mutate the dependency functions the cases run (their package files are copied into each lane). */
	include_deps?: boolean;
	sizes?: number[];
	cap?: number;
	/** Recorded calls (`heisenbench record` / the recorder's sample files): growth from them too. */
	records?: { dir: string; alias: string | null } | null;
	weights?: AppWeights | null;
	requests_per_day?: number;
	deps?: LoaderConfig['deps'];
	jobs?: number;
	max_recounts?: number;
	budget_ms?: number;
	/** Scratch copies and counts (default: a temporary directory, removed after); counts are reused across runs. */
	work?: string;
	node_args?: readonly string[];
	env?: NodeJS.ProcessEnv;
	log?: (line: string) => void;
	/** Missed functions given a suggestion (the top of the ranking). */
	suggestions?: number;
}

interface Counted {
	report: Report | null;
	twin: TwinSummary | null;
	error: string | null;
}

interface ListedCase {
	name: string;
	file: string;
	scale: boolean;
}

function sha(s: string | Buffer): string {
	return createHash('sha256').update(s).digest('hex');
}

/** sha256 over Heisenbench's own source and prices: what counts the trees. */
function engine_hash(): string {
	const h = createHash('sha256');
	// what only this process runs (judging, ranking, writing) never changes a count
	const judge_only = new Set(
		['index', 'markdown', 'suggest', 'cli'].map((n) => join(OWN_DIR, 'mutation', n))
	);
	const walk = (d: string): void => {
		for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
			a.name < b.name ? -1 : 1
		)) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (/\.(ts|js)$/.test(e.name) && !judge_only.has(p.replace(/\.(ts|js)$/, '')))
				h.update(e.name).update(readFileSync(p));
		}
	};
	walk(OWN_DIR);
	h.update(load_prices().hash);
	return h.digest('hex');
}

/** What the root is: its commit and its uncommitted changes, or null outside git. */
function root_hash(root: string): string | null {
	try {
		const opts = {
			cwd: root,
			encoding: 'utf8' as const,
			stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
			maxBuffer: 1 << 28
		};
		const head = execFileSync('git', ['rev-parse', 'HEAD'], opts).trim();
		const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], opts);
		const diff = dirty.trim() === '' ? '' : execFileSync('git', ['diff', 'HEAD'], opts);
		return sha(`${head}\n${diff}`);
	} catch {
		return null;
	}
}

/** The `name` of the nearest package.json at or above `file`, under `root`. */
function package_namer(root: string): (module: string) => string {
	const cache = new Map<string, string>();
	const of_dir = (dir: string): string => {
		const hit = cache.get(dir);
		if (hit !== undefined) return hit;
		let name = '';
		const pj = join(dir, 'package.json');
		if (existsSync(pj)) {
			try {
				const n = (JSON.parse(readFileSync(pj, 'utf8')) as { name?: unknown }).name;
				if (typeof n === 'string') name = n;
			} catch {
				/* not JSON: keep looking up */
			}
		}
		if (name === '' && dir !== root && dir.startsWith(root + sep)) name = of_dir(dirname(dir));
		if (name === '') name = relative(root, dir).split(sep)[0] || '(root)';
		cache.set(dir, name);
		return name;
	};
	return (module: string) => {
		const dep = package_of(module);
		if (dep) return dep.name;
		return of_dir(dirname(join(root, module)));
	};
}

/** The file of a dependency module (`acorn@8.18.0/dist/acorn.mjs`) under the root's node_modules. */
export function dependency_file(root: string, module: string): string | null {
	const dep = package_of(module);
	if (!dep) return null;
	const rest = module.slice(`${dep.name}@${dep.version}/`.length);
	const want = (dir: string) => {
		try {
			const v = (
				JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }
			).version;
			return v === dep.version && existsSync(join(dir, rest)) ? join(dir, rest) : null;
		} catch {
			return null;
		}
	};
	const nm = join(root, 'node_modules');
	const top = want(join(nm, ...dep.name.split('/')));
	if (top) return relative(root, top).split(sep).join('/');
	const store = join(nm, '.pnpm');
	if (!existsSync(store)) return null;
	const prefix = `${dep.name.replace('/', '+')}@${dep.version}`;
	for (const e of readdirSync(store).sort()) {
		if (e !== prefix && !e.startsWith(prefix + '_') && !e.startsWith(prefix + '(')) continue;
		const got = want(join(store, e, 'node_modules', ...dep.name.split('/')));
		if (got) return relative(root, got).split(sep).join('/');
	}
	return null;
}

/** Fisher-Yates with the seeded generator. */
function shuffle<T>(xs: T[], rng: Rng): T[] {
	const out = [...xs];
	for (let i = out.length - 1; i > 0; i--) {
		const j = rng.int(i + 1);
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/** `size` items stratified by key: each stratum's share of the whole, at least one each. */
export function stratified_sample<T>(
	items: readonly T[],
	key: (t: T) => string,
	size: number,
	seed: number
): Set<T> {
	const rng = new Rng(seed);
	const by = new Map<string, T[]>();
	for (const t of items) by.set(key(t), [...(by.get(key(t)) ?? []), t]);
	const keys = [...by.keys()].sort();
	const total = items.length;
	if (size >= total) return new Set(items);
	const take = new Map<string, number>();
	let left = size;
	for (const k of keys) {
		const n = Math.max(1, Math.floor((size * by.get(k)!.length) / total));
		take.set(k, Math.min(n, by.get(k)!.length));
		left -= take.get(k)!;
	}
	// what rounding left goes to the strata with the most not yet taken, in name order on a tie
	while (left > 0) {
		const k = [...keys].sort(
			(a, b) =>
				by.get(b)!.length - take.get(b)! - (by.get(a)!.length - take.get(a)!) || (a < b ? -1 : 1)
		)[0];
		if (by.get(k)!.length - take.get(k)! <= 0) break;
		take.set(k, take.get(k)! + 1);
		left--;
	}
	const out = new Set<T>();
	for (const k of keys) for (const t of shuffle(by.get(k)!, rng).slice(0, take.get(k)!)) out.add(t);
	return out;
}

function empty_score(): Score {
	return {
		mutants: 0,
		unreached: 0,
		caught: 0,
		missed: 0,
		discarded: 0,
		invalid: 0,
		skipped: 0,
		loud: 0,
		score: null,
		run_score: null,
		estimated: false
	};
}

/**
 * The score of one stratum: the unreached part is exact; the reached part, when only a sample of
 * it was evaluated, is the sample's rate times the reached mutants there are.
 */
/**
 * The score over strata (packages): each stratum's unreached mutants are exact; its reached part,
 * when only a sample of it was evaluated, is the sample's rate times the reached mutants it has (a
 * stratified estimate). A stratum with reached mutants and none evaluated adds only its unreached.
 */
function score_of(parts: Array<{ s: Score; reached: number }>): Score {
	const out = empty_score();
	let caught = 0;
	let valid = 0;
	let unreached = 0;
	for (const { s, reached } of parts) {
		out.mutants += s.mutants;
		out.unreached += s.unreached;
		out.caught += s.caught;
		out.missed += s.missed;
		out.discarded += s.discarded;
		out.invalid += s.invalid;
		out.skipped += s.skipped;
		out.loud += s.loud;
		unreached += s.unreached;
		const judged = s.caught + s.missed + s.discarded + s.invalid;
		if (judged < reached) out.estimated = true;
		if (judged === 0) continue;
		const scale = reached / judged;
		caught += s.caught * scale;
		valid += (s.caught + s.missed) * scale;
	}
	out.score = valid + unreached > 0 ? caught / (valid + unreached) : null;
	out.run_score = valid > 0 ? caught / valid : null;
	return out;
}

/** A growth case's class, or null when it did not fit. */
function class_of(g: GrowthCase | undefined): GrowthClass | null {
	return g && !g.error ? g.class : null;
}

/** The case of a report by `file > name`. */
function case_of(r: Report | null, key: string): CaseReport | undefined {
	return r?.cases.find((c) => `${c.file} > ${c.name}` === key);
}

export async function mutation_score(o: MutationOptions): Promise<MutationReport> {
	const started = Date.now();
	const log = o.log ?? (() => {});
	const given_root = resolve(o.root);
	const root = realpathSync(given_root);
	const operators = o.operators ?? OPERATORS;
	const seed = o.seed ?? 1;
	const sample = o.sample ?? DEFAULT_SAMPLE;
	const sizes = o.sizes ?? DEFAULT_SIZES;
	const cap = o.cap ?? MUTATION_CAP;
	const max_recounts = o.max_recounts ?? MUTATION_MAX_RECOUNTS;
	const budget_ms = o.budget_ms ?? MUTATION_BUDGET_MS;
	const jobs = Math.max(1, o.jobs ?? Math.min(4, Math.floor(availableParallelism() / 2)));
	const deps = o.deps ?? true;
	const own_work = o.work === undefined;
	const made = own_work ? mkdtempSync(join(tmpdir(), 'heisenbench-mutate-')) : resolve(o.work!);
	mkdirSync(join(made, 'counts'), { recursive: true });
	const work = realpathSync(made);
	const files = o.files.map((f) => relative(root, resolve(given_root, f)).split(sep).join('/'));
	const lanes = new Lanes(root, work, jobs, new Map(), '', o.include_deps ? 'copy' : 'link');
	const node_args = o.node_args ?? process.execArgv;
	const env = o.env ?? process.env;
	const identity = sha(`${engine_hash()}\n${root_hash(root) ?? ''}\n${JSON.stringify(deps)}`);

	const cost = { recounts: 0, growth: 0, reused: 0, cached: 0 };
	const memo = new Map<string, Promise<Counted>>();
	let exhausted = false;

	/** Count one job on one tree, once per content. */
	const count = (
		tree: TreeFiles,
		job: {
			files: string[];
			cases: string[];
			twin?: boolean;
			growth?: { sizes: number[]; cap: number };
			recorded?: { modules: string[] };
			list?: boolean;
			cap?: number;
			/** A second count of the same tree (is the function's output the same run to run?). */
			again?: number;
		}
	): Promise<Counted> => {
		const parts = [...tree]
			.sort((a, b) => (a[0] < b[0] ? -1 : 1))
			.map(([p, b]) => [p, b === null ? null : sha(b)]);
		const key = sha(
			JSON.stringify({ identity, parts, job, records: job.recorded ? o.records : null })
		);
		const hit = memo.get(key);
		if (hit) {
			cost.reused++;
			return hit;
		}
		const out = join(work, 'counts', `${key}.json`);
		const twin_out = join(work, 'counts', `${key}.twin.json`);
		const done = join(work, 'counts', `${key}.done`);
		const p = (async (): Promise<Counted> => {
			if (existsSync(done)) {
				cost.cached++;
				const error = readFileSync(done, 'utf8') || null;
				return {
					report: existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as Report) : null,
					twin: existsSync(twin_out)
						? (JSON.parse(readFileSync(twin_out, 'utf8')) as TwinSummary)
						: null,
					error
				};
			}
			const lane = await lanes.take();
			const n = ++cost.recounts;
			if (job.growth || job.recorded) cost.growth++;
			let error: string | null = null;
			const t0 = Date.now();
			const left = budget_ms - (Date.now() - started);
			const own_limit = job.growth ? GROWTH_LIMIT_MS : CHILD_LIMIT_MS;
			const limit = Math.min(own_limit, Math.max(60_000, left));
			try {
				lanes.put(lane, tree);
				error = await run_child(
					lane,
					{
						root: lane,
						files: job.files,
						cases: job.cases,
						sha: null,
						prefix: '',
						deps,
						out,
						twin: job.twin ? twin_out : null,
						growth: job.growth ?? null,
						recorded:
							job.recorded && o.records
								? {
										dir: resolve(o.records.dir),
										alias: o.records.alias ? resolve(o.records.alias) : null,
										modules: job.recorded.modules,
										cap: cap
									}
								: null,
						list: job.list ?? false,
						cap: job.cap ?? null
					},
					join(work, 'counts', `${key}.job.json`),
					{
						given_root,
						root,
						node_args,
						env,
						timeout_ms: limit
					}
				);
			} catch (e) {
				error = `the recount ${one_line(e)}`;
			} finally {
				lanes.give(lane);
			}
			let report: Report | null = null;
			let twin: TwinSummary | null = null;
			if (error === null) {
				try {
					report = JSON.parse(readFileSync(out, 'utf8')) as Report;
					if (job.twin) twin = JSON.parse(readFileSync(twin_out, 'utf8')) as TwinSummary;
				} catch (e) {
					error = `no report: ${one_line(e)}`;
				}
			}
			const what = job.list
				? 'list'
				: job.growth
					? 'growth'
					: job.recorded
						? 'recorded growth'
						: 'count';
			log(
				`recount ${n}: ${what} of ${job.cases.length || 'every'} case(s) on ${tree.size === 0 ? 'the root' : [...tree.keys()].join(', ')}, ${Date.now() - t0} ms${error ? ` (${error})` : ''}`
			);
			// Kept for later runs, a growth past its fixed limit too; a count the run's own budget
			// cut short is not the tree's answer.
			if (
				error === null ||
				!/did not finish|killed/.test(error) ||
				(job.growth && limit === own_limit)
			)
				writeFileSync(done, error ?? '');
			return { report, twin, error };
		})();
		memo.set(key, p);
		return p;
	};

	const result_errors: Array<{ file: string; error: string }> = [];
	try {
		// 1. the base: which cases run which function, and how many steps each line takes
		let base = o.report ?? null;
		if (!base) {
			log(`mutate: counting the base (${files.length} bench file(s))`);
			const c = await count(new Map(), { files, cases: [] });
			if (!c.report) throw new Error(`heisenbench mutate: the base did not count: ${c.error}`);
			base = c.report;
		}
		const ran = new Map<string, Set<string>>();
		const calls = new Map<string, number>();
		const incl = new Map<string, number>();
		const line_steps = new Map<string, Map<number, number>>();
		const dep_modules = new Set<string>();
		/** Bench file -> the project's modules its cases run (where a new case for a module goes). */
		const run_modules = new Map<string, Set<string>>();
		for (const c of base.cases) {
			if (c.error) continue;
			const key = `${c.file} > ${c.name}`;
			for (const f of c.functions) {
				const lines = line_steps.get(f.module) ?? new Map<number, number>();
				for (const l of f.lines) lines.set(l.line, (lines.get(l.line) ?? 0) + l.steps);
				line_steps.set(f.module, lines);
				if (f.calls <= 0) continue;
				// the full id: callbacks in one place differ only by their shape hash
				const id = f.id;
				ran.set(id, (ran.get(id) ?? new Set()).add(key));
				calls.set(id, (calls.get(id) ?? 0) + f.calls);
				incl.set(id, (incl.get(id) ?? 0) + f.inclusive_steps);
				if (package_of(f.module)) dep_modules.add(f.module);
				else run_modules.set(c.file, (run_modules.get(c.file) ?? new Set()).add(f.module));
			}
		}
		const runs = new Map([...run_modules].map(([b, s]) => [b, [...s].sort()]));

		// 2. every function of the sources (and, asked, of the dependencies the cases run)
		const source_files = o.sources.map((s) => resolve(given_root, s));
		const inv = source_inventory(
			root,
			source_files.map((f) => (existsSync(f) ? realpathSync(f) : f))
		);
		result_errors.push(...inv.errors);
		let fns: SourceFunction[] = inv.functions;
		const module_files = new Map<string, string>();
		for (const f of source_files) {
			if (!existsSync(f)) continue;
			module_files.set(relative(root, realpathSync(f)).split(sep).join('/'), realpathSync(f));
		}
		if (o.include_deps) {
			const dep_files: string[] = [];
			for (const m of [...dep_modules].sort()) {
				const rel = dependency_file(root, m);
				if (!rel) continue;
				dep_files.push(join(root, rel));
				module_files.set(m, join(root, rel));
			}
			const dinv = source_inventory(root, dep_files);
			result_errors.push(...dinv.errors);
			// only the dependency functions a case ran
			fns = [...fns, ...dinv.functions.filter((f) => ran.has(f.id))];
		}
		if (o.modules) fns = fns.filter((f) => o.modules!.has(f.module));
		const package_name = package_namer(root);

		// 3. the mutants each function takes
		const plans = new Map<string, ModulePlan>();
		const unmatched: string[] = [];
		const by_module = new Map<string, SourceFunction[]>();
		for (const f of fns) by_module.set(f.module, [...(by_module.get(f.module) ?? []), f]);
		for (const [m, list] of [...by_module].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
			const file = module_files.get(m) ?? join(root, m);
			if (/\.svelte(\.(ts|js))?$/.test(file)) {
				unmatched.push(...list.map((f) => `${f.id} (a compiled Svelte module: not mutated)`));
				continue;
			}
			try {
				const plan = plan_module(m, file, readFileSync(file, 'utf8'), list);
				plans.set(m, plan);
				unmatched.push(...plan.unmatched);
			} catch (e) {
				result_errors.push({ file: m, error: one_line(e) });
			}
		}
		interface Item {
			plan: ModulePlan;
			f: PlannedFunction;
			key: string;
			cases: string[];
			mutants: Mutant[];
		}
		const items: Item[] = [];
		for (const plan of plans.values()) {
			const steps_at = (line: number) => line_steps.get(plan.module)?.get(line) ?? 0;
			for (const f of plan.functions) {
				const key = f.id;
				const mutants = operators
					.map((op) => make_mutant(f, op, steps_at))
					.filter((m): m is Mutant => m !== null);
				items.push({ plan, f, key, cases: [...(ran.get(key) ?? [])].sort(), mutants });
			}
		}
		items.sort((a, b) => (a.f.id < b.f.id ? -1 : a.f.id > b.f.id ? 1 : 0));
		const reached = items.filter((i) => i.cases.length > 0 && i.mutants.length > 0);
		const chosen =
			sample === 'all'
				? new Set(reached)
				: stratified_sample(reached, (i) => package_name(i.plan.module), sample, seed);
		log(
			`mutate: ${items.length} function(s), ${reached.length} run by a case; ${chosen.size} to mutate (${sample === 'all' ? 'all' : `sample of ${sample}, seed ${seed}`})`
		);

		// 4. which cases declare `scale` (what CI grows), and the base's growth of them
		const listed = await count(new Map(), { files, cases: [], list: true });
		const scaled = new Set(
			((listed.report as unknown as ListedCase[] | null) ?? [])
				.filter((c) => c.scale)
				.map((c) => `${c.file} > ${c.name}`)
		);
		const file_of = (key: string) => key.slice(0, key.indexOf(' > '));
		const name_of = (key: string) => key.slice(key.indexOf(' > ') + 3);
		const job_for = (keys: readonly string[]) => ({
			files: [...new Set(keys.map(file_of))].sort(),
			cases: [...new Set(keys.map(name_of))].sort()
		});
		const grow = (tree: TreeFiles, keys: readonly string[]) =>
			count(tree, { ...job_for(keys), growth: { sizes, cap } });
		/** The root's growth of some cases: one count per case, so functions that share a case share it. */
		const grow_base = async (keys: readonly string[]): Promise<GrowthReport | null> => {
			const parts = await Promise.all(keys.map((k) => grow(new Map(), [k])));
			if (parts.some((p) => !p.report)) return null;
			return {
				schema: GROWTH_SCHEMA,
				sizes,
				cases: parts.flatMap((p) => (p.report as unknown as GrowthReport).cases)
			};
		};

		// 5. each chosen function, in order, while its recounts fit the budget
		let reserved = cost.recounts;
		const results = new Map<Item, MutantResult[]>();
		const tasks: Array<Promise<void>> = [];
		for (const item of items) {
			if (!chosen.has(item)) continue;
			const need =
				2 +
				item.mutants.length +
				(item.mutants.some((m) => m.operator === 'quadratic') ? GROWTH_RESERVE : 0);
			if (reserved + need > max_recounts) {
				exhausted = true;
				continue;
			}
			reserved += need;
			tasks.push(
				evaluate(item).then((r) => {
					results.set(item, r);
				})
			);
		}

		async function evaluate(item: Item): Promise<MutantResult[]> {
			const { plan, f, cases, mutants } = item;
			// a mutant that runs away stops at 64 times its case's steps, not at the child's clock
			const most = Math.max(0, ...cases.map((k) => case_of(base, k)?.totals.steps ?? 0));
			const job = { ...job_for(cases), twin: true, cap: Math.max(1e7, Math.ceil(64 * most)) };
			const path = relative(root, module_files.get(plan.module) ?? join(root, plan.module))
				.split(sep)
				.join('/');
			const blank = (m: Mutant, status: MutantStatus, note: string | null): MutantResult => ({
				operator: m.operator,
				line: m.line,
				what: m.what,
				status,
				by: null,
				loud: null,
				delta_steps: null,
				delta_share: null,
				note
			});
			if (Date.now() - started > budget_ms) {
				exhausted = true;
				return mutants.map((m) => blank(m, 'skipped', 'the time budget ran out'));
			}
			const control = await count(
				new Map([[path, Buffer.from(rewrite(plan, f, null, true))]]),
				job
			);
			if (!control.report || !control.twin) {
				return mutants.map((m) =>
					blank(m, 'invalid', `the hooked original did not count: ${control.error}`)
				);
			}
			const control_errors = cases.filter((k) => case_of(control.report, k)?.error);
			if (control_errors.length === cases.length) {
				return mutants.map((m) =>
					blank(
						m,
						'invalid',
						`the hooked original did not run: ${case_of(control.report, cases[0])?.error ?? 'its cases failed'}`
					)
				);
			}
			// the base ran it, so the hooked copy must have: else the cases load it from elsewhere
			if (control.twin.calls === 0) {
				return mutants.map((m) =>
					blank(
						m,
						'invalid',
						'the hooked copy never ran: the cases load this module from somewhere the scratch copy does not rewrite'
					)
				);
			}
			const scale_keys = cases.filter((k) => scaled.has(k));
			let control_again: Promise<Counted> | undefined;
			const out: MutantResult[] = [];
			await Promise.all(
				mutants.map(async (m, i) => {
					const r = blank(m, 'missed', null);
					out[i] = r;
					const c = await count(new Map([[path, Buffer.from(rewrite(plan, f, m, true))]]), job);
					if (!c.report || !c.twin) {
						r.status = 'invalid';
						r.note = `the mutant did not count: ${c.error}`;
						return;
					}
					const load = c.report.load_errors?.[0];
					if (load) {
						r.status = 'invalid';
						r.note = `the mutant did not load: ${load.error}`;
						return;
					}
					const broke = cases.find(
						(k) => !case_of(control.report, k)?.error && case_of(c.report, k)?.error
					);
					const runaway = broke !== undefined && /step cap/.test(case_of(c.report, broke)!.error!);
					if (broke && !runaway) {
						r.status = 'discarded';
						r.note = `it changed behavior: ${name_of(broke)} throws (${case_of(c.report, broke)!.error})`;
						return;
					}
					const differs = runaway ? null : twin_difference(control.twin!, c.twin!);
					if (differs) {
						// the original itself may answer differently run to run (a fresh key pair each
						// setup): then the twin cannot judge, and the counts still can
						const again = await (control_again ??= count(
							new Map([[path, Buffer.from(rewrite(plan, f, null, true))]]),
							{ ...job, again: 1 }
						));
						const itself = again.twin ? twin_difference(control.twin!, again.twin) : null;
						if (itself === null) {
							r.status = 'discarded';
							r.note = `it changed behavior: ${differs}`;
							return;
						}
						r.note =
							'its output differs run to run on the original too: the twin could not check it';
					}
					if (runaway) {
						r.loud = true;
						r.note = `${name_of(broke!)} ran past 64 times its steps and was stopped`;
						if (m.operator !== 'quadratic') {
							r.status = 'caught';
							r.by = 'steps';
							return;
						}
					}
					const d = diff_reports(control.report!, c.report);
					const noticed = runaway || d.changes.some((x) => x.findings.some(shown));
					const grew = d.cases
						.map((x) => ({ x, delta: x.pr_steps - x.base_steps }))
						.sort((a, b) => b.delta - a.delta)[0];
					r.delta_steps = grew ? Math.round(grew.delta * 1e3) / 1e3 : 0;
					r.delta_share =
						grew && grew.x.base_steps > 0
							? Math.round((grew.delta / grew.x.base_steps) * 1e6) / 1e6
							: null;
					r.loud = runaway || regressed_cases(d, c.report).length > 0;
					if (m.operator !== 'quadratic') {
						if (noticed) {
							r.status = 'caught';
							r.by = 'steps';
						} else {
							r.note = 'no case counted a different step';
						}
						return;
					}
					r.noticed_steps = noticed;
					const tree = new Map([[path, Buffer.from(rewrite(plan, f, m, false))]]);
					if (scale_keys.length > 0) {
						const [b, g1] = await Promise.all([grow_base(scale_keys), grow(tree, scale_keys)]);
						const g = g1.report as unknown as GrowthReport | null;
						if (b && g) {
							r.growth = scale_keys.map((k) => ({
								case: name_of(k),
								base: class_of(b.cases.find((x) => x.name === name_of(k))),
								mutant: class_of(g.cases.find((x) => x.name === name_of(k)))
							}));
							if (diff_growth(b, g).findings.length > 0) {
								r.status = 'caught';
								r.by = 'growth';
								return;
							}
							// The mutant went past this layer's cap at the smallest sizes while the
							// original fitted below quadratic: CI's growth (a cap of 10^10) would fit
							// it, as quadratic or worse.
							const ran_away = scale_keys.find((k) => {
								const mg = g.cases.find((x) => x.name === name_of(k));
								const bg = class_of(b.cases.find((x) => x.name === name_of(k)));
								return (
									mg?.error?.startsWith('exceeded the cap') === true &&
									bg !== null &&
									(GROWTH_RANK[bg] ?? 99) < (GROWTH_RANK.quadratic ?? 4)
								);
							});
							if (ran_away) {
								r.status = 'caught';
								r.by = 'growth';
								r.note = `${name_of(ran_away)} went past ${cap} steps at its smallest sizes with the mutant, and fitted ${class_of(b.cases.find((x) => x.name === name_of(ran_away)))} without it`;
								return;
							}
						} else if (b && g1.error?.includes('did not finish')) {
							// the one judgment the clock makes: CI's growth of a bench file has the
							// same limit, and lists a file that runs past it
							r.status = 'caught';
							r.by = 'growth';
							r.note = `growing it did not finish within ${GROWTH_LIMIT_MS / 60_000} min, CI's limit for growth; the original grew in time`;
							return;
						} else {
							r.note = `growth did not count: ${g1.error ?? 'the base did not grow'}`;
						}
					}
					if (o.records) {
						const job_r = { files: [], cases: [], recorded: { modules: [plan.module] } };
						const [b, g] = await Promise.all([count(new Map(), job_r), count(tree, job_r)]);
						// recorded growth replays top-level functions: their ids carry no shape hash
						const grows = (rep: Report | null) =>
							((rep as unknown as RecordedGrowthReport | null)?.functions ?? []).some(
								(x) => x.grows && (x.id === f.id || causes(x).some((p) => p.id === f.id))
							);
						if (g.report && grows(g.report) && !grows(b.report)) {
							r.status = 'caught';
							r.by = 'recorded growth';
							return;
						}
					}
					if (!noticed) {
						r.note = 'the cases never run its loop: their input never takes that path';
						return;
					}
					// would a scale on the hottest case without one catch it?
					const plain = cases
						.filter((k) => !scaled.has(k))
						.sort(
							(a, b) =>
								(case_of(base, b)?.totals.steps ?? 0) - (case_of(base, a)?.totals.steps ?? 0) ||
								(a < b ? -1 : 1)
						)[0];
					if (plain) {
						const [b, g1] = await Promise.all([grow_base([plain]), grow(tree, [plain])]);
						const g = g1.report as unknown as GrowthReport | null;
						r.generic = {
							case: name_of(plain),
							base: class_of(b?.cases.find((x) => x.name === name_of(plain))),
							mutant: class_of(g?.cases.find((x) => x.name === name_of(plain)))
						};
					}
					r.note =
						scale_keys.length === 0
							? 'no case that runs it declares `scale`'
							: 'the cases that declare `scale` do not grow what its loop walks';
				})
			);
			return out;
		}

		await Promise.all(tasks);

		// 6. the report
		const weights = o.weights ?? null;
		const basis = basis_of(weights);
		const traffic = traffic_unit(weights);
		const ctx = cost_context(load_weights(), o.requests_per_day);
		const weight_of = (item: Item): FunctionWeightInfo => {
			const key = canonical_function(item.plan.module, item.f.path);
			const w = weights?.functions[key];
			if (basis === 'real traffic') {
				const c = traffic && w ? exposure_cost(w[traffic.key], traffic, 'total', ctx) : null;
				if (c)
					return { basis, value: c.cpu_s_per_day, text: `doubling it would cost ${cost_text(c)}` };
			}
			if (basis !== 'steps' && w) {
				let best = 0;
				let unit = '';
				for (const [u, fw] of Object.entries(w)) {
					if (weights!.units[u]?.traffic) continue;
					if (fw.inclusive_steps > best) {
						best = fw.inclusive_steps;
						unit = u;
					}
				}
				if (best > 0)
					return {
						basis: 'app weights',
						value: -1 / (1 + best),
						text: `${Math.round(best).toLocaleString('en-US')} steps per ${unit} in the app scenarios`
					};
			}
			const steps = incl.get(item.key) ?? 0;
			return {
				basis: 'steps',
				value: -1 - 1 / (1 + steps + (item.f.end_line - item.f.line) * 1e-6),
				text:
					steps > 0
						? `${Math.round(steps).toLocaleString('en-US')} inclusive steps in the bench cases`
						: `not in the bench cases (${item.f.end_line - item.f.line + 1} lines)`
			};
		};
		const functions: FunctionResult[] = [];
		for (const item of items) {
			const evaluated = results.get(item);
			const mutants: MutantResult[] = item.mutants.map((m, i) => {
				if (evaluated) return evaluated[i];
				const status: MutantStatus = item.cases.length === 0 ? 'unreached' : 'skipped';
				return {
					operator: m.operator,
					line: m.line,
					what: m.what,
					status,
					by: null,
					loud: null,
					delta_steps: null,
					delta_share: null,
					note:
						status === 'unreached'
							? 'no bench case runs it'
							: chosen.has(item)
								? 'the recount budget ran out'
								: 'not in the sample'
				};
			});
			functions.push({
				id: item.f.id,
				module: item.plan.module,
				path: item.f.path,
				package: package_name(item.plan.module),
				line: item.f.line,
				end_line: item.f.end_line,
				cases: item.cases,
				scale_cases: item.cases.filter((k) => scaled.has(k)),
				calls: calls.get(item.key) ?? 0,
				inclusive_steps: Math.round((incl.get(item.key) ?? 0) * 1e3) / 1e3,
				sampled: chosen.has(item),
				skip: item.f.skip,
				mutants,
				weight: weight_of(item)
			});
		}

		// scores per package and operator, then overall
		const packages = [...new Set(functions.map((f) => f.package))].sort();
		const package_scores: PackageScore[] = [];
		const strata = new Map<Operator, Array<{ s: Score; reached: number }>>();
		for (const p of packages) {
			const fs = functions.filter((f) => f.package === p);
			const scores = {} as Record<Operator, Score>;
			for (const op of operators) {
				const s = empty_score();
				let reached_total = 0;
				for (const f of fs) {
					for (const m of f.mutants) {
						if (m.operator !== op) continue;
						s.mutants++;
						if (m.status === 'unreached') {
							s.unreached++;
							continue;
						}
						reached_total++;
						if (m.status === 'caught') s.caught++;
						else if (m.status === 'missed') s.missed++;
						else if (m.status === 'discarded') s.discarded++;
						else if (m.status === 'invalid') s.invalid++;
						else s.skipped++;
						if (m.loud) s.loud++;
					}
				}
				scores[op] = score_of([{ s, reached: reached_total }]);
				strata.set(op, [...(strata.get(op) ?? []), { s, reached: reached_total }]);
			}
			package_scores.push({
				package: p,
				functions: fs.length,
				reached: fs.filter((f) => f.cases.length > 0).length,
				scores
			});
		}
		const totals = {} as Record<Operator, Score>;
		for (const op of operators) totals[op] = score_of(strata.get(op) ?? []);

		// the missed functions, by what they weigh, each with a case that would catch it
		const missed_rank = functions
			.filter((f) => f.mutants.some((m) => m.status === 'missed' || m.status === 'unreached'))
			.sort((a, b) => b.weight.value - a.weight.value || (a.id < b.id ? -1 : 1));
		const plan_of = new Map(items.map((i) => [i.f.id, i]));
		const missed: MissedFunction[] = [];
		const room = o.suggestions ?? 20;
		for (const f of missed_rank) {
			const ops = f.mutants
				.filter((m) => m.status === 'missed' || m.status === 'unreached')
				.map((m) => m.operator);
			const item = plan_of.get(f.id)!;
			const s = missed.length < room ? suggest(f, item.plan, item.f, files, root, runs) : null;
			if (s) f.suggestion = s.text;
			missed.push({
				id: f.id,
				package: f.package,
				operators: ops,
				reason: s?.reason ?? (f.cases.length === 0 ? 'no bench case runs it' : 'missed'),
				weight: f.weight,
				suggestion: s?.text ?? null
			});
		}

		const report: MutationReport = {
			schema: MUTATION_SCHEMA,
			seed,
			sample: {
				mode: sample === 'all' ? 'all' : 'sample',
				size: sample === 'all' ? reached.length : sample,
				evaluated: results.size,
				reached: reached.length,
				functions: items.length
			},
			operators: [...operators],
			sizes,
			cap,
			basis,
			totals,
			packages: package_scores,
			functions,
			missed,
			unmatched,
			errors: result_errors,
			exhausted,
			cost: { ms: Date.now() - started, ...cost }
		};
		log(
			`mutate: ${results.size} function(s) mutated, ${cost.recounts} recount(s) (${cost.growth} growth), ${cost.reused} reused, ${cost.cached} from earlier runs, ${Math.round((Date.now() - started) / 1000)} s`
		);
		return report;
	} finally {
		await Promise.allSettled(memo.values());
		lanes.remove();
		if (own_work) remove_tree(work);
	}
}
