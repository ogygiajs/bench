import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Bench } from 'tinybench';
import { builtin_size, builtin_terms } from '../runtime/builtins.ts';
import { SIZE_TERMS, load_prices } from '../prices.ts';
import type { BuiltinModel, BuiltinPrice, Prices, SizeTerm } from '../prices.ts';
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
	/** The call's size terms (builtin_terms), aligned with SIZE_TERMS, for a built-in that has them. */
	terms?: number[];
	ns: number;
}

export interface CurveFit {
	model: BuiltinModel;
	base_ns: number;
	k_ns: number;
	/** ns per unit of each size term the points vary (a built-in with size terms). */
	terms_ns?: Partial<Record<SizeTerm, number>>;
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

/**
 * Fits `ns = base + k f(n) + sum_t k_t t` for each model f; the size terms that vary in the points
 * (a built-in with size terms, timed at several shapes per size) are columns of every model. The
 * columns are scaled to unit size before the fit: per-call ns and per-character ns differ by
 * orders of magnitude, and so do their columns.
 */
export function fit_curve(points: PricePoint[]): CurveFit {
	const used = SIZE_TERMS.map((_, i) => points.some((p) => (p.terms?.[i] ?? 0) > 0));
	const extra = (p: PricePoint): number[] =>
		SIZE_TERMS.flatMap((_, i) => (used[i] ? [p.terms?.[i] ?? 0] : []));
	const fits = MODELS.map((model) => {
		const cols = points.map((p) =>
			model === 'const' ? [1, ...extra(p)] : [1, term(model, p.n), ...extra(p)]
		);
		const width = cols[0].length;
		const scale = Array.from({ length: width }, (_, j) =>
			Math.max(...cols.map((r, i) => Math.abs(r[j]) / points[i].ns), 1e-300)
		);
		const a = cols.map((r, i) => r.map((v, j) => v / points[i].ns / scale[j]));
		const x = nnls(
			a,
			points.map(() => 1)
		).map((v, j) => v / scale[j]);
		const predicted = cols.map((r) => r.reduce((s, v, j) => s + v * x[j], 0));
		const base = x[0];
		const k = model === 'const' ? 0 : x[1];
		const rest = x.slice(model === 'const' ? 1 : 2);
		const terms_ns: Partial<Record<SizeTerm, number>> = {};
		let j = 0;
		for (let i = 0; i < SIZE_TERMS.length; i++) if (used[i]) terms_ns[SIZE_TERMS[i]] = rest[j++];
		return {
			model,
			base_ns: base,
			k_ns: k,
			...(used.some(Boolean) ? { terms_ns } : {}),
			// On the log scale, as the fit is relative: on the raw scale the largest calls are all
			// of R^2, and a model that misses every small shape 30x (a join of strings priced as a
			// join of numbers) scores 0.998.
			r2: r_squared(
				points.map((p) => Math.log(p.ns)),
				predicted.map((v) => Math.log(Math.max(v, 1e-9)))
			)
		};
	});
	const best = Math.max(...fits.map((f) => f.r2));
	return fits.find((f) => f.r2 >= best - 0.02)!;
}

/**
 * Calls per timed iteration for built-ins that leave their input as it was. One call of a fast
 * built-in (a Map lookup) is a few ns, far below what one tinybench iteration costs on its own (two
 * timer reads); a batch makes the call itself what is timed.
 */
export const BATCH = 64;

let sink: unknown;

/** Mean ns of one `Reflect.apply(fn, self, args)`, batched or one per iteration. */
async function time_call(
	fn: (...args: unknown[]) => unknown,
	make: () => { self: unknown; args: unknown[] },
	fresh: boolean,
	o: { time_ms?: number; warmup_ms?: number }
): Promise<number> {
	const bench = new Bench({
		time: o.time_ms ?? 100,
		warmupTime: o.warmup_ms ?? 30,
		warmup: true,
		retainSamples: false,
		throws: true
	});
	let cur = make();
	if (!fresh) {
		bench.add('call', () => {
			const self = cur.self;
			const args = cur.args;
			for (let i = 0; i < BATCH; i++) sink = Reflect.apply(fn, self, args);
		});
	} else {
		// A fresh input per call is built outside the timing, which tinybench's time budget does
		// not see: each call declares the whole iteration's cost (as time.ts does for setups).
		const t0 = performance.now();
		for (let i = 0; i < 8; i++) {
			const x = make();
			Reflect.apply(fn, x.self, x.args);
		}
		const cost = { overriddenIterationCost: Math.max((performance.now() - t0) / 8, 1e-6) };
		bench.add(
			'call',
			() => {
				sink = Reflect.apply(fn, cur.self, cur.args);
				return cost;
			},
			{
				beforeEach: () => {
					cur = make();
				}
			}
		);
	}
	await bench.run();
	const r = bench.tasks[0].result;
	if (r.state !== 'completed') throw new Error(`heisenbench: timing ended ${r.state}`);
	// the mean: short calls quantize to the timer's tick, which the p50 would keep
	return (r.latency.mean * 1e6) / (fresh ? 1 : BATCH);
}

const noop = (): void => {};

/**
 * Time built-ins at sizes, in this process (a calibrate_prices child; nothing instrumented). What
 * the harness itself costs per call (an empty function through the same batch, or one call per
 * iteration) is measured once and taken off every time.
 */
export async function time_builtins(
	keys: string[],
	sizes: number[] = DEFAULT_SIZES,
	o: { time_ms?: number; warmup_ms?: number } = {}
): Promise<PricePoint[]> {
	const out: PricePoint[] = [];
	const empty = () => ({ self: undefined, args: [] });
	const overhead = {
		batched: await time_call(noop, empty, false, o),
		single: await time_call(noop, empty, true, o)
	};
	void sink;
	for (const key of keys) {
		const input = INPUTS[key];
		const fn = builtin_function(key);
		if (!input || !fn) continue;
		for (let shape = 0; shape < (input.shapes ?? 1); shape++) {
			for (const size of sizes) {
				const sample = input.make(size, shape);
				const result = Reflect.apply(fn, sample.self, sample.args);
				const n = builtin_size(key, sample.self, sample.args, result);
				const terms = builtin_terms(key, sample.self, sample.args, result);
				const fresh = input.fresh === true;
				const ns = await time_call(fn, () => input.make(size, shape), fresh, o);
				// never below a tenth of the raw time: the overhead is an estimate too
				const own = Math.max(ns - (fresh ? overhead.single : overhead.batched), ns * 0.1);
				out.push({ key, n, ...(terms ? { terms } : {}), ns: own });
			}
		}
	}
	return out;
}

/**
 * A price as the file keeps it: a whole number from 64 up, a multiple of 1/4 from 8 up, else a
 * multiple of 1/64. All are exact in binary floating point, so a count times a price, and a sum of
 * those, comes out the same in whatever order it is added: a recount from units equals the count
 * the runtime kept, to the bit. (Decimal fractions like 0.18 are not exact, and their sums move in
 * the last digit.) The rounding is at most 1.6% of a price from 1 up.
 */
export function quantize_price(x: number): number {
	if (!(x > 0)) return 0;
	const step = x >= 64 ? 1 : x >= 8 ? 4 : 64;
	return Math.round(x * step) / step;
}

/** Built-in prices in steps from fitted curves (ns) and the time of one step. */
export function prices_from_fits(
	fits: Record<string, CurveFit>,
	step_ns: number
): Record<string, BuiltinPrice> {
	const out: Record<string, BuiltinPrice> = {};
	for (const [key, f] of Object.entries(fits)) {
		const p: BuiltinPrice = {
			model: f.model,
			base: quantize_price(f.base_ns / step_ns),
			k: f.model === 'const' ? 0 : quantize_price(f.k_ns / step_ns)
		};
		// A term the fit put at 0 stays out of the price: the audit can still test it.
		const terms: Partial<Record<SizeTerm, number>> = {};
		for (const [t, ns] of Object.entries(f.terms_ns ?? {})) {
			const per = quantize_price(ns / step_ns);
			if (per > 0) terms[t as SizeTerm] = per;
		}
		if (Object.keys(terms).length > 0) p.terms = terms;
		out[key] = p;
	}
	return out;
}

function same_price(a: BuiltinPrice, b: BuiltinPrice): boolean {
	return (
		a.model === b.model &&
		a.base === b.base &&
		a.k === b.k &&
		JSON.stringify(a.terms ?? {}) === JSON.stringify(b.terms ?? {})
	);
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
		if (!old || !same_price(old, p)) changed = true;
		merged.builtins[key] = p;
	}
	if (changed) merged.version = current.version + 1;
	return { prices: merged, changed };
}

