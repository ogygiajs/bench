import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import { run_benches } from '../runner.ts';
import { load_prices } from '../prices.ts';
import { run_child } from '../measure/spawn.ts';
import type { CaseResult } from '../measure/child.ts';
import type { TimeStats } from '../measure/time.ts';
import { case_units, family_key } from './weights.ts';
import type { CorpusPoint } from './weights.ts';

/*
 * Calibration points kept on disk, so measuring (slow, needs a quiet machine) and fitting (exact,
 * instant) are two steps, and two measurements of the same cases can be checked against each other
 * before any of them is trusted (`heisenbench calibrate agree`).
 *
 * A point set is one corpus (bench files under one root) counted once (exact) and timed `repeats`
 * times on the plain build, each repeat in its own child process. Per case it keeps every repeat's
 * mean and p50, so the spread of one measurement is visible next to its median.
 */

export const POINTS_SCHEMA = 'heisenbench-points/1';

export interface Machine {
	cpu: string;
	cores: number;
	os: string;
	node: string;
	v8: string;
	/** 1-minute load average when the measurement started and ended. */
	load: [number, number];
}

export interface TimedPoint extends CorpusPoint {
	/** Median of the repeats' p50 (ns). */
	p50_ns: number;
	/** Each repeat's mean ns per call (`ns` is their median). */
	means: number[];
	p50s: number[];
}

export interface PointSet {
	schema: typeof POINTS_SCHEMA;
	root: string;
	files: string[];
	prices: { version: number; hash: string };
	machine: Machine;
	repeats: number;
	time_ms: number;
	date: string;
	points: TimedPoint[];
}

export function machine_info(load_at_start = loadavg()[0]): Machine {
	const c = cpus();
	return {
		cpu: c[0]?.model.trim() ?? 'unknown',
		cores: c.length,
		os: `${platform()} ${release()}`,
		node: process.version,
		v8: process.versions.v8,
		load: [Math.round(load_at_start * 100) / 100, Math.round(loadavg()[0] * 100) / 100]
	};
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const h = s.length >> 1;
	return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

export interface MeasurePointsOptions {
	root: string;
	files: string[];
	filter?: string;
	time_ms?: number;
	warmup_ms?: number;
	repeats?: number;
	log?: (line: string) => void;
}

/** Count every case of `files` (in this process) and time it `repeats` times in plain children. */
export async function measure_points(o: MeasurePointsOptions): Promise<PointSet> {
	const load0 = loadavg()[0];
	const root = resolve(o.root);
	const repeats = o.repeats ?? 3;
	const time_ms = o.time_ms ?? 150;
	const report = await run_benches({ files: o.files, root, filter: o.filter, sha: null });
	const files = o.files.map((f) => relative(root, resolve(root, f)).split(sep).join('/'));
	const times = new Map<string, TimeStats[]>();
	for (let r = 0; r < repeats; r++) {
		const res = await run_child<Array<CaseResult<TimeStats>>>({
			kind: 'time',
			roots: [root],
			files: [files],
			filter: o.filter ?? null,
			options: { time_ms, warmup_ms: o.warmup_ms ?? 50 }
		});
		for (const c of res) {
			if (!c.result) throw new Error(`heisenbench: timing ${c.name} failed: ${c.error}`);
			const key = `${c.file} > ${c.name}`;
			times.set(key, [...(times.get(key) ?? []), c.result]);
		}
		o.log?.(`repeat ${r + 1}/${repeats}: ${res.length} cases timed`);
	}
	const points: TimedPoint[] = [];
	for (const c of report.cases) {
		if (c.error) throw new Error(`heisenbench: counting ${c.name} failed: ${c.error}`);
		const t = times.get(`${c.file} > ${c.name}`) ?? [];
		const means = t.map((x) => x.mean_ns);
		if (means.length === 0 || !(median(means) > 0)) continue;
		points.push({
			file: c.file,
			name: c.name,
			family: family_key(c.file, c.name),
			units: case_units(c),
			steps: c.totals.steps,
			// The mean, not p50: a call shorter than the timer's tick has a p50 of 0 or one tick,
			// while the mean of many quantized samples is still right on average.
			ns: median(means),
			p50_ns: median(t.map((x) => x.p50_ns)),
			means: means.map((x) => Math.round(x * 10) / 10),
			p50s: t.map((x) => Math.round(x.p50_ns * 10) / 10)
		});
	}
	const prices = load_prices();
	return {
		schema: POINTS_SCHEMA,
		root,
		files,
		prices: { version: prices.prices.version, hash: prices.hash },
		machine: machine_info(load0),
		repeats,
		time_ms,
		date: new Date().toISOString(),
		points
	};
}

export function write_points(path: string, set: PointSet): void {
	writeFileSync(path, JSON.stringify(set, null, '\t') + '\n');
}

export function read_points(path: string): PointSet {
	const set = JSON.parse(readFileSync(path, 'utf8')) as PointSet;
	if (set.schema !== POINTS_SCHEMA) throw new Error(`heisenbench: ${path} is not a calibration point set`);
	return set;
}

/**
 * How far two measurements of the same cases are apart: per case |log(b / a)| of the measured ns,
 * as a percentage (|Δ| = e^|log ratio| - 1). Cases one side lacks are listed, not compared.
 */
export interface Agreement {
	cases: number;
	/** Median b / a, as a percentage change: the whole machine ran faster or slower. */
	shift_pct: number;
	/** Median |Δ| once that shift is taken out: how much the cases moved against each other. */
	shape_pct: number;
	median_pct: number;
	p90_pct: number;
	max_pct: number;
	worst: Array<{ name: string; a_ns: number; b_ns: number; pct: number }>;
	missing: string[];
}

function pct_apart(a: number, b: number): number {
	return (Math.exp(Math.abs(Math.log(b / a))) - 1) * 100;
}

function quantile(sorted: number[], q: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export function agreement(
	a: ReadonlyMap<string, number>,
	b: ReadonlyMap<string, number>
): Agreement {
	const rows: Agreement['worst'] = [];
	const missing: string[] = [];
	for (const [name, a_ns] of a) {
		const b_ns = b.get(name);
		if (b_ns === undefined || !(a_ns > 0) || !(b_ns > 0)) {
			missing.push(name);
			continue;
		}
		rows.push({ name, a_ns, b_ns, pct: Math.round(pct_apart(a_ns, b_ns) * 100) / 100 });
	}
	for (const name of b.keys()) if (!a.has(name)) missing.push(name);
	const pcts = rows.map((r) => r.pct).sort((x, y) => x - y);
	const logs = rows.map((r) => Math.log(r.b_ns / r.a_ns)).sort((x, y) => x - y);
	const shift = quantile(logs, 0.5);
	const shape = logs.map((l) => Math.abs(l - shift)).sort((x, y) => x - y);
	const as_pct = (l: number) => Math.round((Math.exp(l) - 1) * 1e4) / 100;
	return {
		cases: rows.length,
		shift_pct: as_pct(shift),
		shape_pct: as_pct(quantile(shape, 0.5)),
		median_pct: quantile(pcts, 0.5),
		p90_pct: quantile(pcts, 0.9),
		max_pct: pcts.at(-1) ?? 0,
		worst: rows.sort((x, y) => y.pct - x.pct).slice(0, 5),
		missing
	};
}

/** ns per case of a point set, keyed `file > name`. */
export function point_times(set: PointSet): Map<string, number> {
	return new Map(set.points.map((p) => [`${p.file} > ${p.name}`, p.ns]));
}
