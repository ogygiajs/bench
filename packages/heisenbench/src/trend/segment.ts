/*
 * Penalized least-squares segmentation of one series: the cuts PELT looks for, found exactly.
 *
 * The series is cut into pieces; each piece is fit by a flat level or by a straight line, and
 * pieces do not have to meet (a step is a cut between two levels). The best cut set minimizes
 *
 *   sum over pieces of (squared misfit / σ²  +  γ if the piece is a line)  +  β per cut
 *
 * by optimal partitioning: F(e) = min over s < e of F(s) + cost(s, e) + β. That is the objective
 * PELT solves; PELT's pruning needs a cost that never gains by being split, which the line's
 * extra price γ breaks, and a nightly series is a few hundred points at most, so every start is
 * tried (O(n²) piece costs, each O(1) from prefix sums). Ties keep the earliest start, so the same
 * series always gives the same cuts.
 */

export interface Piece {
	/** First point of the piece (an index into the series). */
	start: number;
	/** One past its last point. */
	end: number;
	/** A flat level, or a straight line (three points at least). */
	kind: 'flat' | 'line';
	/** The fitted change per point (0 for a flat piece). */
	slope: number;
}

export interface SegmentOptions {
	/** The scale misfit is measured in (same unit as the series). */
	sigma: number;
	/** The price of a cut. */
	cut_penalty: number;
	/** The extra price of a line over a flat level. */
	slope_penalty: number;
}

/** A line needs this many points: two points always fit one exactly. */
const LINE_MIN = 3;

export function segment(x: readonly number[], o: SegmentOptions): Piece[] {
	const n = x.length;
	if (n === 0) return [];
	const inv = 1 / (o.sigma * o.sigma);
	// prefix sums over [0, i), centered on the first point to keep the sums small
	const x0 = x[0];
	const s1 = new Float64Array(n + 1);
	const s2 = new Float64Array(n + 1);
	const t1 = new Float64Array(n + 1);
	const t2 = new Float64Array(n + 1);
	const tx = new Float64Array(n + 1);
	for (let i = 0; i < n; i++) {
		const v = x[i] - x0;
		s1[i + 1] = s1[i] + v;
		s2[i + 1] = s2[i] + v * v;
		t1[i + 1] = t1[i] + i;
		t2[i + 1] = t2[i] + i * i;
		tx[i + 1] = tx[i] + i * v;
	}
	const fit = (s: number, e: number): { cost: number; kind: 'flat' | 'line'; slope: number } => {
		const len = e - s;
		const sx = s1[e] - s1[s];
		const sse_flat = Math.max(0, s2[e] - s2[s] - (sx * sx) / len);
		const flat = { cost: sse_flat * inv, kind: 'flat' as const, slope: 0 };
		if (len < LINE_MIN) return flat;
		const st = t1[e] - t1[s];
		const stt = t2[e] - t2[s] - (st * st) / len;
		const sxt = tx[e] - tx[s] - (st * sx) / len;
		const sse_line = Math.max(0, sse_flat - (sxt * sxt) / stt);
		const line = sse_line * inv + o.slope_penalty;
		return line < flat.cost ? { cost: line, kind: 'line', slope: sxt / stt } : flat;
	};
	const best = new Float64Array(n + 1);
	const from = new Int32Array(n + 1);
	best[0] = -o.cut_penalty;
	for (let e = 1; e <= n; e++) {
		let min = Infinity;
		let arg = 0;
		for (let s = 0; s < e; s++) {
			const v = best[s] + fit(s, e).cost + o.cut_penalty;
			if (v < min) {
				min = v;
				arg = s;
			}
		}
		best[e] = min;
		from[e] = arg;
	}
	const pieces: Piece[] = [];
	for (let e = n; e > 0; e = from[e]) {
		const s = from[e];
		const f = fit(s, e);
		pieces.push({ start: s, end: e, kind: f.kind, slope: f.slope });
	}
	return pieces.reverse();
}
