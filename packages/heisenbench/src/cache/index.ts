import { randomInt } from 'node:crypto';
import type { BenchCase } from '../bench.ts';
import type { CaseReport, FunctionReport } from '../report.ts';
import type { Runtime, Snapshot } from '../runtime/index.ts';
import { OWN_DIR } from '../own.ts';
import { Capture } from './capture.ts';
import { TreeHasher, abs_path, case_key, global_parts, kind_of, rel_path } from './key.ts';
import type { IoEntry, KeyOptions, ModuleEntry } from './key.ts';
import { line_at, offset_of, sha256 } from './normalize.ts';
import { CacheStore } from './store.ts';
import type { CaseManifest, Value } from './store.ts';

export { prune_cache } from './store.ts';
export type { PruneResult } from './store.ts';
export { CACHE_SCHEMA, engine_version } from './key.ts';

/*
 * Incremental counting: a case's counts are a pure function of what it ran and what it read, so
 * a case whose key (key.ts) is unchanged is not counted again. Its section comes from the cache,
 * moved onto the lines the code sits on now, and is marked `reused`.
 *
 * The key is computed from the manifest of an earlier run of the case (store.ts): the modules it
 * loaded, the functions it ran in each and the files it read, hashed as they are in this tree.
 * When a manifest of every case of a bench file still matches, the file is not even loaded.
 *
 * Two layers use it: `heisenbench run` (the counts, a CaseReport per case) and `heisenbench
 * growth` (the counts at every size, a GrowthCase). Each keys its own options in.
 *
 * Safety: `--cache-verify n` counts n of the reused cases again; a recount that differs from the
 * cache is a cache bug, and the case fails with the difference.
 */

export interface CacheSummary {
	/** Cases whose section came from the cache. */
	reused: number;
	/** Cases counted. */
	counted: number;
	/** Reused cases counted again to check the cache, and those that differed. */
	verified: number;
	mismatches: string[];
	/** Why each counted case was not reused (CaseCache.why). */
	why: Array<{ file: string; name: string; why: string[] }>;
}

/** What a layer keeps per case. */
export interface CachedCase {
	name: string;
	file: string;
	stable: boolean;
	error: string | null;
	/** Not counted again: its key was unchanged, so it came from the cache. */
	reused?: boolean;
}

export interface Layer<T extends CachedCase> {
	/** `run`, `growth`: keys and runs of one layer are apart from another's. */
	name: string;
	/** What of the layer's options changes its counts (growth: the sizes, the cap). */
	params: unknown;
	/** Every source line the section names, to be moved with the code when it is reused. */
	lines(r: T): LineRef[];
}

/** A line a section names: in which module, and how to move it. */
export interface LineRef {
	module: string;
	line: number;
	set(line: number): void;
}

/** Every line a function report names. */
export function function_lines(fs: readonly FunctionReport[]): LineRef[] {
	const out: LineRef[] = [];
	const add = <K extends string>(o: Record<K, number>, k: K, module: string): void => {
		out.push({ module, line: o[k], set: (n) => (o[k] = n) });
	};
	for (const f of fs) {
		add(f, 'line', f.module);
		add(f, 'end_line', f.module);
		for (const b of f.blocks) add(b, 'line', f.module);
		for (const s of f.sites) add(s, 'line', f.module);
		for (const b of f.builtins) add(b, 'line', f.module);
		for (const l of f.lines) add(l, 'line', f.module);
	}
	return out;
}

/** The counts of `heisenbench run`. */
export const RUN_LAYER: Layer<CaseReport> = {
	name: 'run',
	params: null,
	lines: (r) => function_lines(r.functions)
};

/** What the cache keeps of a section: no per-run layers (time, estimates), no reuse mark. */
export function cacheable<T extends CachedCase>(r: T): T {
	const { reused: _r, measure: _m, ...rest } = r as T & { measure?: unknown };
	return rest as T;
}

/** What a run tells the cache about a case as it runs (capture.ts). */
export interface CaseWatch {
	/** After setup, before the window resets the counters. */
	before_window(): void;
	after_window(snap: Snapshot): void;
}

export interface Hit<T> {
	file: string;
	name: string;
	key: string;
	report: T;
	/** The manifest as this tree has it (stored again with the run). */
	manifest: CaseManifest;
}

