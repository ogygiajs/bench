/*
 * Curve class of steps over input scale (spec 9). Counts are exact, so a few sizes suffice: each
 * class is fitted as `steps = a + b * f(k)` (b >= 0, least squares on relative error, so the small
 * sizes count as much as the big ones) and the class with the smallest error wins; on a tie the
 * simpler class wins (constant data fits every class with b = 0).
 *
 * The classes past quadratic are named by their power: cubic (k^3), quartic (k^4), and beyond that
 * `polynomial` with the fitted power (`a + b * k^p`, p on a grid up to 12). Exponential growth
 * (`a + b * e^(c k)`) is told from a high power by its local slopes: on a ladder of sizes, the
 * log-log slope between neighbouring sizes keeps growing (by half again or more at each of the last
 * two steps), where a polynomial's settles towards its power; and the exponential model must fit
 * better than every power. It needs four sizes or more.
 *
 * Exact counts of one input scaled up never fall: steps that fall as the input grows are `shrinks`
 * (every step down) or `irregular` (up and down), and both mean the scaled input is likely not
 * valid input any more (a parser that stops at the first error), not a curve. Recorded calls of
 * different inputs are noisy instead: fit_noisy, below.
 *
 * The class is one name; how sure it is, is odds.ts (growth odds).
 */

import { noisy_odds, odds_superlinear } from './odds.ts';
import type { GrowthOdds, OddsOptions } from './odds.ts';

export type GrowthClass =
	| 'constant'
	| 'log'
	| 'linear'
	| 'n log n'
	| 'quadratic'
	| 'cubic'
	| 'quartic'
	| 'polynomial'
	| 'exponential'
	| 'shrinks'
	| 'irregular';

/** Order of the classes a PR can move between; `shrinks` and `irregular` have none. */
export const GROWTH_RANK: Record<GrowthClass, number | null> = {
	constant: 0,
	log: 1,
	linear: 2,
	'n log n': 3,
	quadratic: 4,
	cubic: 5,
	quartic: 6,
	polynomial: 7,
	exponential: 8,
	shrinks: null,
	irregular: null
};

/** Quadratic or worse: what a growth finding is about. */
export function is_superlinear(c: GrowthClass | null): boolean {
	const r = c === null ? null : GROWTH_RANK[c];
	return r !== null && r >= GROWTH_RANK.quadratic!;
}

const MODELS: Array<[GrowthClass, (k: number) => number]> = [
	['constant', () => 0],
	['log', (k) => Math.log(k)],
	['linear', (k) => k],
	['n log n', (k) => k * Math.log(k)],
	['quadratic', (k) => k * k],
	['cubic', (k) => k * k * k],
	['quartic', (k) => k * k * k * k]
];

/** A power past quartic is named `polynomial` with its fitted power. */
const POLYNOMIAL_FROM = 4.5;
const POWERS: number[] = [];
for (let p = 0.1; p <= 12.0001; p += 0.05) POWERS.push(Math.round(p * 100) / 100);
const RATES: number[] = [];
for (let i = 0; i <= 120; i++) RATES.push(1e-3 * Math.pow(10, i / 24));

export interface Fit {
	class: GrowthClass;
	a: number;
	b: number;
	/** Root mean square relative error of the winning fit. */
	error: number;
	/** log-log slope between the two largest sizes (1 ~ linear, 2 ~ quadratic). */
	exponent: number;
	/** p of the best `a + b * k^p` over every size (the power a `polynomial` is named by). */
	power: number;
}

function fit_one(
	ks: number[],
	ys: number[],
	f: (k: number) => number
): { a: number; b: number; error: number } {
	let W = 0;
	let Sf = 0;
	let Sy = 0;
	let Sff = 0;
	let Sfy = 0;
	const w = ys.map((y) => (y === 0 ? 1 : 1 / (y * y)));
	for (let i = 0; i < ks.length; i++) {
		const x = f(ks[i]);
		W += w[i];
		Sf += w[i] * x;
		Sy += w[i] * ys[i];
		Sff += w[i] * x * x;
		Sfy += w[i] * x * ys[i];
	}
	const den = W * Sff - Sf * Sf;
	let b = Math.abs(den) < 1e-300 ? 0 : (W * Sfy - Sf * Sy) / den;
	if (!(b > 0) || !Number.isFinite(b)) b = 0;
	const a = (Sy - b * Sf) / W;
	let err = 0;
	for (let i = 0; i < ks.length; i++) {
		const r = ys[i] - a - b * f(ks[i]);
		err += w[i] * r * r;
	}
	return { a, b, error: Math.sqrt(err / ks.length) };
}

