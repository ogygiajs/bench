/*
 * Logistic regression with an L2 penalty, fitted by Newton's method, and the scores that check a
 * probability: AUC, Brier score and a reliability table. Small and exact on purpose: no random
 * start, no step size, no library. The same rows in the same order give the same weights to the
 * bit on one machine; the model file rounds them so it does not depend on the last bit either.
 */

export interface LogisticFit {
	/** One weight per feature, on the standardized features. */
	weights: number[];
	bias: number;
	/** Newton steps taken. */
	iterations: number;
}

export interface LogisticOptions {
	/** L2 penalty on the weights (not on the bias). */
	l2: number;
	max_iterations?: number;
	/** Stop when no weight moves by more than this. */
	tolerance?: number;
}

export function zeros(n: number): number[] {
	return Array.from({ length: n }, () => 0);
}

export function sigmoid(z: number): number {
	if (z >= 0) return 1 / (1 + Math.exp(-z));
	const e = Math.exp(z);
	return e / (1 + e);
}

/** Solve a x = b for a symmetric positive definite a (Cholesky); a and b are left as they were. */
export function solve_spd(a: number[][], b: number[]): number[] {
	const n = b.length;
	const l: number[][] = Array.from({ length: n }, () => zeros(n));
	for (let i = 0; i < n; i++) {
		for (let j = 0; j <= i; j++) {
			let s = a[i][j];
			for (let k = 0; k < j; k++) s -= l[i][k] * l[j][k];
			if (i === j) {
				if (!(s > 0)) throw new Error('heisenbench: the fit is singular (a feature is constant)');
				l[i][i] = Math.sqrt(s);
			} else {
				l[i][j] = s / l[j][j];
			}
		}
	}
	const y = zeros(n);
	for (let i = 0; i < n; i++) {
		let s = b[i];
		for (let k = 0; k < i; k++) s -= l[i][k] * y[k];
		y[i] = s / l[i][i];
	}
	const x = zeros(n);
	for (let i = n - 1; i >= 0; i--) {
		let s = y[i];
		for (let k = i + 1; k < n; k++) s -= l[k][i] * x[k];
		x[i] = s / l[i][i];
	}
	return x;
}

/** Fit P(y = 1) = sigmoid(bias + w . x). `x` rows are already standardized. */
export function fit_logistic(x: number[][], y: number[], opts: LogisticOptions): LogisticFit {
	const n = x.length;
	if (n === 0) throw new Error('heisenbench: no rows to fit');
	const d = x[0].length;
	const max_iterations = opts.max_iterations ?? 100;
	const tolerance = opts.tolerance ?? 1e-10;
	// theta[0] is the bias, theta[1..d] the weights
	let theta = zeros(d + 1);
	let iterations = 0;
	for (; iterations < max_iterations; iterations++) {
		const grad = zeros(d + 1);
		const hess: number[][] = Array.from({ length: d + 1 }, () => zeros(d + 1));
		for (let i = 0; i < n; i++) {
			let z = theta[0];
			for (let j = 0; j < d; j++) z += theta[j + 1] * x[i][j];
			const p = sigmoid(z);
			const r = p - y[i];
			const w = Math.max(p * (1 - p), 1e-12);
			const row = [1, ...x[i]];
			for (let j = 0; j <= d; j++) {
				grad[j] += r * row[j];
				const wj = w * row[j];
				for (let k = 0; k <= j; k++) hess[j][k] += wj * row[k];
			}
		}
		for (let j = 1; j <= d; j++) {
			grad[j] += opts.l2 * theta[j];
			hess[j][j] += opts.l2;
		}
		// a tiny ridge on the bias too: a set with one label only must not blow up
		hess[0][0] += 1e-9;
		for (let j = 0; j <= d; j++) for (let k = j + 1; k <= d; k++) hess[j][k] = hess[k][j];
		const step = solve_spd(hess, grad);
		let moved = 0;
		const next = theta.map((t, j) => {
			moved = Math.max(moved, Math.abs(step[j]));
			return t - step[j];
		});
		theta = next;
		if (moved < tolerance) {
			iterations++;
			break;
		}
	}
	return { bias: theta[0], weights: theta.slice(1), iterations };
}

export function predict_logistic(fit: { weights: number[]; bias: number }, x: number[]): number {
	let z = fit.bias;
	for (let j = 0; j < fit.weights.length; j++) z += fit.weights[j] * x[j];
	return sigmoid(z);
}

/** Mean and spread of each column; a constant column gets spread 1 (it then adds nothing). */
export function column_scales(x: number[][]): { mean: number[]; scale: number[] } {
	const d = x[0]?.length ?? 0;
	const mean = zeros(d);
	const scale = zeros(d);
	for (const row of x) for (let j = 0; j < d; j++) mean[j] += row[j] / x.length;
	for (const row of x) for (let j = 0; j < d; j++) scale[j] += (row[j] - mean[j]) ** 2 / x.length;
	for (let j = 0; j < d; j++) scale[j] = scale[j] > 1e-12 ? Math.sqrt(scale[j]) : 1;
	return { mean, scale };
}

export function standardize(row: number[], s: { mean: number[]; scale: number[] }): number[] {
	return row.map((v, j) => (v - s.mean[j]) / s.scale[j]);
}

/**
 * Area under the ROC curve: the chance a random positive scores above a random negative, ties
 * counted half. 0.5 is a coin; NaN when one class is missing.
 */
export function auc(p: number[], y: number[]): number {
	const idx = p.map((_, i) => i).sort((a, b) => p[a] - p[b]);
	let rank_sum = 0;
	let pos = 0;
	let i = 0;
	while (i < idx.length) {
		let j = i;
		while (j + 1 < idx.length && p[idx[j + 1]] === p[idx[i]]) j++;
		const rank = (i + j) / 2 + 1;
		for (let k = i; k <= j; k++) {
			if (y[idx[k]] === 1) {
				rank_sum += rank;
				pos++;
			}
		}
		i = j + 1;
	}
	const neg = y.length - pos;
	if (pos === 0 || neg === 0) return Number.NaN;
	return (rank_sum - (pos * (pos + 1)) / 2) / (pos * neg);
}

/** Mean squared gap between the probability and what happened (0 is perfect). */
export function brier(p: number[], y: number[]): number {
	let s = 0;
	for (let i = 0; i < p.length; i++) s += (p[i] - y[i]) ** 2;
	return s / p.length;
}

export interface ReliabilityBin {
	/** The bin's range of predicted probability, [from, to). */
	from: number;
	to: number;
	rows: number;
	/** Mean predicted probability of its rows, and the share that were positive. */
	predicted: number;
	observed: number;
}

/** Rows binned by predicted probability: honest odds have observed close to predicted. */
export function reliability(p: number[], y: number[], bins = 5): ReliabilityBin[] {
	const out: ReliabilityBin[] = [];
	for (let b = 0; b < bins; b++) {
		const from = b / bins;
		const to = (b + 1) / bins;
		let rows = 0;
		let sp = 0;
		let sy = 0;
		for (let i = 0; i < p.length; i++) {
			const inside = p[i] >= from && (p[i] < to || (b === bins - 1 && p[i] <= 1));
			if (!inside) continue;
			rows++;
			sp += p[i];
			sy += y[i];
		}
		out.push({
			from,
			to,
			rows,
			predicted: rows ? sp / rows : 0,
			observed: rows ? sy / rows : 0
		});
	}
	return out;
}
