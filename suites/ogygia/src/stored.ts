/**
 * What result.json keeps of the two reports. Two whole reports of a large selection outgrow what
 * the publish job takes (packages/compare's LIMITS.result): about 60% of a report is each
 * function's blocks and the engine layer's monomorphic inline-cache sites. Nothing that reads
 * result.json back reads those (the section, the diff and the time comparison are made from the
 * whole reports before it is written; trend.ts reads case totals, `heisenbench history` drops
 * blocks and sites itself), and the run's artifact keeps the whole reports (head/, base/).
 *
 * Kept: every case, function, line, unit, edge and built-in; every engine function; the engine
 * sites that are a finding (not monomorphic) or that the runs did not agree on.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHARDS_DIR, split_result } from '@bench/compare';
import type { Split } from '@bench/compare';
import type { EngineReport, Report } from '@bench/heisenbench';
import type { Result } from './section.ts';

/** What `detail` in result.json says was left out of `head` and `base`. */
export const STORED_DETAIL = {
	blocks: 'left out (the artifact keeps them)',
	engine_sites: 'not monomorphic, or unstable, only (the artifact keeps every site)'
} as const;

function stored_engine(e: EngineReport): EngineReport {
	return {
		...e,
		cases: e.cases.map((c) => ({
			...c,
			sites: c.sites.filter((s) => s.state !== 'monomorphic' || s.unstable !== undefined)
		}))
	};
}

/** The report without function blocks and with only the engine sites that say something. */
export function stored_report(r: Report | null): Report | null {
	if (!r) return r;
	return {
		...r,
		cases: r.cases.map((c) => ({
			...c,
			functions: c.functions.map((f) => ({ ...f, blocks: [] }))
		})),
		...(r.engine ? { engine: stored_engine(r.engine) } : {})
	};
}

/** The result as stored: the reports trimmed (stored_report), said so under `detail`. */
export function stored_result(r: Result): Result & { detail: typeof STORED_DETAIL } {
	return { ...r, head: stored_report(r.head), base: stored_report(r.base), detail: STORED_DETAIL };
}

/**
 * Writes the stored result to `out` in shards (@bench/compare's shards.ts): result.json the
 * manifest, shards/<sha256>.json the shards. Returns the split, for the log.
 */
export function write_stored(out: string, r: Result): Split {
	const split = split_result(stored_result(r) as unknown as Record<string, unknown>);
	const dir = join(out, SHARDS_DIR);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	for (const [name, text] of split.files) writeFileSync(join(dir, name), text);
	writeFileSync(join(out, 'result.json'), split.text);
	return split;
}
