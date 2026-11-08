import { run_child } from '../measure/spawn.ts';
import { package_file } from '../own.ts';
import { DEFAULT_SIZES, fit_curve, prices_from_fits, priced_keys, write_prices } from './prices.ts';
import type { CurveFit, PricePoint } from './prices.ts';
import { INPUTS } from './inputs.ts';
import { fit_weights, measure_corpus, write_weights } from './weights.ts';
import type { CorpusPoint, Weights } from './weights.ts';
import { machine_info } from './points.ts';
import type { Machine } from './points.ts';

/*
 * The calibration entry points behind `heisenbench calibrate prices|weights` (and scripts/calibrate.ts).
 * Run them on a quiet machine: the numbers they write are what every later count is priced with.
 */

/** The calibration corpus: only a clone of the bench repo has it (`calibrate` says so from npm). */
export const CORPUS_ROOT = package_file('calibration/');
export const CORPUS_FILES = [package_file('calibration/corpus.bench.ts')];
export const DEFAULT_PRICES_PATH = package_file('prices.json');

export interface CalibrateWeightsOptions {
	root?: string;
	files?: string[];
	filter?: string;
	out?: string | URL;
	time_ms?: number;
	repeats?: number;
	/** Points measured before (`heisenbench calibrate points`): fitted as they are, nothing is timed. */
	points?: CorpusPoint[];
	/** Recorded in the weights file: where the points were measured. */
	machine?: Machine;
	log?: (line: string) => void;
}

export async function calibrate_weights(
	o: CalibrateWeightsOptions = {}
): Promise<{ weights: Weights; points: CorpusPoint[] }> {
	const points =
		o.points ??
		(await measure_corpus({
			root: o.root ?? CORPUS_ROOT,
			files: o.files ?? CORPUS_FILES,
			filter: o.filter,
			time_ms: o.time_ms,
			repeats: o.repeats,
			log: o.log
		}));
	const fit = { ...fit_weights(points), ...(o.machine ? { machine: o.machine } : {}) };
	const weights = o.out ? write_weights(o.out, fit) : { version: 0, ...fit };
	for (const [fam, f] of Object.entries(weights.families)) {
		o.log?.(
			`${f.r2 !== null && f.r2 < weights.time_led_below ? 'time-led' : 'fits    '} ${fam}  R^2 ${f.r2 ?? '-'} (${f.points} points)`
		);
	}
	return { weights, points };
}

/**
 * The time one step takes on typical code: the median ns per step over the corpus cases that call
 * no priced built-in, at the largest size. One hot loop alone is no reference (the JIT can fold it
 * to a fraction of a nanosecond per step); the median over many kinds of code is.
 */
export async function step_ns(o: { time_ms?: number; repeats?: number } = {}): Promise<number> {
	const points = await measure_corpus({
		root: CORPUS_ROOT,
		files: CORPUS_FILES,
		filter: '@512',
		time_ms: o.time_ms,
		repeats: o.repeats
	});
	const ratios = points
		.filter((p) => p.steps > 0 && !Object.keys(p.units).some((k) => k.startsWith('bi.')))
		.map((p) => p.ns / p.steps)
		.sort((a, b) => a - b);
	if (ratios.length === 0) throw new Error('heisenbench: no built-in-free corpus case ran');
	return ratios[ratios.length >> 1];
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
		fits[key] = fit_curve(pts, INPUTS[key]?.models);
		const terms = Object.entries(fits[key].terms_ns ?? {})
			.map(([t, ns]) => `, ${t} ${ns.toFixed(3)} ns`)
			.join('');
		o.log?.(
			`${key}: ${fits[key].model} base ${fits[key].base_ns.toFixed(1)} ns, k ${fits[key].k_ns.toFixed(3)} ns${terms} (R^2 ${fits[key].r2.toFixed(3)})`
		);
	}
	const out = o.out ?? DEFAULT_PRICES_PATH;
	const { load: _load, ...machine } = machine_info();
	const { version, changed } = write_prices(
		out,
		prices_from_fits(fits, ns_per_step),
		{
			date: new Date().toISOString().slice(0, 10),
			step_ns: Math.round(ns_per_step * 1e4) / 1e4,
			machine
		},
		DEFAULT_PRICES_PATH
	);
	return { fits, step_ns: ns_per_step, version, changed };
}
