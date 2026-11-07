import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cases, set_current_file } from './bench.ts';
import type { BenchCase } from './bench.ts';
import { register_heisenbench } from './loader/register.ts';
import type { LoaderConfig } from './loader/register.ts';
import { get_runtime, same_counts } from './runtime/index.ts';
import type { Snapshot } from './runtime/index.ts';
import { Builtins } from './runtime/builtins.ts';
import { Determinism } from './runtime/determinism.ts';
import type { IoMode } from './runtime/determinism.ts';
import { REPORT_SCHEMA, build_case_report, environment, error_frames, one_line } from './report.ts';
import type { LoadError } from './report.ts';
import { SIZE_TERMS, load_prices } from './prices.ts';
import { apply_estimates } from './calibrate/estimate.ts';
import { fresh_copy, next_generation, positions } from './fresh.ts';
import { GENERATION } from './loader/core.ts';
import type { CaseReport, Report } from './report.ts';
import { package_shares } from './identity.ts';
import { CaseCache, RUN_LAYER, run_incremental } from './cache/index.ts';
import type { CaseWatch } from './cache/index.ts';

export interface RunOptions {
	files: string[];
	/** Report paths are relative to this directory (default: cwd). */
	root?: string;
	deps?: LoaderConfig['deps'];
	svelte?: LoaderConfig['svelte'];
	/** Fresh module state for every run of a case (fresh.ts). Default true. */
	fresh?: boolean;
	/** Only cases whose name contains this. */
	filter?: string;
	/** Only the cases with exactly these names (blame/ recounts the regressed cases alone). */
	names?: readonly string[];
	/** Commit the code was measured at (default: `git rev-parse HEAD` in root, if any). */
	sha?: string | null;
	out?: string;
	log?: (line: string) => void;
	/** Log every frame of a failure the report keeps, not only the first. */
	debug?: boolean;
	/**
	 * A commit (any name git takes) whose code these bench files count: every counted file it has
	 * is read as it is there, the bench files and what only the working tree has from disk
	 * (LoaderConfig `source_from`). The report is that commit's.
	 */
	source_from?: string;
	/**
	 * Incremental counting (cache/): reuse the counts of every case whose key is in `dir`, count
	 * the rest and add them. `verify`: how many reused cases to count again as a check. Not with
	 * `source_from`: the key hashes the files on disk.
	 */
	cache?: { dir: string; verify?: number };
}

/** The commit `rev` names in the git repository around `root`, and that repository's top level. */
export function source_commit(root: string, rev: string): { sha: string; top: string } {
	const top = git(root, ['rev-parse', '--show-toplevel']);
	if (top === null)
		throw new Error(`heisenbench: --source-from needs a git checkout; ${root} is not in one`);
	const sha = git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
	if (!sha) throw new Error(`heisenbench: --source-from ${rev}: no such commit (fetch it first)`);
	return { sha, top };
}

/** After a FAILED line: ` (at <first frame>)`, or with `all` every frame on a line of its own. */
function where_lines(frames: readonly string[], all: boolean): string {
	if (frames.length === 0) return '';
	if (!all) return ` (at ${frames[0]})`;
	return frames.map((f) => `\n           at ${f}`).join('');
}

let registered: { root: string } | null = null;