/** The first place two JSON values differ (`functions[3].self_steps: 120 vs 124`), or null. */
export function first_difference(a: unknown, b: unknown, at = ''): string | null {
	if (a === b) return null;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
		return `${at || '(top)'}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
	}
	if (Array.isArray(a) !== Array.isArray(b)) return `${at || '(top)'}: array vs object`;
	if (Array.isArray(a) && Array.isArray(b)) {
		for (let i = 0; i < Math.max(a.length, b.length); i++) {
			const d = first_difference(a[i], b[i], `${at}[${i}]`);
			if (d) return d;
		}
		return null;
	}
	const ao = a as Record<string, unknown>;
	const bo = b as Record<string, unknown>;
	for (const k of [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort()) {
		const d = first_difference(ao[k], bo[k], at ? `${at}.${k}` : k);
		if (d) return d;
	}
	return null;
}

export class CaseCache<T extends CachedCase> {
	readonly store: CacheStore;
	readonly hasher: TreeHasher;
	readonly capture: Capture;
	readonly root: string;
	readonly rt: Runtime;
	readonly layer: Layer<T>;
	#global: Record<string, unknown>;
	#parts: Record<string, string>;
	/** The layer's runs of a bench file are kept apart from another layer's. */
	#space: string;

	constructor(dir: string, o: KeyOptions, rt: Runtime, layer: Layer<T>) {
		this.root = o.root;
		this.rt = rt;
		this.layer = layer;
		this.store = new CacheStore(dir);
		this.hasher = new TreeHasher(o.root);
		this.capture = new Capture(rt, o.root, o.fresh);
		this.#global = this.capture.quiet(() => ({
			...global_parts(o, this.hasher),
			layer: [layer.name, layer.params]
		}));
		this.#parts = Object.fromEntries(
			Object.entries(this.#global).map(([k, v]) => [k, sha256(JSON.stringify(v)).slice(0, 16)])
		);
		this.#space = `${layer.name}:${JSON.stringify(layer.params)}:`;
	}

	/** `m` as this tree has it, with its key. */
	#now(m: CaseManifest, file: string): CaseManifest {
		const modules = m.modules.map((e) => this.hasher.current(e));
		const io = m.io.map((e) => ({ ...e, hash: this.hasher.io(e.op, e.path) }));
		const key = case_key(this.#global, file, m.name, modules, io);
		return { name: m.name, key, global: this.#parts, modules, io };
	}

	#entries(file: string): ReturnType<CacheStore['entries']> {
		return this.store.entries(this.#space + file);
	}

	/** The cached section of `m` in this tree, moved onto its lines; null when there is none. */
	#hit(file: string, stored: CaseManifest): Hit<T> | null {
		const m = this.#now(stored, file);
		const v = this.store.get_value<T>(m.key);
		if (v === null) return null;
		const report = this.#rebase(v, m);
		if (report === null) return null;
		report.reused = true;
		return { file, name: m.name, key: m.key, report, manifest: m };
	}

	#rebase(v: Value<T>, m: CaseManifest): T | null {
		const by_id = new Map(m.modules.map((e) => [e.id, e]));
		const moves = new Map<string, (line: number) => number>();
		for (const [id, l] of Object.entries(v.lines)) {
			const e = by_id.get(id);
			if (!e) return null;
			if (e.raw === l.raw) continue;
			const n = this.hasher.normalized(
				abs_path(e.path, this.root),
				e.kind === 'code' ? (e.ran ?? []) : undefined
			);
			if (n === null) return null;
			const map = new Map<number, number>();
			for (const [line, offset] of Object.entries(l.at)) {
				const to = offset === null ? null : line_at(n.table, offset);
				if (to === null) return null;
				map.set(Number(line), to);
			}
			moves.set(id, (line) => map.get(line) ?? line);
		}
		for (const ref of this.layer.lines(v.report)) {
			const to = moves.get(ref.module);
			if (to) ref.set(to(ref.line));
		}
		return v.report;
	}

	/** Every case of `file` from its newest run whose cases all hit, or null. */
	file_hit(file: string): Array<Hit<T>> | null {
		return this.capture.quiet(() => {
			for (const entry of this.#entries(file)) {
				const hits: Array<Hit<T>> = [];
				for (const c of entry.cases) {
					const h = this.#hit(file, c);
					if (h === null) break;
					hits.push(h);
				}
				if (hits.length === entry.cases.length && hits.length > 0) return hits;
			}
			return null;
		});
	}

	/** One case of `file`, from any stored run of it. */
	case_hit(file: string, name: string): Hit<T> | null {
		return this.capture.quiet(() => {
			const tried = new Set<string>();
			for (const entry of this.#entries(file)) {
				for (const c of entry.cases) {
					if (c.name !== name) continue;
					const sig = JSON.stringify(c.modules.map((e) => [e.path, e.ran]));
					if (tried.has(sig)) continue;
					tried.add(sig);
					const h = this.#hit(file, c);
					if (h) return h;
				}
			}
			return null;
		});
	}

	/**
	 * Why `name` of `file` is counted rather than reused: what changed since its newest stored run
	 * (a part every key shares, a module, a file it read), or that the cache has none.
	 */
	why(file: string, name: string, max = 5): string[] {
		return this.capture.quiet(() => {
			const stored = this.#entries(file)
				.flatMap((e) => e.cases)
				.find((c) => c.name === name);
			if (!stored) return ['not in the cache'];
			const now = this.#now(stored, file);
			const out: string[] = [];
			for (const [k, v] of Object.entries(this.#parts))
				if (stored.global?.[k] !== v) out.push(`${k} changed`);
			stored.modules.forEach((e, i) => {
				if (now.modules[i].hash !== e.hash) out.push(`${e.path} changed`);
			});
			stored.io.forEach((e, i) => {
				if (now.io[i].hash !== e.hash) out.push(`${e.path} (${e.op}) changed`);
			});
			if (out.length === 0) out.push('no counts kept under its key (unstable or failed before)');
			return out.length > max ? [...out.slice(0, max), `and ${out.length - max} more`] : out;
		});
	}

	/** A case starts (capture.ts). */
	begin_case(): void {
		this.capture.begin_case();
	}

	readonly watch: CaseWatch = {
		before_window: () => this.capture.before_window(),
		after_window: (snap) => this.capture.after_window(snap)
	};

	/**
	 * What the case just counted depended on, and its section under its key (when it is worth
	 * keeping: stable, no error).
	 */
	record(file: string, name: string, report: T): CaseManifest {
		return this.capture.quiet(() => {
			const seen = this.capture.observed();
			const counted = new Set(this.rt.modules.map((m) => m.meta.file));
			const modules: ModuleEntry[] = [];
			const loaded = new Set<string>();
			for (const abs of seen.loaded) {
				if (abs.startsWith(OWN_DIR)) continue;
				loaded.add(abs);
				const kind = kind_of(abs, counted.has(abs));
				const ran = kind === 'code' ? [...(seen.ran.get(abs) ?? [])] : undefined;
				modules.push(this.hasher.entry(abs, kind, ran));
			}
			const io: IoEntry[] = [];
			const listed = new Set<string>();
			const add = (op: IoEntry['op'], abs: string): void => {
				const path = rel_path(abs, this.root);
				const k = `${op}\0${path}`;
				if (listed.has(k)) return;
				listed.add(k);
				io.push({ op, path, hash: this.hasher.io(op, path) });
			};
			for (const r of seen.io) {
				if (r.path.startsWith(OWN_DIR)) continue;
				// the bytes of a module are in its entry
				if (r.op === 'read' && loaded.has(r.path)) continue;
				add(r.op, r.path);
			}
			for (const abs of loaded) {
				const m = this.hasher.manifest_of(abs);
				if (m !== null) add('read', m);
			}
			const key = case_key(this.#global, file, name, modules, io);
			const manifest: CaseManifest = { name, key, global: this.#parts, modules, io };
			if (report.stable && report.error === null) {
				const lines = this.#lines(report, modules);
				if (lines !== null) this.store.put_value({ key, report: cacheable(report), lines });
			}
			return manifest;
		});
	}

	/** Where each line of the section starts in its module's normalized text. */
	#lines(report: T, modules: readonly ModuleEntry[]): Value['lines'] | null {
		const by_id = new Map(modules.map((e) => [e.id, e]));
		const out: Value['lines'] = {};
		for (const { module, line } of this.layer.lines(report)) {
			const e = by_id.get(module);
			// counted but not seen loading (it loaded before the watch): not kept
			if (!e) return null;
			if (e.kind === 'raw') continue;
			let l = out[module];
			if (!l) out[module] = l = { raw: e.raw, at: {} };
			if (String(line) in l.at) continue;
			const n = this.hasher.normalized(
				abs_path(e.path, this.root),
				e.kind === 'code' ? (e.ran ?? []) : undefined
			);
			l.at[line] = n === null ? null : offset_of(n.table, line);
		}
		return out;
	}

	/** A complete run of `file`: its cases' manifests, in order, become its newest entry. */
	record_file(file: string, cases: CaseManifest[]): void {
		this.capture.quiet(() =>
			this.store.put_entry(this.#space + file, { at: new Date().toISOString(), cases })
		);
	}
}

/** `n` of `xs` at random (all of them when there are no more). */
export function pick<T>(xs: readonly T[], n: number): T[] {
	const a = [...xs];
	for (let i = a.length - 1; i > 0; i--) {
		const j = randomInt(i + 1);
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a.slice(0, Math.max(0, Math.min(n, a.length)));
}

/** How a layer loads and counts the cases of its bench files (runner.ts, growth/index.ts). */
export interface IncrementalJob<T extends CachedCase> {
	/** The bench files, relative to the run root, in order. */
	files: readonly string[];
	/** Every case of each file runs (no filter): the run becomes each file's newest entry. */
	complete: boolean;
	wanted(name: string): boolean;
	/** Reused cases to count again as a check. */
	verify: number;
	/** Load these bench files: the cases the layer would count, in order. */
	load(files: readonly string[]): Promise<BenchCase[]>;
	/** A file that did not load. */
	failed(file: string): boolean;
	/** Count one case; a failure is in the section, never thrown. */
	count(c: BenchCase, watch: CaseWatch): Promise<T>;
	/** `897 steps`: what the log says of a reused case. */
	label(r: T): string;
	log(line: string): void;
}

/**
 * The layer's sections of every case of `job.files`, in order: reused where the key matches,
 * counted (and stored) where it does not, and `verify` reused ones counted again as a check.
 */
export async function run_incremental<T extends CachedCase>(
	cache: CaseCache<T>,
	job: IncrementalJob<T>
): Promise<{ results: T[]; summary: CacheSummary }> {
	const { log } = job;
	// Files whose every case is in the cache are not even loaded.
	const whole = new Map<string, Array<Hit<T>>>();
	for (const f of job.files) {
		const hits = cache.file_hit(f);
		if (hits) whole.set(f, hits);
	}
	const list = (await job.load(job.files.filter((f) => !whole.has(f)))).filter((c) =>
		job.wanted(c.name)
	);
	const hits = new Map<BenchCase, Hit<T>>();
	for (const c of list) {
		const h = cache.case_hit(c.file, c.name);
		if (h) hits.set(c, h);
	}

	// the reused cases counted again; a whole file with one of them is loaded after all
	const id = (file: string, name: string): string => `${file}\0${name}`;
	const reusable = [
		...[...whole.values()].flat().filter((h) => job.wanted(h.name)),
		...hits.values()
	];
	const checks = new Set(pick(reusable, job.verify).map((h) => id(h.file, h.name)));
	const late = new Map<string, BenchCase>();
	const late_files = [...whole]
		.filter(([, hs]) => hs.some((h) => checks.has(id(h.file, h.name))))
		.map(([f]) => f);
	if (late_files.length > 0)
		for (const c of await job.load(late_files)) late.set(id(c.file, c.name), c);

	const summary: CacheSummary = { reused: 0, counted: 0, verified: 0, mismatches: [], why: [] };
	const count = async (c: BenchCase): Promise<{ r: T; m: CaseManifest }> => {
		cache.begin_case();
		const r = await job.count(c, cache.watch);
		summary.counted++;
		return { r, m: cache.record(c.file, c.name, r) };
	};
	/** A reused case counted again: the cache must agree with the count, else it is a cache bug. */
	const check = async (c: BenchCase, h: Hit<T>): Promise<{ r: T; m: CaseManifest }> => {
		const { r, m } = await count(c);
		summary.verified++;
		const diff = r.error === null ? first_difference(cacheable(h.report), cacheable(r)) : null;
		if (diff !== null) {
			r.error = `heisenbench cache: the reused counts differ from a recount (a cache bug): ${diff}`;
			summary.mismatches.push(`${c.name}: ${diff}`);
			// the recount is stored under its key; a stale value under another key goes
			if (m.key !== h.key) cache.store.delete_value(h.key);
			log(`CACHE BUG ${c.name}: the cached counts differ from a recount at ${diff}`);
		} else log(`verified ${c.name}: the cached counts equal a recount`);
		return { r, m };
	};
	const reuse = (h: Hit<T>): T => {
		summary.reused++;
		log(`reused   ${h.name}  ${job.label(h.report)}`);
		return h.report;
	};

	const results: T[] = [];
	for (const file of job.files) {
		const manifests: CaseManifest[] = [];
		const add = (got: { r: T; m: CaseManifest }): void => {
			results.push(got.r);
			manifests.push(got.m);
		};
		const from_cache = whole.get(file);
		if (from_cache) {
			for (const h of from_cache) {
				if (!job.wanted(h.name)) continue;
				const c = late.get(id(file, h.name));
				if (c && checks.has(id(file, h.name))) add(await check(c, h));
				else add({ r: reuse(h), m: h.manifest });
			}
		} else {
			if (job.failed(file)) continue;
			for (const c of list) {
				if (c.file !== file) continue;
				const h = hits.get(c);
				if (h && !checks.has(id(file, c.name))) add({ r: reuse(h), m: h.manifest });
				else if (h) add(await check(c, h));
				else {
					const why = cache.why(file, c.name);
					summary.why.push({ file, name: c.name, why });
					log(`counting ${c.name}: ${why.join('; ')}`);
					add(await count(c));
				}
			}
		}
		if (job.complete && manifests.length > 0) cache.record_file(file, manifests);
	}
	return { results, summary };
}
