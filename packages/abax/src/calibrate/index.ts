import { fileURLToPath } from 'node:url';
import { run_child } from '../measure/spawn.ts';
import { DEFAULT_SIZES, fit_curve, prices_from_fits, priced_keys, write_prices } from './prices.ts';
import type { CurveFit, PricePoint } from './prices.ts';
import { fit_weights, measure_corpus, write_weights } from './weights.ts';
import type { CorpusPoint, Weights } from './weights.ts';

/*
 * The calibration entry points behind `abax calibrate prices|weights` (and scripts/calibrate.ts).
 * Run them on a quiet machine: the numbers they write are what every later count is priced with.
 */

export const CORPUS_ROOT = fileURLToPath(new URL('../../calibration/', import.meta.url));
export const CORPUS_FILES = [
	fileURLToPath(new URL('../../calibration/corpus.bench.ts', import.meta.url))
];
export const DEFAULT_PRICES_PATH = fileURLToPath(new URL('../../prices.json', import.meta.url));

export interface CalibrateWeightsOptions {
	root?: string;
	files?: string[];
	filter?: string;
	out?: string | URL;
	time_ms?: number;
	repeats?: number;
	log?: (line: string) => void;
}

export async function calibrate_weights(
	o: CalibrateWeightsOptions = {}
): Promise<{ weights: Weights; points: CorpusPoint[] }> {
	const points = await measure_corpus({
		root: o.root ?? CORPUS_ROOT,
		files: o.files ?? CORPUS_FILES,
		filter: o.filter,
		time_ms: o.time_ms,
		repeats: o.repeats,
		log: o.log
	});
	const fit = fit_weights(points);
	const weights = o.out ? write_weights(o.out, fit) : { version: 0, ...fit };
	for (const [fam, f] of Object.entries(weights.families)) {
		o.log?.(
			`${f.r2 !== null && f.r2 < weights.time_led_below ? 'time-led' : 'fits    '} ${fam}  R^2 ${f.r2 ?? '-'} (${f.points} points)`
		);
	}
	return { weights, points };
}

/** ns per step, from the corpus reference function (no built-ins: plain ops only). */
export async function step_ns(o: { time_ms?: number; repeats?: number } = {}): Promise<number> {
	const points = await measure_corpus({
		root: CORPUS_ROOT,
		files: CORPUS_FILES,
		filter: 'reference @512',
		time_ms: o.time_ms,
		repeats: o.repeats
	});
	const p = points[0];
	if (!p || p.steps === 0) throw new Error('abax: the reference case did not run');
	return p.ns / p.steps;
}

export interface CalibratePricesOptions {
	keys?: string[];
	sizes?: number[];
	out?: string;
	time_ms?: number;
	/** ns per step; measured on the reference function when not given. */
	step_ns?: number;
	log?: (line: string) => void;
}

export async function calibrate_prices(o: CalibratePricesOptions = {}): Promise<{
	fits: Record<string, CurveFit>;
	step_ns: number;
	version: number;
	changed: boolean;
}> {
	const keys = o.keys ?? priced_keys();
	const ns_per_step = o.step_ns ?? (await step_ns({ time_ms: o.time_ms }));
	const points = await run_child<PricePoint[]>({
		kind: 'calibrate_prices',
		roots: [],
		files: [[]],
		options: { keys, sizes: o.sizes ?? DEFAULT_SIZES, time_ms: o.time_ms }
	});
	const fits: Record<string, CurveFit> = {};
	for (const key of keys) {
		const pts = points.filter((p) => p.key === key);
		if (pts.length === 0) continue;
		fits[key] = fit_curve(pts);
		o.log?.(
			`${key}: ${fits[key].model} base ${fits[key].base_ns.toFixed(1)} ns, k ${fits[key].k_ns.toFixed(3)} ns (R^2 ${fits[key].r2.toFixed(3)})`
		);
	}
	const out = o.out ?? DEFAULT_PRICES_PATH;
	const { version, changed } = write_prices(out, prices_from_fits(fits, ns_per_step));
	return { fits, step_ns: ns_per_step, version, changed };
}
