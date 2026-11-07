/*
 * Growth shape as odds (spec 9). fit.ts names one class per curve; this says how sure that is:
 * `quadratic 93%, n log n 7%`. Counts are exact, but a curve has few sizes, so the doubt is about
 * which curve made the points, not about noise in them. Every shape is a model of the points; each
 * model's evidence (how likely it makes the points, averaged over its own parameters) times the
 * shape's prior (priors.ts: how often it shows up) gives its odds. Same points, same odds, byte for
 * byte: the averages are sums over fixed grids, with no sampling and no randomness.
 *
 * Exact points (one input scaled: bench growth, or the largest recorded input scaled), exact_odds:
 *
 *   model      steps = scale * (a fixed part + the shape's own term). The own term's share of the
 *              steps at the largest size is at least OWN_SHARE (a shape that does not show where it
 *              was measured is not what the points say), uniform between that and all of them.
 *   + linear   for n log n and every shape past it, also a version with a linear part beside the
 *              own term (real code is a sum: a quadratic loop inside a linear pass), with half the
 *              shape's prior (LINEAR_PART). It is read only when no single term fits the points
 *              (FITS); when one does, the version with more parts adds next to nothing. On three
 *              sizes it fits any rising points exactly, so odds that rest on it are `thin`: a close
 *              call, which one more size tests.
 *   misfit     relative, on log steps: SIGMA (the terms are simple functions of the scale factor;
 *              real code's are close, not equal: n log n in its log base, a branch more or less),
 *              plus one step of rounding, which matters only for tiny counts.
 *   evidence   the likelihood averaged over the shares (and over the power of `polynomial`, the rate
 *              of `exponential`) on fixed grids, finer next to the best node; the overall scale
 *              integrated out exactly. A model with more parts spreads its prior over more ways the
 *              points could have come out, so it wins only when it fits better (no extra penalty).
 *   late start a scaled input can take another path from some size on (a branch that starts once the
 *              input is long enough): steps exactly flat (FLAT) up to a measured size, then one shape
 *              from there. Its prior is PATH_CHANGE; the shape after it is mostly the prior's when
 *              one rising step shows it.
 *
 * A path the code stopped taking (a function that ran at one size and not at the next: the scaled
 * input stopped being valid and the code returns early) is a different program from there on: the
 * caller reads the odds from that size up (path_from), with three sizes or more there.
 *
 * Exponential needs four sizes or more (as in fit_growth: three cannot tell e^k from a high power).
 *
 * Noisy points (recorded calls of different inputs), noisy_odds: steps ~ size^power, fitted on log
 * steps over log size with Student-t errors (NOISY_DOF: a call that took a short path, or an odd
 * input, weighs little; the smallest calls, which pull the line most, are left out when they took a
 * short path: SHORT_PATH), the power's posterior a Student t around the fit. Each shape is a band of
 * powers (NOISY_BANDS) with its prior spread evenly over the band; its odds are its prior times the
 * posterior mass on the band.
 *
 * `superlinear` is the odds of quadratic or worse: a growth finding needs at least SUPERLINEAR_ODDS
 * of it (recorded.ts; configurable).
 */

import { DEFAULT_PRIOR, PATH_CHANGE } from './priors.ts';
import type { ShapePrior } from './priors.ts';

export type Shape =
	| 'constant'
	| 'log'
	| 'linear'
	| 'n log n'
	| 'quadratic'
	| 'cubic'
	| 'quartic'
	| 'polynomial'
	| 'exponential';

export const SHAPES: readonly Shape[] = [
	'constant',
	'log',
	'linear',
	'n log n',
	'quadratic',
	'cubic',
	'quartic',
	'polynomial',
	'exponential'
];

const SUPERLINEAR_SHAPES: ReadonlySet<Shape> = new Set([
	'quadratic',
	'cubic',
	'quartic',
	'polynomial',
	'exponential'
]);

/** Odds of quadratic or worse a recorded-growth finding needs (configurable). */
export const SUPERLINEAR_ODDS = 0.9;
/** Below this on its likeliest shape, a scaled curve is counted at one more size (active sizing). */
export const CLOSE_CALL = 0.9;
/** Relative misfit of exact points to their shape's terms. */
export const SIGMA = 0.015;
/** Relative misfit of the flat part of a late start: the same work, give or take a step. */
export const FLAT = 0.005;
/**
 * Least share of the steps at the largest size a shape's own term makes: a large fixed part with a
 * small linear one is still linear (a function that parses its options, then walks a short list).
 */
