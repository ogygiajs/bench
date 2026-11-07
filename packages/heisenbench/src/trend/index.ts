import { segment } from './segment.ts';
import type { Piece } from './segment.ts';

/*
 * Slow creep in a case's steps across main commits: many small rises, each under what one PR
 * would be blamed for, that add up. Report-only: the counts and the PR gate are untouched.
 *
 * The model, in one paragraph. Steps are exact, so a series moves only when a commit changes the
 * code a case runs; what looks like noise is real code churn. The series is taken as the log of
 * the steps (so a rise is a ratio, in percent) and cut into flat and sloped pieces by exact
 * penalized least squares (segment.ts): a cut costs β = 2·ln n and a slope γ = ln n (the Bayesian
 * information criterion: each number the fit uses must buy back ln n of fit), with misfit measured
 * in units of σ = 0.5%, the distance a level may sit from its line before it counts as a separate
 * regime. A single commit that moves the steps by 2% or more is a step: its own PR comment shows
 * it and blame names its hunk, so it is labeled a step and never counted as creep. Inside each
 * run of rising lines, the creep is the span from a small rise to a small rise whose sum beats
 * churn the most, and it is reported when that sum is 2% or more, comes from at least 3 commits,
 * and is at least 4.5 churn deviations: sum / (churn · √moves), where churn is the root mean square
 * of the case's small per-commit moves outside every rising stretch (or over the whole series when
 * that quiet part has fewer moves than the span), never below 0.1%. The span is the best of about
 * n²/2, so the bar sits well above the usual 2 or 3: on simulated churn (test/trend.test.ts) it
 * shows a creep in 2 of 800 series of 40 commits. Every one of these numbers is an option.
 */

export interface TrendPoint {
	/** The main commit. */
	sha: string;
	/** The case's steps at that commit; null when it was not counted there (absent, or failed). */
	steps: number | null;
	/** What counted it (the Heisenbench commit, Node): a change says the counter moved too. */
	counter?: string | null;
}

export interface TrendOptions {
	/** σ: the misfit scale of the segmentation, in percent of the steps. */
	sigma_pct: number;
	/** β, the price of a cut; null: 2·ln n. */
	cut_penalty: number | null;
	/** γ, the extra price of a slope; null: ln n. */
	slope_penalty: number | null;
	/** One commit that moves the steps by this share or more is a step, not part of a creep. */
	step_ratio: number;
	/** A creep rises by this share at least, from its small rises alone. */
	min_rise: number;
	/** ...in at least this many separate commits. */
	min_rises: number;
	/** ...and its rise is this many churn deviations over its length at least. */
	min_z: number;
	/** The smallest churn the test assumes, in percent per commit (an exact, quiet series has none). */
	churn_floor_pct: number;
}

export const TREND_DEFAULTS: TrendOptions = {
	sigma_pct: 0.5,
	cut_penalty: null,
	slope_penalty: null,
	step_ratio: 0.02,
	min_rise: 0.02,
	min_rises: 3,
	min_z: 4.5,
	churn_floor_pct: 0.1
};

export interface TrendStep {
	sha: string;
	/** Index of the commit among the counted points. */
	index: number;
	/** steps after / steps before − 1. */
	ratio: number;
	/** The counter changed at this commit too. */
	counter_changed: boolean;
}

export interface TrendCreep {
	/** The first commit of the creep's small rises: where the steps started rising. */
	start: string;
	/** The last one. */
	end: string;
	start_index: number;
	end_index: number;
	/** Counted commits from start to end, both included. */
	commits: number;
	/** Commits in that span whose small move was a rise. */
	rises: number;
	/** What the small moves add up to: exp(sum of log moves) − 1. Steps inside are left out. */
	ratio: number;
	/** The rise in churn deviations: sum / (churn · √length). */
	z: number;
	/** The churn the test used, in percent per commit. */
	churn_pct: number;
	/** `rising`: up to the newest commit; `held`: stopped, still there; `reverted`: given back. */
	status: 'rising' | 'held' | 'reverted';
	/** The commit that gave most of it back (with `reverted`). */
	reverted_at: string | null;
	/** Rises that came with a change of the counter. */
	counter_changes: number;
}

