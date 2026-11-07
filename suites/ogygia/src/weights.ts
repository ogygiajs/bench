/**
 * Real-app weights on a PR: the changed functions ranked by what they cost, from the weights the
 * newest main run counted in the app scenarios (`heisenbench/main/app-weights.json` on the
 * results branch) and, when the owner has uploaded one, the weights of real traffic imported from
 * production profiles (`heisenbench/main/real-weights.json`, `heisenbench weights import`; see
 * docs/ci.md "Real traffic"). With real traffic the ranking is by real cost, in CPU time per day.
 *
 * The app weights carry the environment they were counted in. Steps per call move with the Node
 * version, so app weights from another environment than the PR's counts are not used: the
 * section says so in one line. Real traffic is timed, not counted: it needs no environment check,
 * and a missing file is never an error.
 */
import { existsSync, readFileSync } from 'node:fs';
import { envMismatch, environment } from '@bench/heisenbench';
import type { DiffResult, Environment, RecordedGrowth, Report } from '@bench/heisenbench';
import {
	WEIGHTS_SCHEMA,
	build_weights,
	merge_weights,
	rank_findings,
	traffic_unit
} from '@bench/heisenbench/weight';
import type {
	AppWeights,
	Basis,
	RangeValue,
	RankedChange,
	RealCost
} from '@bench/heisenbench/weight';
import type { AppReport } from '@bench/heisenbench/app';

/** Weights as the main run stores them: Heisenbench's file plus where they were counted. */
export type StoredWeights = AppWeights & { env?: Environment; node?: string };

/** Ranked changes kept in result.json. */
const KEEP = 50;

export interface RankedRow {
	/** `change`, `growth` (a case whose class changed) or `recorded growth`. */
	kind: NonNullable<RankedChange['kind']>;
	case: string;
	function: string;
	line: number;
	delta_per_call: number;
	ns_per_call: number | null;
	/** The range model's estimate of one call's change, with its 10-90% range. */
	ns_model?: RangeValue;
	heat: RankedChange['judgement']['heat'];
	show: boolean;
	/** The unit the change costs most, or null on a cold path. */
	top: { unit: string; calls: number; steps: number; ns: number | null } | null;
	/** What it costs on real traffic (real-traffic weights only). */
	cost?: RealCost | null;
}

export interface WeightRun {
	/** `ranked`, or why not: no stored weights, unreadable ones, another environment. */
	status: 'ranked' | 'missing' | 'unreadable' | 'mismatch';
	/** The main commit the weights were counted on. */
	sha: string | null;
	/** Why the weights were not used (status other than ranked). */
	note: string | null;
	/** What the ranking is by (absent in results from before real traffic). */
	basis?: Basis;
	/** Real traffic: whether a file was used, and how much of its sampled time mapped. */
	real?: {
		status: 'used' | 'missing' | 'unreadable';
		note: string | null;
		coverage: string | null;
	};
	/** Changed functions and growth cases, biggest real impact first (at most KEEP). */
	ranked: RankedRow[];
	/** Growth from recorded calls, by what each cause takes on the real traffic now. */
	recorded?: RankedRow[];
	shown: number;
	suppressed: number;
}

function row(r: RankedChange): RankedRow {
	return {
		kind: r.kind ?? 'change',
		case: r.case,
		function: `${r.module} > ${r.function}`,
		line: r.line,
		delta_per_call: r.delta_per_call,
		ns_per_call: r.ns_per_call,
		...(r.ns_model ? { ns_model: r.ns_model } : {}),
		heat: r.judgement.heat,
		show: r.judgement.show,
		top: r.judgement.top && {
			unit: r.judgement.top.unit,
			calls: r.judgement.top.calls,
			steps: r.judgement.top.steps,
			ns: r.judgement.top.ns
		},
		...(r.cost !== undefined ? { cost: r.cost } : {})
	};
}