export const OWN_SHARE = 0.01;
/** Prior that n log n or a shape past it has a linear part beside its own term. */
export const LINEAR_PART = 0.5;
/** Misfit (in SIGMAs, squared and summed) past which no single term fits the points. */
export const FITS = 4;
/** Degrees of freedom of the Student-t errors of noisy points. */
export const NOISY_DOF = 3;

export interface GrowthOdds {
	/** Every shape with odds of at least 0.001, most likely first (3 places). */
	odds: Array<{ shape: Shape; p: number }>;
	/** Odds of quadratic or worse. */
	superlinear: number;
	/** Exact points: odds that a branch starts at a measured size (flat, then rising). */
	late?: number;
	/**
	 * Exact points: the odds rest on a model with a linear part on three sizes, which fits any
	 * three rising points exactly. Always a close call: one more size tests it.
	 */
	thin?: boolean;
	/** Points the odds were read from. */
	points: number;
}

export interface OddsOptions {
	prior?: ShapePrior;
	/** Odds of superlinear growth a finding needs (default SUPERLINEAR_ODDS). */
	min_odds?: number;
	/** Exact points: prior of a late start (default PATH_CHANGE). */
	path_change?: number;
	/** Exact points: relative misfit (default SIGMA). */
	sigma?: number;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** `quadratic 93%, n log n 7%`: the likeliest shapes down to 1%, at most `max`. */
export function odds_words(o: GrowthOdds | null | undefined, max = 3): string {
	if (!o) return '';
	return o.odds
		.filter((x) => x.p >= 0.01)
		.slice(0, max)
		.map((x) => `${x.shape} ${pct(x.p)}`)
		.join(', ');
}

/** 0.934 -> `93%`; never a false `100%` or `0%`: `>99%`, `<1%`. */
export function pct(p: number): string {
	if (p > 0.995) return '>99%';
	if (p < 0.005) return '<1%';
	return `${Math.round(p * 100)}%`;
}

/** The likeliest shape, or null. */
export function top_shape(o: GrowthOdds | null | undefined): Shape | null {
	return o && o.odds.length > 0 ? o.odds[0].shape : null;
}

/** The likeliest shape has under `below`, or the odds are thin: one more size would help. */
export function close_call(o: GrowthOdds | null | undefined, below = CLOSE_CALL): boolean {
	return !!o && o.odds.length > 0 && (o.odds[0].p < below || o.thin === true);
}

/** The odds say superlinear, at the configured bar. */
export function odds_superlinear(
	o: GrowthOdds | null | undefined,
	opts: OddsOptions = {}
): boolean {
	return !!o && o.superlinear >= (opts.min_odds ?? SUPERLINEAR_ODDS);
}

/**
 * The one more size active sizing counts: between the two largest (their geometric mean, to one
 * significant digit: 30x between 10x and 100x, 8x between 4x and 16x), or null when there is no
 * whole size between them.
 */
export function probe_size(sizes: readonly number[]): number | null {
	const n = sizes.length;
	if (n < 2) return null;
	const mid = Math.sqrt(sizes[n - 1] * sizes[n - 2]);
	const mag = Math.pow(10, Math.floor(Math.log10(mid)));
	const k = Math.round(mid / mag) * mag;
	return k > sizes[n - 2] && k < sizes[n - 1] ? k : null;
}

/** Log-evidence per shape (several models each) into rounded, sorted odds. */
function finish(scores: Map<Shape, number[]>, points: number, late?: number[]): GrowthOdds | null {
	let top = -Infinity;
	for (const list of scores.values()) for (const s of list) if (s > top) top = s;
	if (!Number.isFinite(top)) return null;
	const mass = new Map<Shape, number>();
	let total = 0;
	for (const shape of SHAPES) {
		let m = 0;
		for (const s of scores.get(shape) ?? []) m += Math.exp(s - top);
		mass.set(shape, m);
		total += m;
	}
	let sup = 0;
	for (const shape of SUPERLINEAR_SHAPES) sup += mass.get(shape)! / total;
	const odds = SHAPES.map((shape) => ({ shape, p: mass.get(shape)! / total }))
		.filter((x) => x.p >= 0.0005)
		.sort((a, b) => b.p - a.p || SHAPES.indexOf(a.shape) - SHAPES.indexOf(b.shape))
		.map((x) => ({ shape: x.shape, p: r3(x.p) }));
	const out: GrowthOdds = { odds, superlinear: r3(sup), points };
	if (late) {
		let l = 0;
		for (const s of late) l += Math.exp(s - top);
		out.late = r3(l / total);
	}
	return out;
}

/** ln of a sum of exps. */
function log_sum(xs: readonly number[]): number {
	let top = -Infinity;
	for (const x of xs) if (x > top) top = x;
	if (!Number.isFinite(top)) return top;
	let s = 0;
	for (const x of xs) s += Math.exp(x - top);
	return top + Math.log(s);
}

/* ---------------------------------------------------------------- exact points */

/**
 * A uniform parameter on [a, b], averaged over on fixed nodes: each node stands for its cell (from
 * the midpoint before it to the one after), weighted by the cell's share of [a, b].
 */
interface Grid {
	x: number[];
	lo: number[];
	hi: number[];
	/** ln of each cell's share */
	lw: number[];
	/** ln of 1 / (b - a) */
	ld: number;
}

function grid(nodes: Iterable<number>, a: number, b: number): Grid {
	const x = [...new Set(nodes)].filter((v) => v >= a && v <= b).sort((p, q) => p - q);
	const lo = x.map((v, i) => (i === 0 ? a : (x[i - 1] + v) / 2));
	const hi = x.map((v, i) => (i + 1 === x.length ? b : (v + x[i + 1]) / 2));
	return {
		x,
		lo,
		hi,
		lw: x.map((_, i) => Math.log((hi[i] - lo[i]) / (b - a))),
		ld: -Math.log(b - a)
	};
}

/**
 * A share in [lo, 1]: even steps, steps that get finer towards 1 (a curve whose fixed part is a
 * tiny share at the largest size needs them: 2k^2 + 30k + 4 at 100x is 99.98% its own terms), and
 * steps that get finer towards lo (a large fixed part with a small growing one).
 */
function share_grid(lo: number, even: number, per_decade: number): Grid {
	const nodes: number[] = [];
	for (let i = 0; i <= even; i++) nodes.push(lo + ((1 - lo) * i) / even);
	for (let e = Math.log10(1 - lo); e >= -12; e -= 1 / per_decade) nodes.push(1 - Math.pow(10, e));
	for (let e = Math.log10(lo); e <= 0; e += 1 / per_decade) nodes.push(Math.pow(10, e));
	return grid(nodes, lo, 1);
}

/** A fraction in [0, 1], finer towards both ends. */
function unit_grid(even: number, per_decade: number): Grid {
	const nodes: number[] = [0, 1];
	for (let i = 1; i < even; i++) nodes.push(i / even);
	for (let e = -1; e >= -10; e -= 1 / per_decade) nodes.push(Math.pow(10, e), 1 - Math.pow(10, e));
	return grid(nodes, 0, 1);
}

const OWN = share_grid(OWN_SHARE, 200, 20);
const OWN2 = share_grid(OWN_SHARE, 40, 8);
const SPLIT = unit_grid(20, 5);
/** Sub-steps per side of a cell next to the best node, which the average reads finer. */
const FINE = 24;

/**
 * ln of the average of exp(f) over a grid, and the best f. The cells next to the best node are read
 * FINE times finer: with exact counts the likelihood can be a narrow peak between two nodes.
 */
function average_1d(g: Grid, f: (x: number) => number): { ln: number; best: number } {
	const vals = g.x.map(f);
	let at = 0;
	for (let i = 1; i < vals.length; i++) if (vals[i] > vals[at]) at = i;
	const parts: number[] = [];
	for (let i = 0; i < vals.length; i++) {
		if (Math.abs(i - at) > 1) {
			parts.push(vals[i] + g.lw[i]);
			continue;
		}
		const step = (g.hi[i] - g.lo[i]) / FINE;
		for (let s = 0; s < FINE; s++)
			parts.push(f(g.lo[i] + (s + 0.5) * step) + Math.log(step) + g.ld);
	}
	return { ln: log_sum(parts), best: vals[at] };
}

/** The same over two parameters, each uniform on its own grid. */
function average_2d(gu: Grid, gt: Grid, f: (u: number, t: number) => number): number {
	const nu = gu.x.length;
	const nt = gt.x.length;
	const vals = new Float64Array(nu * nt);
	let at = 0;
	for (let i = 0; i < nu; i++)
		for (let j = 0; j < nt; j++) {
			const v = f(gu.x[i], gt.x[j]);
			vals[i * nt + j] = v;
			if (v > vals[at]) at = i * nt + j;
		}
	const ai = Math.floor(at / nt);
	const aj = at % nt;
	const parts: number[] = [];
	const sub = FINE / 2;
	for (let i = 0; i < nu; i++)
		for (let j = 0; j < nt; j++) {
			if (Math.abs(i - ai) > 1 || Math.abs(j - aj) > 1) {
				parts.push(vals[i * nt + j] + gu.lw[i] + gt.lw[j]);
				continue;
			}
			const su = (gu.hi[i] - gu.lo[i]) / sub;
			const st = (gt.hi[j] - gt.lo[j]) / sub;
			const lw = Math.log(su) + gu.ld + Math.log(st) + gt.ld;
			for (let a = 0; a < sub; a++)
				for (let b = 0; b < sub; b++)
					parts.push(f(gu.lo[i] + (a + 0.5) * su, gt.lo[j] + (b + 0.5) * st) + lw);
		}
	return log_sum(parts);
}

type Term = (k: number) => number;
const LOG: Term = (k) => Math.log(k);
const LIN: Term = (k) => k;
const NLOGN: Term = (k) => k * Math.log(k);
const pow =
	(p: number): Term =>
	(k) =>
		Math.pow(k, p);

/** The powers of `polynomial` (past quartic) and rates of `exponential`. */
const POLY_POWERS: number[] = [];
for (let p = 4.5; p <= 12.0001; p += 0.25) POLY_POWERS.push(Math.round(p * 100) / 100);
const EXP_RATES: number[] = [];
for (let i = 0; i <= 45; i++) EXP_RATES.push(1e-2 * Math.pow(10, i / 15));

interface Points {
	ly: number[];
	omega: number[];
	/** sum of ln(omega)/2 - ln(sum omega)/2: the part of the evidence the weights alone set */
	norm: number;
}

function points(ys: number[], sigma: number[]): Points {
	const omega = ys.map((y, i) => 1 / (sigma[i] * sigma[i] + 1 / (y * y)));
	let sw = 0;
	let half_ln = 0;
	for (const w of omega) {
		sw += w;
		half_ln += 0.5 * Math.log(w);
	}
	return { ly: ys.map((y) => Math.log(y)), omega, norm: half_ln - 0.5 * Math.log(sw) };
}

/** -misfit/2 for a prediction (the overall scale at its best, which integrating it out leaves). */
function fit_score(p: Points, pred: Float64Array | number[]): number {
	let sw = 0;
	let sd = 0;
	let sdd = 0;
	for (let i = 0; i < p.ly.length; i++) {
		const m = pred[i];
		if (!(m > 0)) return -Infinity;
		const d = p.ly[i] - Math.log(m);
		const w = p.omega[i];
		sw += w;
		sd += w * d;
		sdd += w * d * d;
	}
	return -0.5 * (sdd - (sd * sd) / sw);
}

/** Each term scaled to 1 at the largest size (or left as it is when 0 there). */
function column(ks: number[], f: Term): number[] {
	const v = ks.map(f);
	const last = v[v.length - 1];
	return last > 0 ? v.map((x) => x / last) : v;
}

/**
 * Evidence of `fixed + own`, the own share uniform on [OWN_SHARE, 1], and the best misfit's score
 * (-misfit / 2).
 */
function two_part(p: Points, own: number[]): { ln: number; best: number } {
	const n = own.length;
	const pred = new Float64Array(n);
	const r = average_1d(OWN, (u) => {
		for (let i = 0; i < n; i++) pred[i] = 1 - u + u * own[i];
		return fit_score(p, pred);
	});
	return { ln: r.ln + p.norm, best: r.best };
}

/** Evidence of `fixed + linear + own`: the own share as in two_part, the rest split evenly at random. */
function three_part(p: Points, lin: number[], own: number[]): number {
	const n = own.length;
	const pred = new Float64Array(n);
	return (
		average_2d(OWN2, SPLIT, (u, t) => {
			const v = (1 - u) * t;
			for (let i = 0; i < n; i++) pred[i] = 1 - u - v + v * lin[i] + u * own[i];
			return fit_score(p, pred);
		}) + p.norm
	);
}

/**
 * Where the last path starts: the index of the first size from which every size ran the same
 * functions it ran before or more (`ran[i]`: the functions with steps at size i). A function that
 * ran at size i - 1 and not at size i means the code took another path from size i (the scaled
 * input stopped being valid input, say, and the code returns early): sizes before it say nothing
 * about the curve after it.
 */
export function path_from(ran: ReadonlyArray<ReadonlySet<string>>): number {
	let from = 0;
	for (let i = 1; i < ran.length; i++) {
		for (const id of ran[i - 1]) {
			if (!ran[i].has(id)) {
				from = i;
				break;
			}
		}
	}
	return from;
}

/**
 * Odds of each shape for exact counts of one input at several scales (`ks` ascending, > 0). Null
 * when the steps fall as the input grows (shrinks / irregular: fit.ts says why) or fewer than two
 * sizes ran the code. Sizes before the first that ran it (steps 0) are left out: it starts there.
 */
export function exact_odds(ks: number[], ys: number[], opts: OddsOptions = {}): GrowthOdds | null {
	const prior = opts.prior ?? DEFAULT_PRIOR;
	const sigma = opts.sigma ?? SIGMA;
	const path_change = opts.path_change ?? PATH_CHANGE;
	let first = 0;
	while (first < ys.length && !(ys[first] > 0)) first++;
	const k = ks.slice(first);
	const y = ys.slice(first);
	const n = y.length;
	if (n < 2) return null;
	for (let i = 0; i + 1 < n; i++) if (y[i + 1] < y[i] * 0.99 || !(k[i + 1] > k[i])) return null;
	const p = points(
		y,
		y.map(() => sigma)
	);
	const scores = new Map<Shape, number[]>();
	const add = (shape: Shape, s: number) => {
		if (!scores.has(shape)) scores.set(shape, []);
		scores.get(shape)!.push(s);
	};
	const smooth = Math.log(1 - path_change);
	const lp = (shape: Shape) => Math.log(prior[shape] ?? 0);
	const lin = column(k, LIN);

	const flat = fit_score(
		p,
		y.map(() => 1)
	);
	add('constant', smooth + lp('constant') + flat + p.norm);

	const models: Array<[Shape, Term[], boolean]> = [
		['log', [LOG], false],
		['linear', [LIN], false],
		['n log n', [NLOGN], true],
		['quadratic', [pow(2)], true],
		['cubic', [pow(3)], true],
		['quartic', [pow(4)], true],
		['polynomial', POLY_POWERS.map(pow), true]
	];
	if (n >= 4) {
		const top = k[n - 1];
		models.push([
			'exponential',
			EXP_RATES.filter((c) => (c * top) / k[0] <= 700).map(
				(c) => (x: number) => Math.exp((c * (x - top)) / k[0])
			),
			true
		]);
	}
	// one term beside the fixed part
	const owns = new Map<Shape, number[][]>();
	const single = new Map<Shape, number[]>();
	let best = flat;
	for (const [shape, tops, linear_part] of models) {
		if (!(prior[shape] > 0)) continue;
		const cols = tops.map((f) => column(k, f));
		owns.set(shape, cols);
		const alone = linear_part ? Math.log(1 - LINEAR_PART) : 0;
		single.set(
			shape,
			cols.map((own) => {
				const r = two_part(p, own);
				if (r.best > best) best = r.best;
				return alone + r.ln;
			})
		);
	}
	// a linear part beside it, read only when no single term fits (misfit over FITS): when one does,
	// the extra part's evidence is a small fraction of it
	const linear_too = n >= 3 && best < -FITS / 2;
	for (const [shape, tops, linear_part] of models) {
		const per = single.get(shape);
		if (!per) continue;
		if (linear_part && linear_too)
			for (const own of owns.get(shape)!) per.push(Math.log(LINEAR_PART) + three_part(p, lin, own));
		// a free power or rate: each of its grid values equally likely
		add(shape, smooth + lp(shape) + log_sum(per) - Math.log(tops.length));
	}

	// late start: flat up to size j (two sizes or more), one shape from there
	const late: number[] = [];
	if (n >= 3 && path_change > 0) {
		const after: Array<[Shape, Term]> = [
			['log', LOG],
			['linear', LIN],
			['n log n', NLOGN],
			['quadratic', pow(2)],
			['cubic', pow(3)],
			['quartic', pow(4)]
		];
		let mass = 0;
		for (const [shape] of after) mass += prior[shape] ?? 0;
		for (let j = 1; j + 1 < n; j++) {
			const pj = points(
				y,
				y.map((_, i) => (i <= j ? FLAT : sigma))
			);
			for (const [shape, f] of after) {
				if (!(prior[shape] > 0)) continue;
				const own = column(k, (x) => Math.max(0, f(x) - f(k[j])));
				const s =
					Math.log(path_change) -
					Math.log(n - 2) +
					Math.log(prior[shape] / mass) +
					two_part(pj, own).ln;
				add(shape, s);
				late.push(s);
			}
		}
	}
	const out = finish(scores, n, late);
	if (out && linear_too && n <= 3) out.thin = true;
	return out;
}

/* ---------------------------------------------------------------- noisy points */

/** The band of powers each shape stands for, for noisy points (fit.ts POWER_CLASSES). */
export const NOISY_BANDS: Array<[Shape, number, number]> = [
	['constant', -1, 0.2],
	['log', 0.2, 0.8],
	['linear', 0.8, 1.2],
	['n log n', 1.2, 1.5],
	['quadratic', 1.5, 2.5],
	['cubic', 2.5, 3.5],
	['quartic', 3.5, 4.5],
	['polynomial', 4.5, 12]
];

/**
 * The power of noisy points under Student-t errors (iteratively reweighted least squares, a fixed
 * number of rounds), and its posterior's scale; null with under three points or one size only.
 */
export function robust_power(
	lx: readonly number[],
	ly: readonly number[]
): { at: number; scale: number; dof: number; line: (lx: number) => number } | null {
	const n = lx.length;
	if (n < 3) return null;
	let sxx_plain = 0;
	let mean = 0;
	for (const x of lx) mean += x / n;
	for (const x of lx) sxx_plain += (x - mean) ** 2;
	if (!(sxx_plain > 0)) return null;
	const nu = NOISY_DOF;
	let w = lx.map(() => 1);
	let at = 0;
	let s2 = 1;
	let mx = 0;
	let my = 0;
	for (let round = 0; round < 50; round++) {
		let W = 0;
		mx = 0;
		my = 0;
		for (let i = 0; i < n; i++) {
			W += w[i];
			mx += w[i] * lx[i];
			my += w[i] * ly[i];
		}
		mx /= W;
		my /= W;
		let sxx = 0;
		let sxy = 0;
		for (let i = 0; i < n; i++) {
			sxx += w[i] * (lx[i] - mx) ** 2;
			sxy += w[i] * (lx[i] - mx) * (ly[i] - my);
		}
		at = sxx > 0 ? sxy / sxx : 0;
		const res = lx.map((x, i) => ly[i] - my - at * (x - mx));
		let ss = 0;
		for (let i = 0; i < n; i++) ss += w[i] * res[i] * res[i];
		// a perfect line still has a width: one part in a thousand of log steps
		s2 = Math.max(ss / n, 1e-6);
		w = res.map((r) => (nu + 1) / (nu + (r * r) / s2));
	}
	// the slope's posterior scale: the t errors' information, with a small-sample correction
	const scale = Math.sqrt(((s2 * (nu + 3)) / (nu + 1) / sxx_plain) * (n / Math.max(1, n - 2)));
	const [cx, cy, slope] = [mx, my, at];
	return { at, scale, dof: Math.max(1, n - 2), line: (x) => cy + slope * (x - cx) };
}

/** A call that cost under 1 / SHORT_PATH of what the other calls' line says took a short path. */
export const SHORT_PATH = 4;

/** Odds of noisy points from the power's posterior. */
function power_odds(xs: number[], ys: number[], prior: ShapePrior): GrowthOdds | null {
	const post = robust_power(
		xs.map((x) => Math.log(x)),
		ys.map((y) => Math.log(Math.max(y, 1)))
	);
	if (!post) return null;
	const scores = new Map<Shape, number[]>();
	for (const [shape, lo, hi] of NOISY_BANDS) {
		const pr = prior[shape] ?? 0;
		const m =
			(pr / (hi - lo)) *
			(t_cdf((hi - post.at) / post.scale, post.dof) - t_cdf((lo - post.at) / post.scale, post.dof));
		scores.set(shape, [m > 0 ? Math.log(m) : -Infinity]);
	}
	return finish(scores, xs.length);
}

/**
 * Odds of each shape for noisy points (sizes > 0, any order): recorded calls of different inputs.
 * Null with under three points. Errors far off the line weigh little (Student t), except at the
 * ends, where one call pulls the line most: the calls at the smallest size that took a short path
 * (an empty or trivial input returns at once: under 1 / SHORT_PATH of what the line through the
 * other calls says) are left out, with four calls or more past them.
 */
export function noisy_odds(xs: number[], ys: number[], opts: OddsOptions = {}): GrowthOdds | null {
	const prior = opts.prior ?? DEFAULT_PRIOR;
	const lo = Math.min(...xs);
	const keep = xs.map((_, i) => i).filter((i) => xs[i] > lo);
	if (keep.length >= 4) {
		const rest = robust_power(
			keep.map((i) => Math.log(xs[i])),
			keep.map((i) => Math.log(Math.max(ys[i], 1)))
		);
		const short =
			rest !== null &&
			xs.every(
				(x, i) =>
					x > lo || Math.log(Math.max(ys[i], 1)) < rest.line(Math.log(x)) - Math.log(SHORT_PATH)
			);
		if (short)
			return power_odds(
				keep.map((i) => xs[i]),
				keep.map((i) => ys[i]),
				prior
			);
	}
	return power_odds(xs, ys, prior);
}

/* ---------------------------------------------------------------- Student t */

/** ln Gamma (x > 0): Stirling's series past 8, the recurrence below it. */
function ln_gamma(x: number): number {
	let shift = 0;
	while (x < 8) {
		shift -= Math.log(x);
		x += 1;
	}
	const r = 1 / (x * x);
	const series = (1 / 12 - r * (1 / 360 - r * (1 / 1260 - r / 1680))) / x;
	return shift + (x - 0.5) * Math.log(x) - x + 0.5 * Math.log(2 * Math.PI) + series;
}

/** Continued fraction of the incomplete beta (modified Lentz). */
function beta_cf(a: number, b: number, x: number): number {
	const tiny = 1e-300;
	let c = 1;
	let d = 1 - ((a + b) * x) / (a + 1);
	if (Math.abs(d) < tiny) d = tiny;
	d = 1 / d;
	let h = d;
	for (let m = 1; m <= 300; m++) {
		const m2 = 2 * m;
		let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
		d = 1 + aa * d;
		if (Math.abs(d) < tiny) d = tiny;
		c = 1 + aa / c;
		if (Math.abs(c) < tiny) c = tiny;
		d = 1 / d;
		h *= d * c;
		aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
		d = 1 + aa * d;
		if (Math.abs(d) < tiny) d = tiny;
		c = 1 + aa / c;
		if (Math.abs(c) < tiny) c = tiny;
		d = 1 / d;
		const del = d * c;
		h *= del;
		if (Math.abs(del - 1) < 1e-14) break;
	}
	return h;
}

/** Regularized incomplete beta I_x(a, b). */
function beta_inc(a: number, b: number, x: number): number {
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	const front = Math.exp(
		ln_gamma(a + b) - ln_gamma(a) - ln_gamma(b) + a * Math.log(x) + b * Math.log(1 - x)
	);
	if (x < (a + 1) / (a + b + 2)) return (front * beta_cf(a, b, x)) / a;
	return 1 - (front * beta_cf(b, a, 1 - x)) / b;
}

/** CDF of Student's t with `dof` degrees of freedom. */
export function t_cdf(t: number, dof: number): number {
	if (t === Infinity) return 1;
	if (t === -Infinity) return 0;
	const x = dof / (dof + t * t);
	const tail = 0.5 * beta_inc(dof / 2, 0.5, x);
	return t > 0 ? 1 - tail : tail;
}
