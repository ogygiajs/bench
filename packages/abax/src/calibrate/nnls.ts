/*
 * Non-negative least squares (Lawson & Hanson): x >= 0 minimizing ||A x - b||. Used to turn op
 * counts into nanoseconds (no op kind may cost negative time) and to fit built-in price curves.
 * A is row-major: rows = observations, columns = features. Sizes here are small (tens of
 * features, hundreds of rows), so the passive-set solves use plain normal equations.
 */

/** Solve the least squares problem on the columns in `cols` only (normal equations). */
function solve_subset(a: number[][], b: number[], cols: number[]): number[] {
	const k = cols.length;
	const m = a.length;
	const ata: number[][] = Array.from({ length: k }, () => Array.from({ length: k }, () => 0));
	const atb: number[] = Array.from({ length: k }, () => 0);
	for (let r = 0; r < m; r++) {
		const row = a[r];
		for (let i = 0; i < k; i++) {
			const vi = row[cols[i]];
			if (vi === 0) continue;
			atb[i] += vi * b[r];
			for (let j = 0; j < k; j++) ata[i][j] += vi * row[cols[j]];
		}
	}
	// A tiny ridge keeps collinear features (two op kinds that always occur together) solvable.
	for (let i = 0; i < k; i++) ata[i][i] += 1e-9 * (ata[i][i] + 1);
	// Gaussian elimination with partial pivoting.
	for (let c = 0; c < k; c++) {
		let p = c;
		for (let r = c + 1; r < k; r++) if (Math.abs(ata[r][c]) > Math.abs(ata[p][c])) p = r;
		[ata[c], ata[p]] = [ata[p], ata[c]];
		[atb[c], atb[p]] = [atb[p], atb[c]];
		const d = ata[c][c];
		if (Math.abs(d) < 1e-300) continue;
		for (let r = c + 1; r < k; r++) {
			const f = ata[r][c] / d;
			if (f === 0) continue;
			for (let j = c; j < k; j++) ata[r][j] -= f * ata[c][j];
			atb[r] -= f * atb[c];
		}
	}
	const x: number[] = Array.from({ length: k }, () => 0);
	for (let i = k - 1; i >= 0; i--) {
		let s = atb[i];
		for (let j = i + 1; j < k; j++) s -= ata[i][j] * x[j];
		x[i] = Math.abs(ata[i][i]) < 1e-300 ? 0 : s / ata[i][i];
	}
	return x;
}

export function nnls(a: number[][], b: number[], max_iter = 500): number[] {
	const n = a[0]?.length ?? 0;
	const x: number[] = Array.from({ length: n }, () => 0);
	const passive = new Set<number>();
	const gradient = (): number[] => {
		// w = A^T (b - A x)
		const w: number[] = Array.from({ length: n }, () => 0);
		for (let r = 0; r < a.length; r++) {
			let res = b[r];
			for (let j = 0; j < n; j++) res -= a[r][j] * x[j];
			for (let j = 0; j < n; j++) w[j] += a[r][j] * res;
		}
		return w;
	};
	const tol = 1e-10;
	for (let iter = 0; iter < max_iter; iter++) {
		const w = gradient();
		let best = -1;
		let best_w = tol;
		for (let j = 0; j < n; j++) {
			if (!passive.has(j) && w[j] > best_w) {
				best = j;
				best_w = w[j];
			}
		}
		if (best === -1) break;
		passive.add(best);
		for (let inner = 0; inner < max_iter; inner++) {
			const cols = [...passive].sort((p, q) => p - q);
			const z = solve_subset(a, b, cols);
			if (z.every((v) => v > tol)) {
				for (let j = 0; j < n; j++) x[j] = 0;
				cols.forEach((c, i) => (x[c] = z[i]));
				break;
			}
			// step back toward the feasible region until a passive variable hits zero
			let alpha = Infinity;
			cols.forEach((c, i) => {
				if (z[i] <= tol) {
					const step = x[c] / (x[c] - z[i]);
					if (step < alpha) alpha = step;
				}
			});
			if (!Number.isFinite(alpha)) alpha = 0;
			cols.forEach((c, i) => {
				x[c] += alpha * (z[i] - x[c]);
			});
			for (const c of cols) {
				if (x[c] <= tol) {
					x[c] = 0;
					passive.delete(c);
				}
			}
			if (passive.size === 0) break;
		}
	}
	return x;
}

/** Coefficient of determination of predictions against observations (1 = exact). */
export function r_squared(observed: readonly number[], predicted: readonly number[]): number {
	const n = observed.length;
	if (n === 0) return 1;
	const mean = observed.reduce((s, v) => s + v, 0) / n;
	let ss_res = 0;
	let ss_tot = 0;
	for (let i = 0; i < n; i++) {
		ss_res += (observed[i] - predicted[i]) ** 2;
		ss_tot += (observed[i] - mean) ** 2;
	}
	if (ss_tot === 0) return ss_res === 0 ? 1 : 0;
	return 1 - ss_res / ss_tot;
}
