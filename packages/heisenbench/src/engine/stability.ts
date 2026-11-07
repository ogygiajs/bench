import type { EngineCase, EngineDeopt, EngineFunction, EngineSite } from './types.ts';

/*
 * Repeatability of engine health. A case runs in two children; when they decode to different
 * results, it runs a few more times so that every function and site that varies shows up. The
 * merged case keeps what every run agreed on as it is. Whatever differed in any run is kept too
 * (with the first run's values) but marked `unstable`, with the reason in plain words: the engine
 * diff never turns such an entry into a finding.
 */

/** Two decoded runs of a case are the same. */
export function same_runs(a: EngineCase, b: EngineCase): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function in_runs(k: number, n: number): string {
	return `in ${k} of ${n} runs`;
}

function distinct<T>(values: T[]): T[] {
	const out: T[] = [];
	for (const v of values) if (!out.includes(v)) out.push(v);
	return out;
}

function present<T>(vals: Array<T | undefined>): T[] {
	const out: T[] = [];
	for (const v of vals) if (v !== undefined) out.push(v);
	return out;
}

/** What differs between the runs of one function, in plain words. */
export function function_difference(vals: Array<EngineFunction | undefined>): string {
	const n = vals.length;
	const got = present(vals);
	const parts: string[] = [];
	if (got.length < n) parts.push(`ran ${in_runs(got.length, n)}`);
	const tiers = distinct(got.map((f) => f.tier));
	if (tiers.length > 1) parts.push(`tier ${tiers.join(' / ')}`);
	const inlined = got.filter((f) => f.inlined).length;
	if (inlined > 0 && inlined < got.length) parts.push(`inlined ${in_runs(inlined, got.length)}`);
	const forced = got.filter((f) => f.forced).length;
	if (forced > 0 && forced < got.length) parts.push(`forced ${in_runs(forced, got.length)}`);
	const key = (d: EngineDeopt): string => `${d.line}\n${d.reason}`;
	const deopts = distinct(got.flatMap((f) => f.deopts.map(key)));
	let counts = false;
	for (const k of deopts) {
		const hits = present(got.map((f) => f.deopts.find((d) => key(d) === k)));
		if (hits.length < got.length) {
			const d = hits[0];
			parts.push(`deopt "${d.reason}" (line ${d.line}) ${in_runs(hits.length, got.length)}`);
		} else if (distinct(hits.map((d) => d.count)).length > 1) {
			counts = true;
		}
	}
	if (counts) parts.push('deopt counts differ');
	return parts.length > 0 ? parts.join('; ') : 'differs between runs';
}

/** What differs between the runs of one inline-cache site, in plain words. */
export function site_difference(vals: Array<EngineSite | undefined>): string {
	const n = vals.length;
	const got = present(vals);
	const parts: string[] = [];
	if (got.length < n) parts.push(`seen ${in_runs(got.length, n)}`);
	const states = distinct(got.map((s) => s.state));
	if (states.length > 1) parts.push(`state ${states.join(' / ')}`);
	const maps = distinct(got.map((s) => s.maps));
	if (maps.length > 1) parts.push(`maps ${maps.join(' / ')}`);
	const at = distinct(got.map((s) => `${s.line}:${s.col}`));
	if (at.length > 1) parts.push(`at ${at.join(' / ')}`);
	return parts.length > 0 ? parts.join('; ') : 'differs between runs';
}

function by_id<T extends { id: string }>(a: T, b: T): number {
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function merge_entries<T extends { id: string; unstable?: string }>(
	lists: T[][],
	describe: (vals: Array<T | undefined>) => string
): T[] {
	const maps = lists.map((l) => new Map(l.map((e) => [e.id, e])));
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const l of lists) {
		for (const e of l) {
			if (seen.has(e.id)) continue;
			seen.add(e.id);
			ids.push(e.id);
		}
	}
	const out: T[] = [];
	for (const id of ids) {
		const vals = maps.map((m) => m.get(id));
		const first = vals.find((v) => v !== undefined)!;
		const text = JSON.stringify(first);
		const agree = vals.every((v) => v !== undefined && JSON.stringify(v) === text);
		out.push(agree ? first : { ...first, unstable: describe(vals) });
	}
	return out.sort(by_id);
}

/**
 * One case from several decoded runs of it. Entries every run agrees on are kept as they are; the
 * rest keep the first run's values with `unstable` set to what differed. A run that failed fails
 * the case.
 */
export function merge_runs(runs: EngineCase[]): EngineCase {
	const first = runs[0];
	const failed = runs.find((r) => r.error !== null);
	if (failed) return { ...failed, stable: false, repeats: runs.length };
	const functions = merge_entries(
		runs.map((r) => r.functions),
		function_difference
	);
	const sites = merge_entries(
		runs.map((r) => r.sites),
		site_difference
	);
	const stable =
		functions.every((f) => f.unstable === undefined) &&
		sites.every((s) => s.unstable === undefined);
	return { ...first, stable, repeats: runs.length, functions, sites };
}

/** Functions and sites marked unstable in a case. */
export function unstable_entries(c: EngineCase): { functions: number; sites: number } {
	let functions = 0;
	let sites = 0;
	for (const f of c.functions) if (f.unstable !== undefined) functions++;
	for (const s of c.sites) if (s.unstable !== undefined) sites++;
	return { functions, sites };
}
