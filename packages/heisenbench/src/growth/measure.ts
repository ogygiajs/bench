import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cases, set_current_file } from '../bench.ts';
import type { BenchCase } from '../bench.ts';
import { register_heisenbench } from '../loader/register.ts';
import type { LoaderConfig } from '../loader/register.ts';
import { get_runtime, same_counts } from '../runtime/index.ts';
import type { Runtime, Snapshot } from '../runtime/index.ts';
import { Builtins } from '../runtime/builtins.ts';
import { Determinism } from '../runtime/determinism.ts';
import type { IoMode } from '../runtime/determinism.ts';
import { one_line } from '../report.ts';
import type { CaseWatch } from '../cache/index.ts';

/*
 * Counting a case on an input of our choosing (growth and slow-input search). The case runs in the
 * same deterministic window as `heisenbench run` (frozen clock, seeded random, fake timers, priced
 * built-ins); only the input differs: it is handed in instead of coming from the case's setup.
 */

const LOADER = Symbol.for('heisenbench.measure.loader');

export interface LoadOptions {
	files: string[];
	root?: string;
	deps?: LoaderConfig['deps'];
	svelte?: LoaderConfig['svelte'];
	filter?: string;
	log?: (line: string) => void;
}

/** Register the counting loader, once per process; the run root. */
export function register_loader(opts: Pick<LoadOptions, 'root' | 'deps' | 'svelte'>): string {
	const root = resolve(opts.root ?? process.cwd());
	const g = globalThis as unknown as Record<symbol, string | undefined>;
	if (g[LOADER] === undefined) {
		register_heisenbench({ root, deps: opts.deps, svelte: opts.svelte });
		g[LOADER] = root;
	} else if (g[LOADER] !== root) {
		throw new Error('heisenbench: one process measures one root');
	}
	return root;
}

/** Import bench files (paths relative to the cwd or absolute); every case they define. */
export async function import_cases(
	files: readonly string[],
	root: string,
	log: (line: string) => void = console.error,
	failed?: (file: string) => void
): Promise<BenchCase[]> {
	const start = cases().length;
	for (const f of files) {
		const abs = resolve(root, f);
		const file = relative(root, abs).split(sep).join('/');
		set_current_file(file);
		try {
			await import(pathToFileURL(abs).href);
		} catch (e) {
			// One file that does not load costs only its own cases.
			log(`FAILED   ${file}: ${one_line(e)}`);
			failed?.(file);
		}
	}
	return cases().slice(start);
}

/** Register the counting loader (once per process) and import the bench files. */
export async function load_cases(opts: LoadOptions): Promise<BenchCase[]> {
	const root = register_loader(opts);
	let list = await import_cases(
		opts.files.map((f) => resolve(f)),
		root,
		opts.log ?? console.error
	);
	if (opts.filter) list = list.filter((c) => c.name.includes(opts.filter!));
	return list;
}

export class Measurer {
	rt: Runtime;
	builtins: Builtins;
	det: Determinism;
	/** Incremental counting watches what each run ran (cache/capture.ts). */
	watch?: CaseWatch;
	/**
	 * A fresh copy of a case (fresh.ts), taken before each run of `steps`: its module state starts
	 * empty, so what an earlier case or size left in a memo or a lazily built table cannot make
	 * this run cheaper. None: every run shares the copy the bench file loaded.
	 */
	fresh?: (c: BenchCase) => Promise<BenchCase>;

	/** `root`: the run root, shown as VIRTUAL_ROOT inside the window (determinism.ts). */
	constructor(root?: string) {
		this.rt = get_runtime();
		this.builtins = new Builtins(this.rt);
		this.det = new Determinism({ root: resolve(root ?? process.cwd()) });
	}

	/**
	 * One run of `c` on `ctx`. Throws what the case throws; past `cap` steps, a StepCapError (the
	 * input makes it run forever, or close to it).
	 */
	async once(c: BenchCase, ctx: unknown, mode: IoMode, cap = Infinity): Promise<Snapshot> {
		const { rt, det, builtins } = this;
		this.watch?.before_window();
		rt.reset();
		rt.cap = cap;
		det.open(mode);
		builtins.install();
		let failure: unknown = null;
		try {
			let finished = false;
			const work = Promise.resolve()
				.then(() => c.fn(ctx))
				.finally(() => {
					finished = true;
				});
			work.catch(() => {});
			const settled = await det.settle(() => finished);
			if (settled.stuck)
				throw new Error('heisenbench: the case never finished (waits on real IO?)');
			await work;
		} catch (e) {
			failure = e;
		} finally {
			rt.cap = Infinity;
			builtins.uninstall();
			det.close();
		}
		const snap = rt.snapshot();
		this.watch?.after_window(snap);
		if (c.teardown) await c.teardown(ctx);
		det.drain_finalizers();
		if (failure) throw failure;
		return snap;
	}

	/**
	 * Steps of `c` on inputs from `make` (called before every run, outside the window): a recording
	 * run, then two measured runs that must count exactly the same.
	 */
	async steps(
		c: BenchCase,
		make: (c: BenchCase) => unknown,
		cap = Infinity
	): Promise<{ steps: number; stable: boolean; snap: Snapshot }> {
		const run = async (mode: IoMode): Promise<Snapshot> => {
			const cc = this.fresh ? await this.fresh(c) : c;
			return this.once(cc, await make(cc), mode, cap);
		};
		await run('record');
		const a = await run('replay');
		const b = await run('replay');
		return { steps: a.steps, stable: same_counts(a, b), snap: a };
	}
}
