import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { run_benches } from '../runner.ts';
import { OP_KINDS, load_prices } from '../prices.ts';
import type { Prices } from '../prices.ts';
import { add_units, price_units } from '../units.ts';
import type { Units } from '../units.ts';
import type { CaseReport } from '../report.ts';
import { run_child } from '../measure/spawn.ts';
import type { CaseResult } from '../measure/child.ts';
import type { TimeStats } from '../measure/time.ts';
import { nnls, r_squared } from './nnls.ts';
import { package_url } from '../own.ts';

/*
 * Steps -> nanoseconds (spec 6). A corpus of bench cases is counted (instrumented, in this
 * process) and timed (plain build, tinybench, in a child). Each case is one point: its features
 * are what it did, from the report's units,
 *
 *   one column per op kind     ops executed
 *   builtin                    steps of priced built-in calls (their curves are calibrated apart)
 *   dynamic                    steps of dynamic sizes (characters, spread keys, rest elements)
 *   case                       1: the cost of one call of the case itself
 *
 * and its target the measured mean ns per call. Non-negative least squares (no op may take negative time),
 * rows scaled by 1/ns so a 50 ns case weighs as much as a 50 µs one (a relative fit).
 *
 * Fit quality per case family: corpus cases named `<family> @<size>` are one family measured at
 * several sizes; R^2 of predicted against measured ns over the family's points says whether steps
 * predict time for that kind of code. A low R^2 marks the family "time-led" (JIT-sensitive: trust
 * the time layer, not the estimate).
 */

export const FEATURES = [...OP_KINDS, 'builtin', 'dynamic', 'case'] as const;

export interface Weights {
	version: number;
	/** Price file the builtin / dynamic features were priced with. */
	prices: { version: number; hash: string };
	node: string;
	/** The machine the points were measured on (cpu, cores, os, node, v8, load). */
	machine?: import('./points.ts').Machine;
	/** ns per unit of each feature. */
	ns: Record<string, number>;
	/** Families below this R^2 are time-led. */
	time_led_below: number;
	fit: { r2: number; points: number };
	/** `file > family` -> fit of the family's points. */
	families: Record<string, { r2: number | null; points: number }>;
}

export interface CorpusPoint {
	file: string;
	name: string;
	family: string;
	units: Units;
	steps: number;
	ns: number;
}

export const DEFAULT_WEIGHTS_PATH = package_url('weights.json');

export function family_of(name: string): string {
	const at = name.lastIndexOf(' @');
	return at === -1 ? name : name.slice(0, at);
}

export function family_key(file: string, name: string): string {
	return `${file} > ${family_of(name)}`;
}

/** What a case did, summed over its functions. */
export function case_units(c: CaseReport): Units {
	const u: Units = {};
	for (const f of c.functions) if (f.units) add_units(u, f.units);
	return u;
}

export function features_of(u: Units, prices: Prices): number[] {
	const builtin: Units = {};
	const dynamic: Units = {};
	for (const k of Object.keys(u)) {
		if (k.startsWith('bi.')) builtin[k] = u[k];
		else if (k.startsWith('dyn.')) dynamic[k] = u[k];
	}
	return [
		...OP_KINDS.map((k) => u[k] ?? 0),
		price_units(builtin, prices),
		price_units(dynamic, prices),
		1
	];
}

/** Estimated ns of a set of units (a case, a function, a delta) under the weights. */
export function units_ns(u: Units, w: Weights, prices: Prices, with_case = false): number {
	const f = features_of(u, prices);
	let ns = 0;
	for (let i = 0; i < FEATURES.length - 1; i++) ns += f[i] * (w.ns[FEATURES[i]] ?? 0);
	if (with_case) ns += w.ns.case ?? 0;
	return ns;
}

export interface MeasureCorpusOptions {
	root: string;
	files: string[];
	filter?: string;
	time_ms?: number;
	warmup_ms?: number;
	/** Timings per case; the median p50 is used (default 3). */
	repeats?: number;
	log?: (line: string) => void;
}

