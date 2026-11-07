/*
 * Gradient-boosted shallow regression trees with the quantile (pinball) loss. One ensemble per
 * quantile. Each round fits a tree of depth `depth` to the loss's negative gradient (q where the
 * target is above the current prediction, q - 1 where it is below), by weighted least squares,
 * then sets each leaf to the weighted q-quantile of what is left to explain in it, times the
 * learning rate (the standard line search for this loss). Rows are drawn without replacement per
 * round with a seeded generator, so the same rows, weights and seed give the same trees.
 *
 * A missing feature (NaN) goes down the side that held most of the training weight at that split.
 */

export interface TreeOptions {
	quantile: number;
	rounds: number;
	depth: number;
	learning_rate: number;
	/** Least weight in a leaf, as a count of rows (weights are normalized to mean 1). */
	min_leaf: number;
	/** Share of the rows each round sees. */
	subsample: number;
	seed: number;
}

/** A split node: [feature, threshold, left, right, nan_left (1|0)]; a leaf: [value]. */
export type TreeNode = [number, number, number, number, number] | [number];

export interface Ensemble {
	quantile: number;
	/** The starting value before any tree. */
	base: number;
	learning_rate: number;
	trees: TreeNode[][];
}

/** mulberry32: small, fast, and the same everywhere. */
export function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Weighted q-quantile (the smallest value whose cumulative weight reaches q of the total). */
export function weighted_quantile(values: number[], weights: number[], q: number): number {
	const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b] || a - b);
	let total = 0;
	for (const i of idx) total += weights[i];
	if (total <= 0) return 0;
	let acc = 0;
	for (const i of idx) {
		acc += weights[i];
		if (acc >= q * total - 1e-12) return values[i];
	}
	return values[idx[idx.length - 1]];
}

interface Split {
	feature: number;
	threshold: number;
	gain: number;
	nan_left: boolean;
}

/**
 * The best split of the rows marked `node` in `at` for target `g` (weighted least squares), or
 * null. `order[f]` lists every row with feature f known, by its value (ties by row).
 */
function best_split(
	x: number[][],
	g: number[],
	w: number[],
	at: Int32Array,
	node: number,
	rows: number[],
	order: number[][],
	min_leaf: number
): Split | null {
	let tw = 0;
	let tg = 0;
	for (const r of rows) {
		tw += w[r];
		tg += w[r] * g[r];
	}
	const parent = (tg * tg) / tw;
	let best: Split | null = null;
	const p = x[0].length;
	const have: number[] = [];
	for (let f = 0; f < p; f++) {
		have.length = 0;
		let kw = 0;
		let kg = 0;
		for (const r of order[f]) {
			if (at[r] !== node) continue;
			have.push(r);
			kw += w[r];
			kg += w[r] * g[r];
		}
		if (have.length < 2) continue;
		const nw = tw - kw;
		const ng = tg - kg;
		let lw = 0;
		let lg = 0;
		const hw = tw - nw;
		const hg = tg - ng;
		for (let i = 0; i < have.length - 1; i++) {
			const r = have[i];
			lw += w[r];
			lg += w[r] * g[r];
			const v = x[r][f];
			const next = x[have[i + 1]][f];
			if (next === v) continue;
			const rw = hw - lw;
			const rg = hg - lg;
			// the missing rows join the heavier side
			const nan_left = lw >= rw;
			const lw2 = nan_left ? lw + nw : lw;
			const lg2 = nan_left ? lg + ng : lg;
			const rw2 = nan_left ? rw : rw + nw;
			const rg2 = nan_left ? rg : rg + ng;
			if (lw2 < min_leaf || rw2 < min_leaf) continue;
			const gain = (lg2 * lg2) / lw2 + (rg2 * rg2) / rw2 - parent;
			if (gain > 1e-12 && (best === null || gain > best.gain)) {
				best = { feature: f, threshold: (v + next) / 2, gain, nan_left };
			}
		}
	}
	return best;
}

function goes_left(v: number, threshold: number, nan_left: boolean): boolean {
	return Number.isNaN(v) ? nan_left : v <= threshold;
}

