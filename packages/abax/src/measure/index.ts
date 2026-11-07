import { relative, resolve, sep } from 'node:path';
import { one_line } from '../report.ts';
import type { CaseReport, Report } from '../report.ts';
import { with_measured } from '../calibrate/estimate.ts';
import { run_child } from './spawn.ts';
import type { CaseResult } from './child.ts';
import type { TimeOptions, TimeStats } from './time.ts';
import type { BytesOptions, BytesResult } from './alloc.ts';
import type { LeakOptions, LeakResult } from './leak.ts';
import { compare_bytes } from './elision.ts';

/*
 * The plain-build layers over a counted report: each layer runs its own child (spawn.ts) over the
 * same bench files and root, and what it finds goes into each case's `measure`.
 */

export type Layer = 'time' | 'bytes' | 'leaks';
export const LAYERS: Layer[] = ['time', 'bytes', 'leaks'];

export interface MeasureOptions {
	root: string;
	files: string[];
	filter?: string | null;
	layers: Layer[];
	time?: TimeOptions;
	bytes?: BytesOptions;
	leaks?: LeakOptions;
	log?: (line: string) => void;
}

function rel_files(root: string, files: string[]): string[] {
	return files.map((f) => relative(root, resolve(f)).split(sep).join('/'));
}

/**
 * One layer's results by case. A child that crashed or ran out of time fails the layer for every
 * case of the report (the error is in each case's `measure.errors`), and the next layer still runs.
 */
async function layer<T>(
	kind: Layer,
	o: MeasureOptions,
	options: object | undefined,
	report: Report
): Promise<Map<string, CaseResult<T>>> {
	const root = resolve(o.root);
	try {
		const res = await run_child<Array<CaseResult<T>>>({
			kind,
			roots: [root],
			files: [rel_files(root, o.files)],
			filter: o.filter ?? null,
			options: options ?? {}
		});
		return new Map(res.map((c) => [`${c.file} > ${c.name}`, c]));
	} catch (e) {
		const msg = one_line(e);
		o.log?.(`FAILED   ${kind}: ${msg}`);
		for (const c of report.cases) if (!c.error) fail(c, kind, msg);
		return new Map();
	}
}

function fail(c: CaseReport, layer: Layer, error: string): void {
	c.measure = { ...c.measure, errors: { ...c.measure?.errors, [layer]: error } };
}

/** Run the plain-build layers and add what they found to the report's cases (in place). */
export async function measure_layers(report: Report, o: MeasureOptions): Promise<Report> {
	const key = (c: CaseReport) => `${c.file} > ${c.name}`;
	if (o.layers.includes('time')) {
		const r = await layer<TimeStats>('time', o, o.time, report);
		for (const c of report.cases) {
			const t = r.get(key(c));
			if (!t) continue;
			if (!t.result) {
				fail(c, 'time', t.error ?? 'failed');
				continue;
			}
			const est = c.measure?.estimate;
			c.measure = {
				...c.measure,
				time: t.result,
				estimate: est ? with_measured(est, t.result.mean_ns) : est
			};
			o.log?.(`time    ${c.name}  p50 ${Math.round(t.result.p50_ns)} ns`);
		}
	}
	if (o.layers.includes('bytes')) {
		const r = await layer<BytesResult>('bytes', o, o.bytes, report);
		for (const c of report.cases) {
			const b = r.get(key(c));
			if (!b) continue;
			if (!b.result) {
				fail(c, 'bytes', b.error ?? 'failed');
				continue;
			}
			const m = compare_bytes(c, b.result);
			c.measure = { ...c.measure, bytes: m };
			const elided = m.functions.filter((f) => f.elided).length;
			o.log?.(
				`bytes   ${c.name}  estimated ${m.estimated} B, real ${m.real} B${elided ? `, ${elided} elided` : ''}`
			);
		}
	}
	if (o.layers.includes('leaks')) {
		const r = await layer<LeakResult>('leaks', o, o.leaks, report);
		for (const c of report.cases) {
			const l = r.get(key(c));
			if (!l) continue;
			if (!l.result) {
				fail(c, 'leaks', l.error ?? 'failed');
				continue;
			}
			c.measure = { ...c.measure, leak: l.result };
			const v = l.result;
			const verdict = v.leaked
				? 'LEAKS'
				: !v.grows
					? 'ok'
					: v.source
						? 'ok (grows, but few objects stay held)'
						: 'ok (grows, but no source variable holds it)';
			o.log?.(`leaks   ${c.name}  ${verdict}  ${v.bytes_per_call} B/call (floor ${v.threshold})`);
		}
	}
	return report;
}

export function parse_layers(flag: string | undefined): Layer[] {
	if (!flag) return [];
	if (flag === 'all') return [...LAYERS];
	const out = flag.split(',') as Layer[];
	for (const l of out) if (!LAYERS.includes(l)) throw new Error(`abax: unknown layer ${l}`);
	return out;
}
