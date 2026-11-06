import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSync } from 'oxc-parser';
import { cases, set_current_file } from '../bench.ts';
import type { BenchCase } from '../bench.ts';
import { LoaderCore } from '../loader/core.ts';
import { Determinism } from '../runtime/determinism.ts';
import type { IoMode } from '../runtime/determinism.ts';
import {
	compile_svelte,
	is_svelte_module,
	is_ts,
	module_id,
	strip_types
} from '../transform/index.ts';
import { private_bindings } from '../transform/instrument.ts';
import { calibrate, decode, natives } from './natives.ts';
import type { Tier } from './types.ts';

/*
 * The engine-health child (spec 5). Runs with --allow-natives-syntax and V8 logging; never
 * instrumented. Measured modules get only the `__abax` export appended (bench files import private
 * functions through it), at the end of the module, so every offset V8 reports is the source's own.
 *
 * Protocol for one case, every run in the deterministic environment (frozen clock, seeded random,
 * fake timers, replayed IO):
 *   1. `warmup` runs: V8 tiers code up on its own.
 *   2. Every reachable function (exports, `__abax` members, class methods) is prepared and marked
 *      to optimize on its next call: the fixed point.
 *   3. One run (the forced optimization happens here), then `runs` more.
 *   4. The optimization status of each reachable function, decoded into plain words.
 * Each run is wrapped in log markers so the parent knows what ran inside a measuring window.
 */

export interface ChildConfig {
	root: string;
	files: string[];
	/** null: only list the cases. */
	case: { name: string; index: number } | null;
	warmup: number;
	runs: number;
	deps: boolean | string[];
	svelte: 'server' | 'client';
	out: string;
}

export interface ChildModule {
	url: string;
	path: string;
	id: string;
	code: string;
	map: unknown;
}

export interface ChildReachable {
	name: string;
	script_id: number;
	position: number;
	tier: Tier;
}

export interface ChildResult {
	cases: Array<{ name: string; file: string }>;
	modules: ChildModule[];
	reachable: ChildReachable[];
	error: string | null;
	v8: string;
}

function with_private_export(code: string, filename: string): string {
	const parsed = parseSync(filename, code, { sourceType: 'module', lang: 'js' });
	if (parsed.errors.length > 0) return code;
	const bindings = private_bindings(
		parsed.program as unknown as Parameters<typeof private_bindings>[0]
	);
	if (bindings.some((b) => b.name === '__abax')) return code;
	const props = bindings.map((b) => (b.live ? `get ${b.name}(){return ${b.name}}` : b.name));
	return `${code}\nexport const __abax={${props.join(',')}};\n`;
}

function register(config: ChildConfig, modules: ChildModule[]): void {
	const core = new LoaderCore({ root: config.root, deps: config.deps, svelte: config.svelte });
	const plain = (url: string, source: string, format: string | null | undefined): string | null => {
		const path = fileURLToPath(url);
		let code: string;
		let map: unknown = null;
		if (is_svelte_module(path)) {
			const out = compile_svelte(source, path, config.svelte);
			code = out.code;
			map = out.map;
		} else if (format === 'module-typescript' || (format == null && is_ts(path))) {
			code = strip_types(source);
		} else if (format === 'module') {
			code = source;
		} else {
			return null;
		}
		code = with_private_export(code, path);
		modules.push({ url, path, id: module_id(path, config.root), code, map });
		return code;
	};
	registerHooks({
		load(url, context, next) {
			if (!core.should_instrument(url)) return next(url, context);
			if (core.needs_own_read(url)) {
				return {
					format: 'module',
					source: plain(url, core.read(url), null) ?? '',
					shortCircuit: true
				};
			}
			const r = next(url, context);
			if (r.source == null) return r;
			const src =
				typeof r.source === 'string'
					? r.source
					: Buffer.from(r.source as Uint8Array).toString('utf8');
			const code = plain(url, src, r.format);
			if (code === null) return r;
			return { format: 'module', source: code, shortCircuit: true };
		}
	});
}

const fn_source = Function.prototype.toString;

