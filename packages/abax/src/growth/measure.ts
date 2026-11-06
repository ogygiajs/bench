import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cases, set_current_file } from '../bench.ts';
import type { BenchCase } from '../bench.ts';
import { register_abax } from '../loader/register.ts';
import type { LoaderConfig } from '../loader/register.ts';
import { get_runtime, same_counts } from '../runtime/index.ts';
import type { Runtime, Snapshot } from '../runtime/index.ts';
import { Builtins } from '../runtime/builtins.ts';
import { Determinism } from '../runtime/determinism.ts';
import type { IoMode } from '../runtime/determinism.ts';

/*
 * Counting a case on an input of our choosing (growth and slow-input search). The case runs in the
 * same deterministic window as `abax run` (frozen clock, seeded random, fake timers, priced
 * built-ins); only the input differs: it is handed in instead of coming from the case's setup.
 */

const LOADER = Symbol.for('abax.measure.loader');

export interface LoadOptions {
	files: string[];
	root?: string;
	deps?: LoaderConfig['deps'];
	svelte?: LoaderConfig['svelte'];
	filter?: string;
}

/** Register the counting loader (once per process) and import the bench files. */
export async function load_cases(opts: LoadOptions): Promise<BenchCase[]> {
	const root = resolve(opts.root ?? process.cwd());
	const g = globalThis as unknown as Record<symbol, string | undefined>;
	if (g[LOADER] === undefined) {
		register_abax({ root, deps: opts.deps, svelte: opts.svelte });
		g[LOADER] = root;
	} else if (g[LOADER] !== root) {
		throw new Error('abax: one process measures one root');
	}
	const start = cases().length;
	for (const f of opts.files) {
		const abs = resolve(f);
		set_current_file(relative(root, abs).split(sep).join('/'));
		await import(pathToFileURL(abs).href);
	}
	let list = cases().slice(start);
	if (opts.filter) list = list.filter((c) => c.name.includes(opts.filter!));
	return list;
}

export class Measurer {
	rt: Runtime;
	builtins: Builtins;
	det: Determinism;

	constructor() {
		this.rt = get_runtime();
		this.builtins = new Builtins(this.rt);
		this.det = new Determinism();
	}

	/** One run of `c` on `ctx`. Throws what the case throws. */
	async once(c: BenchCase, ctx: unknown, mode: IoMode): Promise<Snapshot> {
		const { rt, det, builtins } = this;
		rt.reset();
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
		return snap;
	}

	/**
	 * Steps of `c` on inputs from `make` (called before every run, outside the window): a recording
	 * run, then two measured runs that must count exactly the same.
	 */
	async steps(c: BenchCase, make: () => unknown): Promise<{ steps: number; stable: boolean }> {
		await this.once(c, await make(), 'record');
		const a = await this.once(c, await make(), 'replay');
		const b = await this.once(c, await make(), 'replay');
		return { steps: a.steps, stable: same_counts(a, b) };
	}
}
