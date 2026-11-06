/*
 * Curve class of steps over input scale (spec 9). Counts are exact, so a few sizes suffice: each
 * class is fitted as `steps = a + b * f(k)` (b >= 0, least squares on relative error, so the small
 * sizes count as much as the big ones) and the class with the smallest error wins; on a tie the
 * simpler class wins (constant data fits every class with b = 0).
 */

export type GrowthClass = 'constant' | 'log' | 'linear' | 'n log n' | 'quadratic' | 'worse';

export const GROWTH_RANK: Record<GrowthClass, number> = {
	constant: 0,
	log: 1,
	linear: 2,
	'n log n': 3,
	quadratic: 4,
	worse: 5
};

const MODELS: Array<[GrowthClass, (k: number) => number]> = [
	['constant', () => 0],
	['log', (k) => Math.log(k)],
	['linear', (k) => k],
	['n log n', (k) => k * Math.log(k)],
	['quadratic', (k) => k * k],
	['worse', (k) => k * k * k]
];

export interface Fit {
	class: GrowthClass;
	a: number;
	b: number;
	/** Root mean square relative error of the winning fit. */
	error: number;
	/** log-log slope between the two largest sizes (1 ~ linear, 2 ~ quadratic). */
	exponent: number;
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
	if (!(b > 0)) b = 0;
	const a = (Sy - b * Sf) / W;
	let err = 0;
	for (let i = 0; i < ks.length; i++) {
		const r = ys[i] - a - b * f(ks[i]);
		err += w[i] * r * r;
	}
	return { a, b, error: Math.sqrt(err / ks.length) };
}

export function fit_growth(ks: number[], ys: number[]): Fit {
	const n = ks.length;
	const exponent =
		n >= 2 && ys[n - 2] > 0 && ys[n - 1] > 0 && ks[n - 1] !== ks[n - 2]
			? Math.log(ys[n - 1] / ys[n - 2]) / Math.log(ks[n - 1] / ks[n - 2])
			: 0;
	let best: Fit | null = null;
	for (const [cls, f] of MODELS) {
		const r = fit_one(ks, ys, f);
		if (cls !== 'constant' && r.b === 0) continue;
		if (!best || r.error < best.error - 1e-9) best = { class: cls, ...r, exponent };
	}
	return best!;
}
