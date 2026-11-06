import { readFileSync, writeFileSync } from 'node:fs';
import { Bench } from 'tinybench';
import { builtin_size } from '../runtime/builtins.ts';
import { load_prices } from '../prices.ts';
import type { BuiltinModel, BuiltinPrice, Prices } from '../prices.ts';
import { INPUTS, builtin_function } from './inputs.ts';
import { nnls, r_squared } from './nnls.ts';

/*
 * Built-in price calibration (spec 2): each priced built-in is timed (plain, tinybench) at a range
 * of sizes, and its curve fitted: ns = base + k * f(n) for f in const, n, n log2 n, n^2, with
 * base, k >= 0 (relative least squares, so small sizes count as much as large ones). The simplest
 * model within 0.02 R^2 of the best one wins. Times become steps through the time one step takes
 * (`step_ns`: the median ns per step of the corpus cases with no priced built-in, calibrate/index.ts).
 *
 * prices.json is versioned: when any built-in price changes, `version` goes up by one. A price
 * change makes every comparison between reports of two price files recount both sides
 * (recount.ts), so old stored results stay comparable.
 */

export const MODELS: BuiltinModel[] = ['const', 'n', 'n_log_n', 'n2'];
export const DEFAULT_SIZES = [16, 64, 256, 1024, 4096];

export interface PricePoint {
	key: string;
	/** The size the runtime charges for (builtin_size), not the input parameter. */
	n: number;
	ns: number;
}

export interface CurveFit {
	model: BuiltinModel;
	base_ns: number;
	k_ns: number;
	r2: number;
}

function term(model: BuiltinModel, n: number): number {
	switch (model) {
		case 'const':
			return 0;
		case 'n':
			return n;
		case 'n_log_n':
			return n > 1 ? n * Math.log2(n) : n;
		case 'n2':
			return n * n;
	}
}

export function fit_curve(points: PricePoint[]): CurveFit {
	const fits = MODELS.map((model) => {
		const a = points.map((p) =>
			model === 'const' ? [1 / p.ns] : [1 / p.ns, term(model, p.n) / p.ns]
		);
		const b = points.map(() => 1);
		const [base, k = 0] = nnls(a, b);
		const predicted = points.map((p) => base + k * term(model, p.n));
		return {
			model,
			base_ns: base,
			k_ns: k,
			r2: r_squared(
				points.map((p) => p.ns),
				predicted
			)
		};
	});
	const best = Math.max(...fits.map((f) => f.r2));
	return fits.find((f) => f.r2 >= best - 0.02)!;
}

/** Time built-ins at sizes, in this process (a calibrate_prices child; nothing instrumented). */
export async function time_builtins(
	keys: string[],
	sizes: number[] = DEFAULT_SIZES,
	o: { time_ms?: number; warmup_ms?: number } = {}
): Promise<PricePoint[]> {
	const out: PricePoint[] = [];
	for (const key of keys) {
		const input = INPUTS[key];
		const fn = builtin_function(key);
		if (!input || !fn) continue;
		for (const size of sizes) {
			const sample = input.make(size);
			const n = builtin_size(
				key,
				sample.self,
				sample.args,
				Reflect.apply(fn, sample.self, sample.args)
			);
			let cur = input.make(size);
			const bench = new Bench({
				time: o.time_ms ?? 100,
				warmupTime: o.warmup_ms ?? 30,
				warmup: true,
				retainSamples: false,
				throws: true
			});
			// A fresh input per call is built outside the timing, which tinybench's time budget does
			// not see: each call declares the whole iteration's cost (as time.ts does for setups).
			let cost: { overriddenIterationCost: number } | undefined;
			if (input.fresh) {
				const t0 = performance.now();
				for (let i = 0; i < 8; i++) {
					const x = input.make(size);
					Reflect.apply(fn, x.self, x.args);
				}
				cost = { overriddenIterationCost: Math.max((performance.now() - t0) / 8, 1e-6) };
			}
			bench.add(
				key,
				() => {
					Reflect.apply(fn, cur.self, cur.args);
					return cost;
				},
				input.fresh
					? {
							beforeEach: () => {
								cur = input.make(size);
							}
						}
					: {}
			);
			await bench.run();
			const r = bench.tasks[0].result;
			if (r.state !== 'completed')
				throw new Error(`abax: timing ${key} at ${size} ended ${r.state}`);
			// the mean: short calls quantize to the timer's tick, which the p50 would keep
			out.push({ key, n, ns: r.latency.mean * 1e6 });
		}
	}
	return out;
}

function significant(x: number, digits = 3): number {
	if (x === 0) return 0;
	const p = 10 ** (digits - Math.ceil(Math.log10(Math.abs(x))));
	return Math.round(x * p) / p;
}

/** Built-in prices in steps from fitted curves (ns) and the time of one step. */
export function prices_from_fits(
	fits: Record<string, CurveFit>,
	step_ns: number
): Record<string, BuiltinPrice> {
	const out: Record<string, BuiltinPrice> = {};
	for (const [key, f] of Object.entries(fits)) {
		out[key] = {
			model: f.model,
			base: significant(f.base_ns / step_ns),
			k: f.model === 'const' ? 0 : significant(f.k_ns / step_ns)
		};
	}
	return out;
}

/** The price file with new built-in prices; the version goes up when anything changed. */
export function next_prices(
	current: Prices,
	builtins: Record<string, BuiltinPrice>
): { prices: Prices; changed: boolean } {
	const merged: Prices = { ...current, builtins: { ...current.builtins } };
	let changed = false;
	for (const [key, p] of Object.entries(builtins)) {
		const old = current.builtins[key];
		if (!old || old.model !== p.model || old.base !== p.base || old.k !== p.k) changed = true;
		merged.builtins[key] = p;
	}
	if (changed) merged.version = current.version + 1;
	return { prices: merged, changed };
}

/** prices.json as the repository keeps it: one line per built-in. */
export function format_prices(p: Prices & { note?: string }): string {
	const t = '\t';
	const lines = ['{', `${t}"version": ${p.version},`];
	if (p.note) lines.push(`${t}"note": ${JSON.stringify(p.note)},`);
	const block = (name: string, obj: Record<string, unknown>, last: boolean, inline = false) => {
		const keys = Object.keys(obj);
		lines.push(`${t}${JSON.stringify(name)}: {`);
		keys.forEach((k, i) => {
			const v = inline
				? `{ ${Object.entries(obj[k] as object)
						.map(([a, b]) => `${JSON.stringify(a)}: ${JSON.stringify(b)}`)
						.join(', ')} }`
				: JSON.stringify(obj[k]);
			lines.push(`${t}${t}${JSON.stringify(k)}: ${v}${i === keys.length - 1 ? '' : ','}`);
		});
		lines.push(`${t}}${last ? '' : ','}`);
	};
	block('ops', p.ops, false);
	block('dynamic', p.dynamic, false);
	block('builtins', p.builtins, true, true);
	lines.push('}');
	return lines.join('\n') + '\n';
}

export function write_prices(
	path: string,
	builtins: Record<string, BuiltinPrice>
): { version: number; changed: boolean } {
	const current = JSON.parse(readFileSync(path, 'utf8')) as Prices & { note?: string };
	const { prices, changed } = next_prices(current, builtins);
	if (changed) writeFileSync(path, format_prices({ ...prices, note: current.note }));
	return { version: prices.version, changed };
}

export function priced_keys(): string[] {
	return Object.keys(load_prices().prices.builtins);
}
