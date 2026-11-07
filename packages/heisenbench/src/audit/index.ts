import { relative, resolve, sep } from 'node:path';
import { case_key } from '../cases.ts';
import { DEFAULT_SIZES, run_growth } from '../growth/index.ts';
import type { GrowthReport } from '../growth/index.ts';
import type { LoadOptions } from '../growth/measure.ts';
import { run_child } from '../measure/spawn.ts';
import type { CaseResult } from '../measure/child.ts';
import { load_prices } from '../prices.ts';
import type { Report } from '../report.ts';
import { analyze_audit, kind_of } from './fit.ts';
import type { AuditInput, AuditReport } from './fit.ts';
import type { SizeTimes } from './time.ts';

/*
 * `heisenbench audit`: the prices checked against measured time (fit.ts has the method). Steps at
 * every growth size come from the growth layer (counted here, or taken from a report that has
 * them); time at the same sizes from the plain build, `repeats` rounds, each in a fresh process.
 */

export interface AuditOptions extends LoadOptions {
	sizes?: number[];
	/** Only the cases that declare their own `scale` (default: every case). */
	scaled?: boolean;
	/** Timing rounds, each in a fresh process (default 5). */
	repeats?: number;
	/** Timed phase per size per round, in ms (default 200). */
	time_ms?: number;
	warmup_ms?: number;
	/** Growth counted before at the same sizes, with units: reused instead of counting again. */
	growth?: GrowthReport | null;
}

export const DEFAULT_REPEATS = 5;

/** Growth already in a report when it has every size's units at these sizes. */
export function reusable_growth(r: Report | null, sizes: number[]): GrowthReport | null {
	const g = r?.growth;
	if (!g || g.sizes.join(',') !== sizes.join(',')) return null;
	return g.cases.every((c) => c.error !== null || c.units?.length === sizes.length) ? g : null;
}

export async function run_audit(o: AuditOptions): Promise<AuditReport> {
	const sizes = o.sizes ?? DEFAULT_SIZES;
	const repeats = o.repeats ?? DEFAULT_REPEATS;
	const log = o.log ?? (() => {});
	const root = resolve(o.root ?? process.cwd());
	const growth = o.growth ?? (await run_growth({ ...o, sizes, scaled: o.scaled, log }));
	const files = o.files.map((f) => relative(root, resolve(f)).split(sep).join('/'));
	const rounds = new Map<string, number[][]>();
	const failed: AuditReport['failed'] = [];
	for (let r = 0; r < repeats; r++) {
		const res = await run_child<Array<CaseResult<SizeTimes | null>>>({
			kind: 'audit_time',
			roots: [root],
			files: [files],
			filter: o.filter ?? null,
			options: {
				sizes,
				scaled: o.scaled ?? false,
				time_ms: o.time_ms ?? 200,
				warmup_ms: o.warmup_ms ?? 50,
				// A call at 100x can take seconds: the time budget, not a call count, sets the samples.
				iterations: 4,
				warmup_iterations: 2,
				cpu: false
			}
		});
		for (const c of res) {
			const key = case_key(c);
			if (c.error) {
				if (!failed.some((f) => case_key(f) === key))
					failed.push({ file: c.file, name: c.name, error: c.error.split('\n')[0] });
				continue;
			}
			if (!c.result) continue;
			// The median call, not the mean: robust to the waits of a busy machine (time.ts SizeTimes).
			rounds.set(key, [...(rounds.get(key) ?? []), c.result.p50_ns]);
		}
		log(`audit   timing round ${r + 1} of ${repeats}`);
	}
	const inputs: AuditInput[] = [];
	for (const g of growth.cases) {
		const key = case_key(g);
		if (g.error || !g.units) {
			if (g.error) failed.push({ file: g.file, name: g.name, error: g.error });
			continue;
		}
		// a case past the step cap was grown on a ladder of other sizes: not the sizes timed
		if (g.sizes.join(',') !== sizes.join(',')) {
			failed.push({
				file: g.file,
				name: g.name,
				error: `exceeded the step cap at ${g.capped_at}x`
			});
			continue;
		}
		const t = rounds.get(key);
		if (!t || failed.some((f) => case_key(f) === key)) continue;
		inputs.push({ file: g.file, name: g.name, sizes, units: g.units, rounds: t });
	}
	const report = analyze_audit(inputs, { sizes, rounds: repeats, prices: load_prices(), failed });
	for (const c of report.cases) {
		log(
			`${c.suspect ? 'SUSPECT ' : 'ok      '} ${c.name}  steps ${c.steps_exponent}, time ${c.time_exponent} (misfit ${c.misfit}${c.suspect ? `; ${c.suspect.kind} at ${c.suspect.factor}x` : c.explained_by ? `; ${c.explained_by}` : ''})`
		);
	}
	for (const f of report.findings) log(f.text);
	return report;
}

/** A merged audit of several reports' audit sections (one bench file each). */
export function merge_audits(parts: AuditReport[]): AuditReport | null {
	if (parts.length === 0) return null;
	const first = parts[0];
	return analyze_audit(
		parts.flatMap((p) => p.inputs),
		{
			sizes: first.sizes,
			rounds: first.rounds,
			prices: load_prices(),
			failed: parts.flatMap((p) => p.failed)
		}
	);
}

/**
 * The lines where each finding's kind did the most at 1x, from the counted report's per-line
 * units (top 3): where to look in the code.
 */
export function locate_findings(audit: AuditReport, report: Report | null): void {
	if (!report) return;
	for (const f of audit.findings) {
		const by_line = new Map<string, number>();
		const names = new Set(f.cases.map(case_key));
		for (const c of report.cases) {
			if (!names.has(case_key(c))) continue;
			for (const fn of c.functions) {
				for (const l of fn.lines) {
					if (!l.units) continue;
					let n = 0;
					for (const k of Object.keys(l.units)) if (kind_of(k) === f.kind) n += l.units[k];
					if (n > 0) {
						const at = `${fn.module}:${l.line}`;
						by_line.set(at, (by_line.get(at) ?? 0) + n);
					}
				}
			}
		}
		const top = [...by_line].sort((a, b) => b[1] - a[1]).slice(0, 3);
		if (top.length > 0) f.lines = top.map(([at]) => at);
	}
}