function git(root: string, args: string[]): string | null {
	try {
		return execFileSync('git', args, {
			cwd: root,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
	} catch {
		return null;
	}
}

const real_set_timeout = setTimeout;
const real_clear_timeout = clearTimeout;

/**
 * How long setup, teardown or a fresh import may take (outside the measuring window, on the real
 * clock). The measured call has its own check: a call that waits on nothing the fake loop
 * controls is reported as never finishing.
 */
export const OUTSIDE_LIMIT_MS = 5 * 60_000;

/** `p`, or an error naming `what` when it has not settled within OUTSIDE_LIMIT_MS. */
function within<T>(p: Promise<T>, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const limit = new Promise<never>((_, reject) => {
		timer = real_set_timeout(
			() =>
				reject(
					new Error(`heisenbench: ${what} did not finish within ${OUTSIDE_LIMIT_MS / 1000} s`)
				),
			OUTSIDE_LIMIT_MS
		);
		timer.unref?.();
	});
	return Promise.race([p, limit]).finally(() => real_clear_timeout(timer));
}

interface RunResult {
	snap: Snapshot;
	timers: number;
	runaway: boolean;
}

/**
 * One case, deterministic: a warm-up run that records IO (and warms module caches), then two
 * measured runs in identical fresh environments. Counts must match exactly, else "unstable".
 */
export async function run_case(
	case_: BenchCase,
	det: Determinism,
	builtins: Builtins,
	/** A fresh copy of the case (fresh.ts), taken before each run; none: one copy for all runs. */
	fresh?: () => Promise<BenchCase>,
	/** Incremental counting watches what the case runs (cache/capture.ts). */
	watch?: CaseWatch
): Promise<{
	a: RunResult;
	/** The second measured run (the self-check compares it with `a`). */
	b: RunResult;
	stable: boolean;
}> {
	const rt = builtins.runtime;
	const once = async (mode: IoMode): Promise<RunResult> => {
		const c = fresh ? await within(fresh(), 'loading a fresh copy of the bench file') : case_;
		const ctx = c.setup ? await within(Promise.resolve(c.setup()), 'setup') : undefined;
		watch?.before_window();
		rt.reset();
		det.open(mode);
		builtins.install();
		let failure: unknown = null;
		let settled = { timers: 0, runaway: false, stuck: false };
		try {
			// The case runs alongside the fake event loop: it may itself wait on fake timers.
			let finished = false;
			const work = Promise.resolve()
				.then(() => c.fn(ctx))
				.finally(() => {
					finished = true;
				});
			work.catch(() => {});
			settled = await det.settle(() => finished);
			if (settled.stuck)
				throw new Error('heisenbench: the case never finished (waits on real IO?)');
			await work;
		} catch (e) {
			failure = e;
		} finally {
			builtins.uninstall();
			det.close();
		}
		const snap = rt.snapshot();
		watch?.after_window(snap);
		if (c.teardown) await within(Promise.resolve(c.teardown(ctx)), 'teardown');
		det.drain_finalizers();
		if (failure) throw failure;
		return { snap, timers: settled.timers, runaway: settled.runaway };
	};
	await once('record');
	const a = await once('replay');
	const b = await once('replay');
	return { a, b, stable: same_counts(a.snap, b.snap) };
}

export async function run_benches(opts: RunOptions): Promise<Report> {
	const root = resolve(opts.root ?? process.cwd());
	const log = opts.log ?? (() => {});
	const source_from = opts.source_from ? source_commit(root, opts.source_from) : undefined;
	if (!registered) {
		register_heisenbench({ root, deps: opts.deps, svelte: opts.svelte, source_from });
		registered = { root };
	} else if (registered.root !== root) {
		throw new Error('heisenbench: one process measures one root');
	}
	const rt = get_runtime();
	const builtins = new Builtins(rt);
	const det = new Determinism({ root });
	if (opts.cache && source_from)
		throw new Error('heisenbench: --cache keys the files on disk; it does not go with --source-from');
	// Before any bench file loads: the cache watches every module that does.
	const cache = opts.cache
		? new CaseCache(
				opts.cache.dir,
				{
					root,
					deps: opts.deps ?? true,
					svelte: opts.svelte ?? 'server',
					fresh: opts.fresh !== false
				},
				rt,
				RUN_LAYER
			)
		: null;

	// Each call imports its own copy of the bench files (and what they import): a second call in
	// the same process finds its cases again and starts from fresh module state. A file that does
	// not load is reported and costs only its own cases.
	const gen = `?${GENERATION}${next_generation()}`;
	const load_errors: LoadError[] = [];
	const position = new Map<BenchCase, number>();
	const load = async (files: readonly string[]): Promise<BenchCase[]> => {
		const start = cases().length;
		for (const f of files) {
			const abs = resolve(root, f);
			const file = relative(root, abs).split(sep).join('/');
			set_current_file(file);
			const before = cases().length;
			try {
				await import(pathToFileURL(abs).href + gen);
				if (cases().length === before) log(`NO CASES ${file}: it never calls bench()`);
			} catch (e) {
				const error = one_line(e);
				const frames = error_frames(e, root);
				load_errors.push(frames.length > 0 ? { file, error, stack: frames } : { file, error });
				log(`FAILED   ${file}: ${error}${where_lines(frames, opts.debug === true)}`);
			}
		}
		const added = cases().slice(start);
		for (const [c, n] of positions(added)) position.set(c, n);
		return added;
	};
	const named = opts.names ? new Set(opts.names) : null;
	const wanted = (name: string): boolean =>
		(!opts.filter || name.includes(opts.filter)) && (named === null || named.has(name));

	const count = async (c: BenchCase, watch?: CaseWatch): Promise<CaseReport> => {
		try {
			const fresh =
				opts.fresh === false ? undefined : () => fresh_copy(c, root, position.get(c) ?? 0);
			const { a, stable } = await run_case(c, det, builtins, fresh, watch);
			const r = build_case_report(rt, a.snap, {
				name: c.name,
				file: c.file,
				stable,
				timers: a.timers,
				runaway: a.runaway,
				error: null
			});
			const shares = package_shares(r.functions);
			log(
				`${stable ? 'ok      ' : 'UNSTABLE'} ${c.name}  ${Math.round(a.snap.steps)} steps${shares ? ` (${shares})` : ''}`
			);
			return r;
		} catch (e) {
			const msg = one_line(e);
			const frames = error_frames(e, root);
			log(`FAILED   ${c.name}: ${msg}${where_lines(frames, opts.debug === true)}`);
			return {
				name: c.name,
				file: c.file,
				stable: false,
				timers: 0,
				runaway_timers: false,
				error: msg,
				...(frames.length > 0 ? { error_stack: frames } : {}),
				totals: { steps: 0, allocations: 0, bytes: 0, calls: 0 },
				functions: [],
				edges: []
			};
		}
	};

	const results: CaseReport[] = [];
	let summary: Report['cache'];
	if (cache) {
		const files = opts.files.map((f) => relative(root, resolve(f)).split(sep).join('/'));
		const run = await run_incremental(cache, {
			files,
			complete: !opts.filter && !opts.names,
			wanted,
			verify: opts.cache?.verify ?? 0,
			load,
			failed: (file) => load_errors.some((e) => e.file === file),
			count,
			label: (r) => `${Math.round(r.totals.steps)} steps`,
			log
		});
		results.push(...run.results);
		summary = run.summary;
	} else {
		for (const c of (await load(opts.files.map((f) => resolve(f)))).filter((c) => wanted(c.name)))
			results.push(await count(c));
	}

	const toplevel = git(root, ['rev-parse', '--show-toplevel']);
	const report: Report = {
		schema: REPORT_SCHEMA,
		prices: { version: rt.prices.version, hash: load_prices().hash },
		node: process.version,
		env: environment(),
		git: {
			sha: opts.sha ?? source_from?.sha ?? git(root, ['rev-parse', 'HEAD']),
			prefix: toplevel ? relative(toplevel, root).split(sep).join('/') : ''
		},
		cases: results,
		unit_terms: [...SIZE_TERMS]
	};
	if (load_errors.length > 0) report.load_errors = load_errors;
	if (summary) report.cache = summary;
	apply_estimates(report);
	if (opts.out) writeFileSync(opts.out, JSON.stringify(report, null, '\t') + '\n');
	return report;
}