export interface TrendResult {
	/** `creep` when any creep was found; else `step` when any step; else `flat`. */
	verdict: 'flat' | 'step' | 'creep';
	/** Counted points the model saw. */
	points: number;
	steps: TrendStep[];
	creeps: TrendCreep[];
	/** The pieces of the segmentation (indices into the counted points). */
	pieces: Piece[];
}

const EPS = 1e-9;

function check(o: TrendOptions): void {
	const pos = (k: keyof TrendOptions) => {
		const v = o[k];
		if (typeof v !== 'number' || !(Number.isFinite(v) && v > 0))
			throw new Error(`trend: ${k} must be a positive number`);
	};
	for (const k of ['sigma_pct', 'step_ratio', 'min_rise', 'churn_floor_pct'] as const) pos(k);
	if (!(Number.isInteger(o.min_rises) && o.min_rises >= 1))
		throw new Error('trend: min_rises must be a whole number, 1 or more');
	if (!(Number.isFinite(o.min_z) && o.min_z >= 0))
		throw new Error('trend: min_z must be 0 or more');
	for (const k of ['cut_penalty', 'slope_penalty'] as const) {
		const v = o[k];
		if (v !== null && !(Number.isFinite(v) && v >= 0))
			throw new Error(`trend: ${k} must be null or 0 or more`);
	}
}