/** The best `a + b * k^p` over the power grid. */
function fit_power(ks: number[], ys: number[]): { p: number; error: number } {
	let best = { p: 0, error: Infinity };
	for (const p of POWERS) {
		const r = fit_one(ks, ys, (k) => Math.pow(k, p));
		if (r.b > 0 && r.error < best.error - 1e-12) best = { p, error: r.error };
	}
	return best;
}

/** The best `a + b * e^(c k)` (k relative to the smallest size) over the rate grid. */
function fit_exponential(ks: number[], ys: number[]): number {
	const k0 = ks[0];
	const top = ks[ks.length - 1] / k0;
	let best = Infinity;
	for (const c of RATES) {
		if (c * top > 700) break;
		const r = fit_one(ks, ys, (k) => Math.exp(c * (k / k0)));
		if (r.b > 0 && r.error < best) best = r.error;
	}
	return best;
}

/** log-log slopes between neighbouring sizes. */
function local_slopes(ks: number[], ys: number[]): number[] {
	const out: number[] = [];
	for (let i = 0; i + 1 < ks.length; i++) {
		if (!(ys[i] > 0 && ys[i + 1] > 0) || ks[i + 1] === ks[i]) return [];
		out.push(Math.log(ys[i + 1] / ys[i]) / Math.log(ks[i + 1] / ks[i]));
	}
	return out;
}

/** The ratio test: every local slope rises, by half again or more at each of the last two steps. */
function slopes_explode(slopes: number[]): boolean {
	const n = slopes.length;
	if (n < 3 || !(slopes[0] > 0)) return false;
	for (let i = 1; i < n; i++) if (!(slopes[i] > slopes[i - 1])) return false;
	return slopes[n - 1] >= 1.5 * slopes[n - 2] && slopes[n - 2] >= 1.5 * slopes[n - 3];
}

/** Exact steps that fall: 'shrinks' (never up), 'irregular' (up and down), or null (they never fall). */
function falls(ys: number[]): 'shrinks' | 'irregular' | null {
	// a percent of slack: a branch taken once more or less at a bigger size is not a fall
	let down = false;
	let up = false;
	for (let i = 0; i + 1 < ys.length; i++) {
		if (ys[i + 1] < ys[i] * 0.99) down = true;
		else if (ys[i + 1] > ys[i] * 1.01) up = true;
	}
	if (!down) return null;
	return up ? 'irregular' : 'shrinks';
}

/** Exact counts of one input at several scales (`ks` ascending): its class. */
export function fit_growth(ks: number[], ys: number[]): Fit {
	const n = ks.length;
	const exponent =
		n >= 2 && ys[n - 2] > 0 && ys[n - 1] > 0 && ks[n - 1] !== ks[n - 2]
			? Math.log(ys[n - 1] / ys[n - 2]) / Math.log(ks[n - 1] / ks[n - 2])
			: 0;
	const power = fit_power(ks, ys);
	const fell = falls(ys);
	if (fell) {
		const mean = ys.reduce((s, y) => s + y, 0) / Math.max(1, n);
		return { class: fell, a: mean, b: 0, error: 0, exponent, power: power.p };
	}
	let best: Fit | null = null;
	for (const [cls, f] of MODELS) {
		const r = fit_one(ks, ys, f);
		if (cls !== 'constant' && r.b === 0) continue;
		if (!best || r.error < best.error - 1e-9) best = { class: cls, ...r, exponent, power: power.p };
	}
	const fit = best!;
	if (n >= 4 && slopes_explode(local_slopes(ks, ys))) {
		const e = fit_exponential(ks, ys);
		if (e < Math.min(fit.error, power.error)) return { ...fit, class: 'exponential', error: e };
	}
	if (power.p >= POLYNOMIAL_FROM && power.error <= fit.error && GROWTH_RANK[fit.class]! >= 5) {
		return { ...fit, class: 'polynomial', error: power.error };
	}
	return fit;
}

