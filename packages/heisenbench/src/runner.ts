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
import { REPORT_SCHEMA, build_case_report, environment, one_line } from './report.ts';
import type { LoadError } from './report.ts';
import { load_prices } from './prices.ts';
import { apply_estimates } from './calibrate/estimate.ts';
import { fresh_copy, next_generation, positions } from './fresh.ts';
import { GENERATION } from './loader/core.ts';
import type { CaseReport, Report } from './report.ts';
import { package_shares } from './identity.ts';

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
	/** Commit the code was measured at (default: `git rev-parse HEAD` in root, if any). */
	sha?: string | null;
	out?: string;
	log?: (line: string) => void;
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
	fresh?: () => Promise<BenchCase>
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
	if (!registered) {
		register_heisenbench({ root, deps: opts.deps, svelte: opts.svelte });
		registered = { root };
	} else if (registered.root !== root) {
		throw new Error('heisenbench: one process measures one root');
	}
	const rt = get_runtime();
	const builtins = new Builtins(rt);
	const det = new Determinism({ root });

	const start = cases().length;
	// Each call imports its own copy of the bench files (and what they import): a second call in
	// the same process finds its cases again and starts from fresh module state. A file that does
	// not load is reported and costs only its own cases.
	const gen = `?${GENERATION}${next_generation()}`;
	const load_errors: LoadError[] = [];
	for (const f of opts.files) {
		const abs = resolve(f);
		const file = relative(root, abs).split(sep).join('/');
		set_current_file(file);
		const before = cases().length;
		try {
			await import(pathToFileURL(abs).href + gen);
			if (cases().length === before) log(`NO CASES ${file}: it never calls bench()`);
		} catch (e) {
			const error = one_line(e);
			load_errors.push({ file, error });
			log(`FAILED   ${file}: ${error}`);
		}
	}
	let list = cases().slice(start);
	const position = positions(list);
	if (opts.filter) list = list.filter((c) => c.name.includes(opts.filter!));

	const results: CaseReport[] = [];
	for (const c of list) {
		try {
			const fresh =
				opts.fresh === false ? undefined : () => fresh_copy(c, root, position.get(c) ?? 0);
			const { a, stable } = await run_case(c, det, builtins, fresh);
			const r = build_case_report(rt, a.snap, {
				name: c.name,
				file: c.file,
				stable,
				timers: a.timers,
				runaway: a.runaway,
				error: null
			});
			results.push(r);
			const shares = package_shares(r.functions);
			log(
				`${stable ? 'ok      ' : 'UNSTABLE'} ${c.name}  ${Math.round(a.snap.steps)} steps${shares ? ` (${shares})` : ''}`
			);
		} catch (e) {
			const msg = one_line(e);
			results.push({
				name: c.name,
				file: c.file,
				stable: false,
				timers: 0,
				runaway_timers: false,
				error: msg,
				totals: { steps: 0, allocations: 0, bytes: 0, calls: 0 },
				functions: [],
				edges: []
			});
			log(`FAILED   ${c.name}: ${msg}`);
		}
	}

	const toplevel = git(root, ['rev-parse', '--show-toplevel']);
	const report: Report = {
		schema: REPORT_SCHEMA,
		prices: { version: rt.prices.version, hash: load_prices().hash },
		node: process.version,
		env: environment(),
		git: {
			sha: opts.sha ?? git(root, ['rev-parse', 'HEAD']),
			prefix: toplevel ? relative(toplevel, root).split(sep).join('/') : ''
		},
		cases: results
	};
	if (load_errors.length > 0) report.load_errors = load_errors;
	apply_estimates(report);
	if (opts.out) writeFileSync(opts.out, JSON.stringify(report, null, '\t') + '\n');
	return report;
}