/** Change-points of one case's steps across main commits, oldest commit first. */
export function detect_trend(
	series: readonly TrendPoint[],
	opts: Partial<TrendOptions> = {}
): TrendResult {
	const o: TrendOptions = { ...TREND_DEFAULTS, ...opts };
	check(o);
	const pts = series.filter(
		(p): p is TrendPoint & { steps: number } =>
			p.steps !== null && Number.isFinite(p.steps) && p.steps > 0
	);
	const n = pts.length;
	const x = pts.map((p) => 100 * Math.log(p.steps));
	// d[t]: the move into point t (d[0] is unused)
	const d = x.map((v, t) => (t === 0 ? 0 : v - x[t - 1]));
	const step_log = 100 * Math.log(1 + o.step_ratio);
	const is_step = (t: number) => t > 0 && Math.abs(d[t]) >= step_log;
	const counter_changed = (t: number) =>
		t > 0 && (pts[t].counter ?? null) !== (pts[t - 1].counter ?? null);

	const steps: TrendStep[] = [];
	for (let t = 1; t < n; t++) {
		if (!is_step(t)) continue;
		steps.push({
			sha: pts[t].sha,
			index: t,
			ratio: Math.exp(d[t] / 100) - 1,
			counter_changed: counter_changed(t)
		});
	}
	if (n < 2) return { verdict: 'flat', points: n, steps, creeps: [], pieces: [] };

	const ln = Math.log(n);
	const pieces = segment(x, {
		sigma: o.sigma_pct,
		cut_penalty: o.cut_penalty ?? 2 * ln,
		slope_penalty: o.slope_penalty ?? ln
	});

	// windows of moves: each run of adjacent rising lines, with the small rising moves into and
	// out of it (a cut sits on a move, so the first and last rise of a staircase are often there)
	const windows: Array<[number, number]> = [];
	for (let i = 0; i < pieces.length; i++) {
		if (pieces[i].kind !== 'line' || pieces[i].slope <= 0) continue;
		let j = i;
		while (j + 1 < pieces.length && pieces[j + 1].kind === 'line' && pieces[j + 1].slope > 0) j++;
		const a = pieces[i].start;
		const b = pieces[j].end - 1;
		const small_rise = (t: number) => t > 0 && t < n && !is_step(t) && d[t] > EPS;
		windows.push([small_rise(a) ? a : a + 1, small_rise(b + 1) ? b + 1 : b]);
		i = j;
	}

	// prefix sums over the small moves (steps left out): sum, sum of squares, count, rises
	const p_sum = new Float64Array(n + 1);
	const p_sq = new Float64Array(n + 1);
	const p_cnt = new Int32Array(n + 1);
	const p_rise = new Int32Array(n + 1);
	const p_counter = new Int32Array(n + 1);
	for (let t = 0; t < n; t++) {
		const small = t > 0 && !is_step(t);
		const rise = small && d[t] > EPS;
		p_sum[t + 1] = p_sum[t] + (small ? d[t] : 0);
		p_sq[t + 1] = p_sq[t] + (small ? d[t] * d[t] : 0);
		p_cnt[t + 1] = p_cnt[t] + (small ? 1 : 0);
		p_rise[t + 1] = p_rise[t] + (rise ? 1 : 0);
		p_counter[t + 1] = p_counter[t] + (rise && counter_changed(t) ? 1 : 0);
	}
	// churn: the small moves outside every rising stretch; when those are fewer than a span's own
	// moves, there is too little quiet history to tell, and churn is taken over the whole series
	const inside = new Uint8Array(n);
	for (const [lo, hi] of windows) for (let t = lo; t <= hi; t++) inside[t] = 1;
	let quiet_sq = 0;
	let quiet_cnt = 0;
	for (let t = 1; t < n; t++) {
		if (inside[t] || is_step(t)) continue;
		quiet_sq += d[t] * d[t];
		quiet_cnt++;
	}
	/** The small moves of [first, last], and how many churn deviations their sum is. */
	const span = (first: number, last: number) => {
		const sum = p_sum[last + 1] - p_sum[first];
		const moves = p_cnt[last + 1] - p_cnt[first];
		const [sq, cnt] = quiet_cnt >= moves ? [quiet_sq, quiet_cnt] : [p_sq[n], p_cnt[n]];
		const churn = Math.max(o.churn_floor_pct, cnt > 0 ? Math.sqrt(sq / cnt) : 0);
		return {
			sum,
			moves,
			churn,
			rises: p_rise[last + 1] - p_rise[first],
			counter_changes: p_counter[last + 1] - p_counter[first],
			z: moves > 0 ? sum / (churn * Math.sqrt(moves)) : 0
		};
	};

	const creeps: TrendCreep[] = [];
	for (const [lo, hi] of windows) {
		// the creep is the span of the window, from a rise to a rise, that beats churn the most:
		// a window's ends can hold churn the segmentation could not tell apart from the trend
		let first = -1;
		let last = -1;
		let s: ReturnType<typeof span> | null = null;
		for (let i = lo; i <= hi; i++) {
			if (is_step(i) || !(d[i] > EPS)) continue;
			for (let j = i; j <= hi; j++) {
				if (is_step(j) || !(d[j] > EPS)) continue;
				const c = span(i, j);
				if (s === null || c.z > s.z) {
					s = c;
					first = i;
					last = j;
				}
			}
		}
		if (s === null) continue;
		const { sum, rises, churn, z, counter_changes } = s;
		if (sum < 100 * Math.log(1 + o.min_rise) || rises < o.min_rises || z < o.min_z) continue;
		// what is left of it at the newest commit
		const kept = x[n - 1] - x[first - 1];
		let status: TrendCreep['status'] = last === n - 1 ? 'rising' : 'held';
		let reverted_at: string | null = null;
		if (last < n - 1 && kept <= sum / 2) {
			status = 'reverted';
			let low = 0;
			for (let t = last + 1; t < n; t++) {
				if (d[t] < low) {
					low = d[t];
					reverted_at = pts[t].sha;
				}
			}
		}
		creeps.push({
			start: pts[first].sha,
			end: pts[last].sha,
			start_index: first,
			end_index: last,
			commits: last - first + 1,
			rises,
			ratio: Math.exp(sum / 100) - 1,
			z: Math.round(z * 100) / 100,
			churn_pct: Math.round(churn * 1000) / 1000,
			status,
			reverted_at,
			counter_changes
		});
	}
	const verdict = creeps.length > 0 ? 'creep' : steps.length > 0 ? 'step' : 'flat';
	return { verdict, points: n, steps, creeps, pieces };
}