/** Where and how built-in prices were last calibrated (kept in prices.json, one line). */
export interface PriceCalibration {
	date: string;
	/** ns of one step on that machine (the time a built-in's ns are divided by). */
	step_ns: number;
	machine: { cpu: string; cores: number; os: string; node: string; v8: string };
}

type PriceFile = Prices & { note?: string; calibration?: PriceCalibration };

/** The repository formatter's line width (.oxfmtrc.json `printWidth`). */
const PRINT_WIDTH = 100;

/** prices.json as the repository keeps it: one line per built-in while it fits. */
export function format_prices(p: PriceFile): string {
	const t = '\t';
	const lines = ['{', `${t}"version": ${p.version},`];
	if (p.note) lines.push(`${t}"note": ${JSON.stringify(p.note)},`);
	if (p.calibration) {
		const block = JSON.stringify(p.calibration, null, t).split('\n').join(`\n${t}`);
		lines.push(`${t}"calibration": ${block},`);
	}
	const one_line = (o: object): string =>
		`{ ${Object.entries(o)
			.map(
				([a, b]) =>
					`${JSON.stringify(a)}: ${b !== null && typeof b === 'object' ? one_line(b as object) : JSON.stringify(b)}`
			)
			.join(', ')} }`;
	const block = (name: string, obj: Record<string, unknown>, last: boolean, inline = false) => {
		const keys = Object.keys(obj);
		lines.push(`${t}${JSON.stringify(name)}: {`);
		keys.forEach((k, i) => {
			const comma = i === keys.length - 1 ? '' : ',';
			const head = `${t}${t}${JSON.stringify(k)}: `;
			if (!inline) {
				lines.push(`${head}${JSON.stringify(obj[k])}${comma}`);
				return;
			}
			const v = one_line(obj[k] as object);
			// The repository's formatter keeps a price on one line while it fits in 100 columns
			// (a tab is 2), and puts each field on a line of its own when it does not.
			if (head.length + v.length + comma.length + 2 <= PRINT_WIDTH) {
				lines.push(`${head}${v}${comma}`);
				return;
			}
			lines.push(`${head}{`);
			const fields = Object.entries(obj[k] as object);
			fields.forEach(([a, b], j) => {
				const value =
					b !== null && typeof b === 'object' ? one_line(b as object) : JSON.stringify(b);
				lines.push(
					`${t}${t}${t}${JSON.stringify(a)}: ${value}${j === fields.length - 1 ? '' : ','}`
				);
			});
			lines.push(`${t}${t}}${comma}`);
		});
		lines.push(`${t}}${last ? '' : ','}`);
	};
	block('ops', p.ops, false);
	block('dynamic', p.dynamic, false);
	block('builtins', p.builtins, true, true);
	lines.push('}');
	return lines.join('\n') + '\n';
}

/**
 * Writes `builtins` into the price file at `path`, a new version when a price changed. A `path`
 * that does not exist yet starts from `from` (the committed prices.json) and is always written.
 */
export function write_prices(
	path: string,
	builtins: Record<string, BuiltinPrice>,
	calibration?: PriceCalibration,
	from: string = path
): { version: number; changed: boolean } {
	const fresh = !existsSync(path);
	const current = JSON.parse(readFileSync(fresh ? from : path, 'utf8')) as PriceFile;
	const { prices, changed } = next_prices(current, builtins);
	if (changed || fresh) {
		writeFileSync(
			path,
			format_prices({
				...prices,
				note: current.note,
				calibration: calibration ?? current.calibration
			})
		);
	}
	return { version: prices.version, changed };
}

export function priced_keys(): string[] {
	return Object.keys(load_prices().prices.builtins);
}