/*
 * Noisy points: recorded calls of different inputs. Two inputs of one size can cost very different
 * steps (one compiles a page with one island, the other one with twenty), and a model fitted on
 * relative error is pulled around by the many small calls. So the curve is read the robust way:
 *
 *   power   the least-squares slope of log(steps) over log(size): steps ~ size^power
 *   r2      how much of log(steps) that line explains
 *   trend   Kendall's tau between size and steps per unit of size: above 0, the work per input
 *           unit grows with the input (a line with a constant part gives -1: the constant spreads)
 *
 * The class is named by the power (POWER_CLASSES). Whether the curve is superlinear (a finding) is
 * read from its odds (odds.ts noisy_odds: the power fitted with Student-t errors, so one call that
 * took a short path weighs little): at least SUPERLINEAR_ODDS of quadratic or worse.
 */

/** Upper power bound of each class, for noisy points. */
const POWER_CLASSES: Array<[number, GrowthClass]> = [
	[0.2, 'constant'],
	[0.8, 'log'],
	[1.2, 'linear'],
	[1.5, 'n log n'],
	[2.5, 'quadratic'],
	[3.5, 'cubic'],
	[POLYNOMIAL_FROM, 'quartic']
];
export const SUPERLINEAR_POWER = 1.5;
export const MIN_R2 = 0.8;

export interface NoisyFit {
	class: GrowthClass;
	power: number;
	r2: number;
	trend: number;
	/** Odds of each shape (null with under three points). */
	odds: GrowthOdds | null;
	/** The odds of quadratic or worse are at least the bar (SUPERLINEAR_ODDS). */
	superlinear: boolean;
}

function kendall_tau(xs: number[], ys: number[]): number {
	let c = 0;
	let d = 0;
	let tx = 0;
	let ty = 0;
	for (let i = 0; i < xs.length; i++) {
		for (let j = i + 1; j < xs.length; j++) {
			const a = Math.sign(xs[j] - xs[i]);
			const b = Math.sign(ys[j] - ys[i]);
			if (a === 0 && b === 0) continue;
			if (a === 0) tx++;
			else if (b === 0) ty++;
			else if (a === b) c++;
			else d++;
		}
	}
	const den = Math.sqrt((c + d + tx) * (c + d + ty));
	return den > 0 ? (c - d) / den : 0;
}

/** Slope and r2 of log(y) over log(x). */
function log_line(lx: number[], ly: number[]): { power: number; r2: number } {
	const n = lx.length;
	let mx = 0;
	let my = 0;
	for (let i = 0; i < n; i++) {
		mx += lx[i];
		my += ly[i];
	}
	mx /= n;
	my /= n;
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	for (let i = 0; i < n; i++) {
		sxy += (lx[i] - mx) * (ly[i] - my);
		sxx += (lx[i] - mx) ** 2;
		syy += (ly[i] - my) ** 2;
	}
	return {
		power: sxx > 0 ? sxy / sxx : 0,
		r2: sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 1
	};
}

/** The curve of noisy points (sizes > 0, any order), and its odds. */
export function fit_noisy(xs: number[], ys: number[], opts: OddsOptions = {}): NoisyFit {
	const lx = xs.map((x) => Math.log(x));
	const ly = ys.map((y) => Math.log(Math.max(y, 1)));
	const { power, r2 } = log_line(lx, ly);
	const trend = kendall_tau(
		xs,
		ys.map((y, i) => y / xs[i])
	);
	const odds = noisy_odds(xs, ys, opts);
	const cls = POWER_CLASSES.find(([top]) => power < top)?.[1] ?? 'polynomial';
	const r = (v: number) => Math.round(v * 1000) / 1000;
	return {
		class: cls,
		power: r(power),
		r2: r(r2),
		trend: r(trend),
		odds,
		superlinear: odds_superlinear(odds, opts)
	};
}

/** The words for a class: `polynomial n^5.2`, `irregular: the scaled input may be invalid`. */
export function growth_label(c: GrowthClass | null, power?: number): string {
	if (c === null) return 'unknown';
	if (c === 'polynomial') return `polynomial n^${power === undefined ? '?' : power.toFixed(1)}`;
	if (c === 'irregular') return 'irregular: the scaled input may be invalid';
	if (c === 'shrinks') return 'shrinks: the scaled input may be invalid';
	return c;
}