/** The real-traffic weights at `path`: used, missing (no file: not an error) or unreadable. */
function read_real(path: string | undefined): { w: AppWeights | null; real: WeightRun['real'] } {
	if (path === undefined) return { w: null, real: undefined };
	if (!existsSync(path))
		return { w: null, real: { status: 'missing', note: null, coverage: null } };
	try {
		const w = JSON.parse(readFileSync(path, 'utf8')) as AppWeights;
		if (w.schema !== WEIGHTS_SCHEMA || typeof w.functions !== 'object' || !traffic_unit(w))
			throw new Error('not a real-traffic weights file');
		return { w, real: { status: 'used', note: null, coverage: null } };
	} catch (e) {
		return {
			w: null,
			real: { status: 'unreadable', note: (e as Error).message, coverage: null }
		};
	}
}

export interface RankInputs {
	/** The base report (growth findings are ranked from both sides' growth sections). */
	base?: Report | null;
	/** The real-traffic weights file, when one may be on the results branch. */
	real_path?: string;
	/** A PR's growth-from-recorded-calls findings. */
	recorded?: RecordedGrowth[];
	requests_per_day?: number;
}

export interface RankingWeights {
	/** Main's app weights (when they read and match the PR's environment) and the real traffic, merged; null: neither. */
	weights: AppWeights | null;
	/** Why the app weights were not used (they are still merged in when real traffic is there). */
	fail: WeightRun | null;
	real: WeightRun['real'];
	sha: string | null;
	app: StoredWeights | null;
}

/** The weights a PR ranks by: main's app weights at `path`, checked, and the real traffic at `real_path`. */
export function ranking_weights(path: string, head: Report, real_path?: string): RankingWeights {
	const { w: real_w, real } = read_real(real_path);
	const none = (status: WeightRun['status'], note: string, sha: string | null = null) => ({
		status,
		sha,
		note,
		...(real ? { real } : {}),
		ranked: [],
		shown: 0,
		suppressed: 0
	});
	let app: StoredWeights | null = null;
	let fail: WeightRun | null = null;
	if (!existsSync(path)) fail = none('missing', 'no stored weights from a main run yet');
	else {
		try {
			app = JSON.parse(readFileSync(path, 'utf8')) as StoredWeights;
			if (app.schema !== WEIGHTS_SCHEMA || typeof app.functions !== 'object' || !app.units)
				throw new Error('not an app weights file');
		} catch (e) {
			app = null;
			fail = none('unreadable', `the stored weights do not read: ${(e as Error).message}`);
		}
	}
	const sha = typeof app?.source?.sha === 'string' ? app.source.sha : null;
	if (app && (!app.env || !app.node)) {
		fail = none('mismatch', 'the stored weights do not say where they were counted', sha);
		app = null;
	} else if (app) {
		const mismatch = envMismatch({ ...head, node: app.node, env: app.env } as Report, head);
		if (mismatch.length > 0) {
			fail = none(
				'mismatch',
				`they were counted in another environment (${mismatch.join('; ')})`,
				sha
			);
			app = null;
		}
	}
	// real traffic ranks on its own when the app weights cannot be used
	if (fail && !real_w) return { weights: null, fail, real, sha, app: null };
	const weights = merge_weights([app, real_w].filter((x): x is AppWeights => x !== null));
	return { weights, fail, real, sha, app };
}

/** The weights for result.json and the section, from the main weights file at `path`. */
export function rank_by_weights(
	path: string,
	diff: DiffResult,
	head: Report,
	o: RankInputs = {}
): WeightRun {
	const { weights, fail, real, sha, app } = ranking_weights(path, head, o.real_path);
	if (!weights) return fail!;
	const recorded_report = o.recorded?.length
		? ({
				...head,
				recorded_growth: {
					schema: 'heisenbench-recorded-growth/1',
					functions: o.recorded,
					skipped: {},
					steps_spent: 0
				}
			} as Report)
		: null;
	const ranking = rank_findings(diff, o.base ?? null, recorded_report ?? head, weights, undefined, {
		requests_per_day: o.requests_per_day
	});
	const ranked = ranking.ranked;
	return {
		status: 'ranked',
		sha: app ? sha : null,
		note: fail ? fail.note : null,
		basis: ranking.basis,
		...(real ? { real: { ...real, coverage: ranking.coverage } } : {}),
		ranked: ranked.slice(0, KEEP).map(row),
		recorded: ranking.recorded.slice(0, KEEP).map(row),
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