/** Count every corpus case here and time it in a plain child. */
export async function measure_corpus(o: MeasureCorpusOptions): Promise<CorpusPoint[]> {
	const root = resolve(o.root);
	const report = await run_benches({ files: o.files, root, filter: o.filter, sha: null });
	const files = o.files.map((f) => relative(root, resolve(f)).split(sep).join('/'));
	const times = new Map<string, number[]>();
	for (let r = 0; r < (o.repeats ?? 3); r++) {
		const res = await run_child<Array<CaseResult<TimeStats>>>({
			kind: 'time',
			roots: [root],
			files: [files],
			filter: o.filter ?? null,
			options: { time_ms: o.time_ms ?? 150, warmup_ms: o.warmup_ms ?? 50 }
		});
		for (const c of res) {
			if (!c.result) throw new Error(`heisenbench: timing ${c.name} failed: ${c.error}`);
			const key = `${c.file} > ${c.name}`;
			// The mean, not p50: a call shorter than the timer's tick has a p50 of 0 or one tick,
			// while the mean of many quantized samples is still right on average.
			times.set(key, [...(times.get(key) ?? []), c.result.mean_ns]);
		}
	}
	const points: CorpusPoint[] = [];
	for (const c of report.cases) {
		if (c.error) throw new Error(`heisenbench: counting ${c.name} failed: ${c.error}`);
		const t = (times.get(`${c.file} > ${c.name}`) ?? []).sort((a, b) => a - b);
		if (t.length === 0 || !(t[t.length >> 1] > 0)) continue;
		points.push({
			file: c.file,
			name: c.name,
			family: family_key(c.file, c.name),
			units: case_units(c),
			steps: c.totals.steps,
			ns: t[t.length >> 1]
		});
		o.log?.(`${c.name}: ${Math.round(c.totals.steps)} steps, ${t[t.length >> 1].toFixed(0)} ns`);
	}
	return points;
}

export function fit_weights(
	points: CorpusPoint[],
	prices: { prices: Prices; hash: string } = load_prices(),
	time_led_below = 0.9
): Omit<Weights, 'version'> {
	const rows = points.map((p) => features_of(p.units, prices.prices));
	const a = rows.map((r, i) => r.map((v) => v / points[i].ns));
	const b = points.map(() => 1);
	const x = nnls(a, b);
	const ns: Record<string, number> = {};
	FEATURES.forEach((f, i) => (ns[f] = Math.round(x[i] * 1e4) / 1e4));
	const predict = (r: number[]) => r.reduce((s, v, i) => s + v * ns[FEATURES[i]], 0);
	const predicted = rows.map(predict);
	const families: Weights['families'] = {};
	const by_family = new Map<string, number[]>();
	points.forEach((p, i) => by_family.set(p.family, [...(by_family.get(p.family) ?? []), i]));
	for (const [fam, idx] of by_family) {
		const r2 =
			idx.length >= 3
				? r_squared(
						idx.map((i) => points[i].ns),
						idx.map((i) => predicted[i])
					)
				: null;
		families[fam] = { r2: r2 === null ? null : Math.round(r2 * 1000) / 1000, points: idx.length };
	}
	// Overall fit on the log scale: points span orders of magnitude.
	const r2 = r_squared(
		points.map((p) => Math.log(p.ns)),
		predicted.map((v) => Math.log(Math.max(v, 1e-3)))
	);
	return {
		prices: { version: prices.prices.version, hash: prices.hash },
		node: process.version,
		ns,
		time_led_below,
		fit: { r2: Math.round(r2 * 1000) / 1000, points: points.length },
		families
	};
}

export function load_weights(path: string | URL = DEFAULT_WEIGHTS_PATH): Weights | null {
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, 'utf8')) as Weights;
}

/** Write weights; the version goes up when the per-feature weights changed. */
export function write_weights(path: string | URL, fit: Omit<Weights, 'version'>): Weights {
	const old = load_weights(path);
	const same = old !== null && JSON.stringify(old.ns) === JSON.stringify(fit.ns);
	const w: Weights = { version: old ? (same ? old.version : old.version + 1) : 1, ...fit };
	writeFileSync(path, JSON.stringify(w, null, '\t') + '\n');
	return w;
}
