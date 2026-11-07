/**
 * Real-app weights on a PR: the changed functions ranked by what they cost the real apps per unit
 * of work (a request, a page load, an interaction), from the weights the newest main run counted
 * in the app scenarios (`heisenbench/main/app-weights.json` on the results branch).
 *
 * The weights carry the environment they were counted in. Steps per call move with the Node
 * version, so weights from another environment than the PR's counts are not used: the section
 * says so in one line instead of ranking.
 */
import { existsSync, readFileSync } from 'node:fs';
import { envMismatch, environment } from '@bench/heisenbench';
import type { DiffResult, Environment, Report } from '@bench/heisenbench';
import { WEIGHTS_SCHEMA, build_weights, rank_changes } from '@bench/heisenbench/weight';
import type { AppWeights, RankedChange } from '@bench/heisenbench/weight';
import type { AppReport } from '@bench/heisenbench/app';

/** Weights as the main run stores them: Heisenbench's file plus where they were counted. */
export type StoredWeights = AppWeights & { env?: Environment; node?: string };

/** Ranked changes kept in result.json. */
const KEEP = 50;

export interface RankedRow {
	case: string;
	function: string;
	line: number;
	delta_per_call: number;
	ns_per_call: number | null;
	heat: RankedChange['judgement']['heat'];
	show: boolean;
	/** The unit the change costs most, or null on a cold path. */
	top: { unit: string; calls: number; steps: number; ns: number | null } | null;
}

export interface WeightRun {
	/** `ranked`, or why not: no stored weights, unreadable ones, another environment. */
	status: 'ranked' | 'missing' | 'unreadable' | 'mismatch';
	/** The main commit the weights were counted on. */
	sha: string | null;
	/** Why the weights were not used (status other than ranked). */
	note: string | null;
	/** Changed functions, biggest real-app impact first (at most KEEP). */
	ranked: RankedRow[];
	shown: number;
	suppressed: number;
}

/** The weights for result.json and the section, from the main weights file at `path`. */
export function rank_by_weights(path: string, diff: DiffResult, head: Report): WeightRun {
	const none = (status: WeightRun['status'], note: string, sha: string | null = null) => ({
		status,
		sha,
		note,
		ranked: [],
		shown: 0,
		suppressed: 0
	});
	if (!existsSync(path)) return none('missing', 'no stored weights from a main run yet');
	let w: StoredWeights;
	try {
		w = JSON.parse(readFileSync(path, 'utf8')) as StoredWeights;
		if (w.schema !== WEIGHTS_SCHEMA || typeof w.functions !== 'object' || !w.units)
			throw new Error('not an app weights file');
	} catch (e) {
		return none('unreadable', `the stored weights do not read: ${(e as Error).message}`);
	}
	const sha = typeof w.source?.sha === 'string' ? w.source.sha : null;
	if (!w.env || !w.node)
		return none('mismatch', 'the stored weights do not say where they were counted', sha);
	const as_report = { ...head, node: w.node, env: w.env } as Report;
	const mismatch = envMismatch(as_report, head);
	if (mismatch.length > 0)
		return none(
			'mismatch',
			`they were counted in another environment (${mismatch.join('; ')})`,
			sha
		);
	const ranked = rank_changes(diff, w);
	return {
		status: 'ranked',
		sha,
		note: null,
		ranked: ranked.slice(0, KEEP).map((r) => ({
			case: r.case,
			function: `${r.module} > ${r.function}`,
			line: r.line,
			delta_per_call: r.delta_per_call,
			ns_per_call: r.ns_per_call,
			heat: r.judgement.heat,
			show: r.judgement.show,
			top: r.judgement.top && {
				unit: r.judgement.top.unit,
				calls: r.judgement.top.calls,
				steps: r.judgement.top.steps,
				ns: r.judgement.top.ns
			}
		})),
		shown: ranked.filter((r) => r.judgement.show).length,
		suppressed: ranked.filter((r) => !r.judgement.show).length
	};
}

/**
 * The weights a main run stores: Heisenbench's `build_weights` over the counted app reports, labelled
 * with the commit and stamped with the environment that counted them (this process: the same
 * job, right after the count).
 */
export function main_weights(reports: AppReport[], sha: string): StoredWeights {
	for (const r of reports) {
		if (r.node !== process.version)
			throw new Error(`an app report was counted on Node ${r.node}; this is ${process.version}`);
	}
	const w = build_weights(reports);
	return { ...w, source: { ...w.source, sha }, node: process.version, env: environment() };
}
