import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cases, set_current_file } from './bench.ts';
import type { BenchCase } from './bench.ts';
import { register_abax } from './loader/register.ts';
import type { LoaderConfig } from './loader/register.ts';
import { get_runtime, same_counts } from './runtime/index.ts';
import type { Snapshot } from './runtime/index.ts';
import { Builtins } from './runtime/builtins.ts';
import { Determinism } from './runtime/determinism.ts';
import type { IoMode } from './runtime/determinism.ts';
import { REPORT_SCHEMA, build_case_report } from './report.ts';
import { load_prices } from './prices.ts';
import { apply_estimates } from './calibrate/estimate.ts';
import { fresh_copy, next_generation, positions } from './fresh.ts';
import { GENERATION } from './loader/core.ts';
import type { CaseReport, Report } from './report.ts';

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
		const c = fresh ? await fresh() : case_;
		const ctx = c.setup ? await c.setup() : undefined;
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
			if (settled.stuck) throw new Error('abax: the case never finished (waits on real IO?)');
			await work;
		} catch (e) {
			failure = e;
		} finally {
			builtins.uninstall();
			det.close();
		}
		const snap = rt.snapshot();
		if (c.teardown) await c.teardown(ctx);
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
		register_abax({ root, deps: opts.deps, svelte: opts.svelte });
		registered = { root };
	} else if (registered.root !== root) {
		throw new Error('abax: one process measures one root');
	}
	const rt = get_runtime();
	const builtins = new Builtins(rt);
	const det = new Determinism();

	const start = cases().length;
	// Each call imports its own copy of the bench files (and what they import): a second call in
	// the same process finds its cases again and starts from fresh module state.
	const gen = `?${GENERATION}${next_generation()}`;
	for (const f of opts.files) {
		const abs = resolve(f);
		set_current_file(relative(root, abs).split(sep).join('/'));
		await import(pathToFileURL(abs).href + gen);
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
			results.push(
				build_case_report(rt, a.snap, {
					name: c.name,
					file: c.file,
					stable,
					timers: a.timers,
					runaway: a.runaway,
					error: null
				})
			);
			log(`${stable ? 'ok      ' : 'UNSTABLE'} ${c.name}  ${Math.round(a.snap.steps)} steps`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
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
		git: {
			sha: opts.sha ?? git(root, ['rev-parse', 'HEAD']),
			prefix: toplevel ? relative(toplevel, root).split(sep).join('/') : ''
		},
		cases: results
	};
	apply_estimates(report);
	if (opts.out) writeFileSync(opts.out, JSON.stringify(report, null, '\t') + '\n');
	return report;
}