/**
 * A function with source code: what V8 can be asked to optimize. A bound function, a function
 * proxy or a built-in (an export like `const parse = JSON.parse`) prints `[native code]`, and
 * handing one to %PrepareFunctionForOptimization aborts the process.
 */
function has_source(v: unknown): v is (...args: unknown[]) => unknown {
	if (typeof v !== 'function') return false;
	try {
		return !fn_source.call(v).endsWith('[native code] }');
	} catch {
		return false;
	}
}

/** Functions reachable from a module namespace: exports, `__abax` members and class members. */
function reachable_from(ns: Record<string, unknown>, out: Set<unknown>): void {
	const add_class_members = (c: object): void => {
		for (const owner of [c, (c as { prototype?: object }).prototype]) {
			if (!owner) continue;
			for (const key of Reflect.ownKeys(owner)) {
				const d = Object.getOwnPropertyDescriptor(owner, key);
				if (!d) continue;
				for (const v of [d.value, d.get, d.set]) {
					if (has_source(v) && v !== c) out.add(v);
				}
			}
		}
	};
	const add = (v: unknown, depth: number): void => {
		if (has_source(v)) {
			if (out.has(v)) return;
			out.add(v);
			add_class_members(v);
		} else if (v !== null && typeof v === 'object' && depth === 0) {
			const proto = Object.getPrototypeOf(v);
			if (proto !== Object.prototype && proto !== null) return;
			// `__abax` and plain-object exports: their members (getters are live bindings: read them)
			for (const key of Object.keys(v)) add((v as Record<string, unknown>)[key], 1);
		}
	};
	for (const key of Object.keys(ns)) add(ns[key], 0);
}

async function main(): Promise<void> {
	const config = JSON.parse(readFileSync(process.argv[2], 'utf8')) as ChildConfig;
	const n = natives();
	const bits = calibrate(n);
	const modules: ChildModule[] = [];
	const result: ChildResult = {
		cases: [],
		modules,
		reachable: [],
		error: null,
		v8: process.versions.v8
	};
	register(config, modules);

	for (const f of config.files) {
		const abs = resolve(config.root, f);
		set_current_file(relative(config.root, abs).split(sep).join('/'));
		await import(pathToFileURL(abs).href);
	}
	const all = cases();
	result.cases = all.map((c) => ({ name: c.name, file: c.file }));
	if (!config.case) {
		writeFileSync(config.out, JSON.stringify(result));
		return;
	}
	const wanted = config.case;
	const c: BenchCase | undefined = all.filter((x) => x.name === wanted.name)[wanted.index];
	if (!c) throw new Error(`abax: no case ${wanted.name}`);

	const reach = new Set<unknown>();
	const loaded = modules.length;
	for (let i = 0; i < loaded; i++) {
		reachable_from((await import(modules[i].url)) as Record<string, unknown>, reach);
	}

	const det = new Determinism();
	// Compiling a new script logs its source: a marker in the V8 log, in order with everything else.
	const mark = (what: string): void => {
		new Function(`"abax:${what}"`);
	};
	let window = 0;
	const run = async (mode: IoMode): Promise<void> => {
		const ctx = c.setup ? await c.setup() : undefined;
		const w = window++;
		mark(`open:${w}`);
		det.open(mode);
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
			det.close();
			mark(`close:${w}`);
		}
		if (c.teardown) await c.teardown(ctx);
		det.drain_finalizers();
		if (failure) throw failure;
	};

	try {
		for (let i = 0; i < config.warmup; i++) await run(i === 0 ? 'record' : 'replay');
		for (const f of reach) {
			try {
				n.prepare(f);
				n.optimize(f);
			} catch {
				// not optimizable (bound or native functions): skipped
			}
		}
		for (let i = 0; i <= config.runs; i++) await run('replay');
		for (const f of reach) {
			let script_id = -1;
			let position = -1;
			try {
				script_id = n.script_id(f);
				position = n.position(f);
			} catch {
				continue;
			}
			result.reachable.push({
				name: (f as { name?: string }).name ?? '',
				script_id,
				position,
				tier: decode(n.status(f), bits)
			});
		}
	} catch (e) {
		result.error = e instanceof Error ? e.message : String(e);
	}
	writeFileSync(config.out, JSON.stringify(result));
}

await main();
