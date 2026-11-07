import { readFileSync } from 'node:fs';
import { builtin_cost, load_prices } from '../prices.ts';
import type { Prices } from '../prices.ts';
import { agreement, point_times, read_points } from './points.ts';
import type { Agreement, PointSet } from './points.ts';
import { FEATURES, features_of, fit_weights } from './weights.ts';

/*
 * `heisenbench calibrate agree a b`: is the machine quiet enough to calibrate on? Two measurements taken
 * one after the other (A/A) must agree before either is committed.
 *
 *   two point sets   the measured ns per case, and the ns the weights fitted on each set predict
 *                    for every case (weights of collinear op kinds can trade places between fits
 *                    while their predictions agree, so predictions are compared, not weights)
 *   two price files  each built-in's price in steps at sizes 16, 256 and 4096
 *
 * The decision is on the median |Δ| over cases; p90 and the worst cases are printed with it.
 */

export interface AgreeResult extends Agreement {
	lines: string[];
}

const SIZES = [16, 256, 4096];

function summary(what: string, a: Agreement): string[] {
	const out = [
		`${what}: ${a.cases} compared, median |Δ| ${a.median_pct.toFixed(2)}%, p90 ${a.p90_pct.toFixed(2)}%, max ${a.max_pct.toFixed(2)}%`,
		`  whole-machine shift ${a.shift_pct > 0 ? '+' : ''}${a.shift_pct.toFixed(2)}%, case-to-case ${a.shape_pct.toFixed(2)}%`
	];
	for (const w of a.worst.slice(0, 3)) {
		out.push(
			`  ${w.pct.toFixed(1)}%  ${w.name}  (${w.a_ns.toPrecision(4)} vs ${w.b_ns.toPrecision(4)})`
		);
	}
	if (a.missing.length > 0) out.push(`  only one side: ${a.missing.length}`);
	return out;
}

/** The ns the weights fitted on `fit_on` predict for each case of `over`. */
function predictions(fit_on: PointSet, over: PointSet): Map<string, number> {
	const prices = load_prices();
	const w = fit_weights(fit_on.points, prices);
	const out = new Map<string, number>();
	for (const p of over.points) {
		const f = features_of(p.units, prices.prices);
		let ns = 0;
		for (let i = 0; i < FEATURES.length; i++) ns += f[i] * (w.ns[FEATURES[i]] ?? 0);
		out.set(`${p.file} > ${p.name}`, ns);
	}
	return out;
}

function price_costs(p: Prices): Map<string, number> {
	const out = new Map<string, number>();
	for (const [key, price] of Object.entries(p.builtins)) {
		for (const n of SIZES) out.set(`${key} @${n}`, builtin_cost(price, n));
	}
	return out;
}

export interface Tolerance {
	/** Case-to-case median |Δ| allowed (point sets), or median |Δ| (price files). */
	shape_pct: number;
	/** Whole-machine shift allowed between two point sets. */
	shift_pct: number;
}

/**
 * Two point sets agree when the cases moved against each other by at most `shape_pct` (median) and
 * the machine as a whole by at most `shift_pct`. A shift rescales every estimate alike: it changes
 * no rank and no time-led verdict (a 2x gap), so it gets a wider bound than the shape. Two price
 * files agree when each built-in's price moved by at most `shape_pct` (median): prices are ratios of
 * two timings of one run, so a machine-wide shift cancels in them.
 */
export function agree_files(
	a_path: string,
	b_path: string,
	tol: Tolerance = { shape_pct: 3, shift_pct: 5 }
): AgreeResult & { pass: boolean } {
	const a_raw = JSON.parse(readFileSync(a_path, 'utf8')) as { schema?: string };
	const b_raw = JSON.parse(readFileSync(b_path, 'utf8')) as { schema?: string };
	if (a_raw.schema === undefined && b_raw.schema === undefined) {
		const a = agreement(price_costs(a_raw as Prices), price_costs(b_raw as Prices));
		return {
			...a,
			pass: a.median_pct <= tol.shape_pct,
			lines: summary('built-in prices (steps at 16/256/4096)', a)
		};
	}
	const a = read_points(a_path);
	const b = read_points(b_path);
	const times = agreement(point_times(a), point_times(b));
	const fitted = agreement(predictions(a, a), predictions(b, a));
	const lines = [
		`machine A: ${a.machine.cpu}, ${a.machine.node}, load ${a.machine.load.join(' -> ')}`,
		`machine B: ${b.machine.cpu}, ${b.machine.node}, load ${b.machine.load.join(' -> ')}`,
		...summary('measured ns per case', times),
		...summary('fitted estimate per case (each set fitted on its own)', fitted)
	];
	return {
		...times,
		pass: times.shape_pct <= tol.shape_pct && Math.abs(times.shift_pct) <= tol.shift_pct,
		lines
	};
}