/** Grow one tree on `rows`; leaves hold the weighted q-quantile of `resid`, times `scale`. */
function grow(
	x: number[][],
	g: number[],
	resid: number[],
	w: number[],
	rows: number[],
	order: number[][],
	o: TreeOptions
): TreeNode[] {
	const nodes: TreeNode[] = [];
	// which node each row of this round is in (-1: not drawn)
	const at = new Int32Array(g.length).fill(-1);
	for (const r of rows) at[r] = 0;
	const build = (part: number[], depth: number): number => {
		const id = nodes.length;
		nodes.push([0]);
		for (const r of part) at[r] = id;
		const split = depth < o.depth ? best_split(x, g, w, at, id, part, order, o.min_leaf) : null;
		if (!split) {
			const v = weighted_quantile(
				part.map((r) => resid[r]),
				part.map((r) => w[r]),
				o.quantile
			);
			nodes[id] = [round_sig(v * o.learning_rate)];
			return id;
		}
		// rounded where it is made: training routes rows as prediction from the file will
		const threshold = round_sig(split.threshold);
		const left: number[] = [];
		const right: number[] = [];
		for (const r of part) {
			(goes_left(x[r][split.feature], threshold, split.nan_left) ? left : right).push(r);
		}
		const l = build(left, depth + 1);
		const rr = build(right, depth + 1);
		nodes[id] = [split.feature, threshold, l, rr, split.nan_left ? 1 : 0];
		return id;
	};
	build(rows, 0);
	return nodes;
}

/**
 * Seven significant digits: the model file stays small, and a value is the same bytes on every
 * machine. Thresholds are rounded where they are made, so training routes rows exactly as
 * prediction from the file will.
 */
export function round_sig(v: number): number {
	if (v === 0 || !Number.isFinite(v)) return v;
	return Number(v.toPrecision(7));
}

export function tree_value(nodes: TreeNode[], row: number[]): number {
	let i = 0;
	for (;;) {
		const n = nodes[i];
		if (n.length === 1) return n[0];
		i = goes_left(row[n[0]], n[1], n[4] === 1) ? n[2] : n[3];
	}
}

export function predict_ensemble(e: Ensemble, row: number[]): number {
	let v = e.base;
	for (const t of e.trees) v += tree_value(t, row);
	return v;
}

/** Fit one quantile's ensemble to `y` (rows `x`, weights `w`). */
export function fit_ensemble(x: number[][], y: number[], w: number[], o: TreeOptions): Ensemble {
	const n = y.length;
	const mean_w = w.reduce((s, v) => s + v, 0) / n;
	const wn = w.map((v) => v / mean_w);
	const base = round_sig(weighted_quantile(y, wn, o.quantile));
	const f = y.map(() => base);
	const draw = rng(o.seed);
	const take = Math.max(1, Math.round(o.subsample * n));
	const trees: TreeNode[][] = [];
	const all = Array.from({ length: n }, (_, i) => i);
	const order = x[0].map((_, f) =>
		all.filter((i) => !Number.isNaN(x[i][f])).sort((a, b) => x[a][f] - x[b][f] || a - b)
	);
	for (let m = 0; m < o.rounds; m++) {
		// partial Fisher-Yates: the first `take` of a seeded shuffle
		const pick = [...all];
		for (let i = 0; i < take; i++) {
			const j = i + Math.floor(draw() * (n - i));
			[pick[i], pick[j]] = [pick[j], pick[i]];
		}
		const rows = pick.slice(0, take).sort((a, b) => a - b);
		const resid = y.map((v, i) => v - f[i]);
		const g = resid.map((r) => (r > 0 ? o.quantile : r < 0 ? o.quantile - 1 : 0));
		const tree = grow(x, g, resid, wn, rows, order, o);
		trees.push(tree);
		for (let i = 0; i < n; i++) f[i] += tree_value(tree, x[i]);
	}
	return { quantile: o.quantile, base, learning_rate: o.learning_rate, trees };
}
