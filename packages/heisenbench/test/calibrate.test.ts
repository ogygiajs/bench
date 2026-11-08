import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nnls, r_squared } from '../src/calibrate/nnls.ts';
import { fit_curve, format_prices, next_prices, write_prices } from '../src/calibrate/prices.ts';
import type { PricePoint } from '../src/calibrate/prices.ts';
import { FEATURES, fit_weights, load_weights, write_weights } from '../src/calibrate/weights.ts';
import type { CorpusPoint } from '../src/calibrate/weights.ts';
import { calibrate_prices, calibrate_weights } from '../src/calibrate/index.ts';
import { INPUTS } from '../src/calibrate/inputs.ts';
import { estimate_case, with_measured } from '../src/calibrate/estimate.ts';
import { load_prices } from '../src/prices.ts';
import type { Prices } from '../src/prices.ts';
import type { CaseReport } from '../src/report.ts';
import { temp_dir, write_files } from './helpers.ts';

const PRICES_PATH = fileURLToPath(new URL('../prices.json', import.meta.url));
const BENCH_API = fileURLToPath(new URL('../src/bench.ts', import.meta.url));

test('nnls: recovers non-negative weights and clamps the rest at zero', () => {
	const a = [
		[1, 0, 2],
		[0, 1, 1],
		[1, 1, 0],
		[2, 1, 1],
		[3, 0, 1]
	];
	const truth = [2, 0.5, 1.5];
	const b = a.map((r) => r.reduce((s, v, i) => s + v * truth[i], 0));
	const x = nnls(a, b);
	for (let i = 0; i < 3; i++) assert.ok(Math.abs(x[i] - truth[i]) < 1e-6, `${x}`);
	// the unconstrained answer has a negative second weight; NNLS pins it at zero
	const y = nnls(
		[
			[1, 2],
			[2, 1],
			[1, 1]
		],
		[-1, 2, 1]
	);
	assert.equal(y[1], 0);
	assert.ok(y[0] > 0);
	assert.equal(r_squared([1, 2, 3], [1, 2, 3]), 1);
});

test('built-in curves: the simplest model that fits', () => {
	const pts = (f: (n: number) => number): PricePoint[] =>
		[16, 64, 256, 1024, 4096].map((n) => ({ key: 'x', n, ns: f(n) }));
	assert.equal(fit_curve(pts((n) => 30 + 0.002 * n * n)).model, 'n2');
	assert.equal(fit_curve(pts((n) => 30 + 2 * n)).model, 'n');
	assert.equal(fit_curve(pts((n) => 20 + 3 * n * Math.log2(n))).model, 'n_log_n');
	const flat = fit_curve(pts(() => 12));
	assert.equal(flat.model, 'const');
	assert.ok(Math.abs(flat.base_ns - 12) < 1e-6);
	// a built-in held to the curves its work has: a bend from fast keys to dictionary keys is
	// the wide_keys term, never a square
	const wide = (n: number) => Math.max(0, n - 32);
	const keys = [4, 8, 16, 32, 64, 256, 1024, 4096].map((n): PricePoint => ({
		key: 'x',
		n,
		terms: [0, 0, 0, 0, 0, wide(n)],
		ns: 7 + 0.3 * n + 13 * wide(n)
	}));
	const held = fit_curve(keys, INPUTS['Object.keys'].models);
	assert.notEqual(held.model, 'n2');
	assert.ok(Math.abs(held.terms_ns!.wide_keys! - 13) < 0.5);
	assert.deepEqual(INPUTS['Object.entries'].models, ['const', 'n']);
});

test('prices.json: same layout when written back; the version goes up only on a change', () => {
	const text = readFileSync(PRICES_PATH, 'utf8');
	const current = JSON.parse(text) as Prices & { note?: string };
	assert.equal(format_prices(current), text);
	assert.equal(next_prices(current, {}).changed, false);
	const same = next_prices(current, {
		'Array.prototype.sort': current.builtins['Array.prototype.sort']
	});
	assert.equal(same.changed, false);
	assert.equal(same.prices.version, current.version);
	const moved = next_prices(current, { 'Array.prototype.sort': { model: 'n2', base: 1, k: 1 } });
	assert.equal(moved.changed, true);
	assert.equal(moved.prices.version, current.version + 1);
});

test('price calibration: times built-ins over sizes and writes a new prices version', async () => {
	const dir = temp_dir('heisenbench-prices-');
	const out = join(dir, 'prices.json');
	write_files(dir, { 'prices.json': readFileSync(PRICES_PATH, 'utf8') });
	const r = await calibrate_prices({
		keys: ['Array.prototype.indexOf', 'Map.prototype.get'],
		sizes: [64, 512, 4096],
		time_ms: 30,
		step_ns: 0.5,
		out
	});
	const written = JSON.parse(readFileSync(out, 'utf8')) as Prices;
	assert.equal(r.changed, true);
	assert.equal(written.version, load_prices().prices.version + 1);
	// a linear scan stays linear; a hash lookup does not grow with the map
	assert.notEqual(r.fits['Array.prototype.indexOf'].model, 'const');
	assert.ok(['const', 'n'].includes(r.fits['Map.prototype.get'].model));
	assert.ok(written.builtins['Array.prototype.indexOf'].k > 0);
	assert.deepEqual(written.ops, load_prices().prices.ops);
	// fitted again with the same numbers: nothing changes, no new version
	const again = write_prices(out, written.builtins);
	assert.equal(again.changed, false);
});

test('price calibration into a file that does not exist yet starts from the committed prices', () => {
	const out = join(temp_dir('heisenbench-prices-new-'), 'prices.new.json');
	const current = load_prices().prices;
	const r = write_prices(out, current.builtins, undefined, PRICES_PATH);
	assert.equal(r.changed, false);
	const written = JSON.parse(readFileSync(out, 'utf8')) as Prices;
	assert.equal(written.version, current.version);
	assert.deepEqual(written.builtins, current.builtins);
});

function point(
	family: string,
	size: number,
	units: Record<string, number>,
	ns: number
): CorpusPoint {
	return {
		file: 'c.bench.ts',
		name: `${family} @${size}`,
		family: `c.bench.ts > ${family}`,
		units,
		steps: 0,
		ns
	};
}

test('weights: NNLS over op kinds; R^2 per family; a family steps cannot explain is time-led', () => {
	const truth: Record<string, number> = { call: 3, prop_read: 0.5, arith: 0.25, alloc: 6 };
	const pts: CorpusPoint[] = [];
	const jit: CorpusPoint[] = [];
	for (const n of [10, 40, 160, 640]) {
		const a = { call: n, arith: 2 * n };
		const b = { prop_read: 4 * n, alloc: n / 2 };
		const c = { call: n / 2, prop_read: n, arith: n };
		const ns = (u: Record<string, number>) =>
			5 + Object.entries(u).reduce((s, [k, v]) => s + v * truth[k], 0);
		const d = { arith: 3 * n };
		const e = { call: n, prop_read: n };
		pts.push(point('a', n, a, ns(a)), point('b', n, b, ns(b)), point('c', n, c, ns(c)));
		pts.push(point('d', n, d, ns(d)), point('e', n, e, ns(e)));
		// time that does not follow the steps at all (the JIT folds the loop): flat 40 ns
		jit.push(point('jit', n, { call: n, prop_read: 2 * n }, 40));
	}
	const fit = fit_weights(pts);
	for (const k of Object.keys(truth))
		assert.ok(Math.abs(fit.ns[k] - truth[k]) < 1e-3, `${k}: ${fit.ns[k]}`);
	assert.ok(Math.abs(fit.ns.case - 5) < 1e-3);
	for (const f of ['a', 'b', 'c']) assert.ok(fit.families[`c.bench.ts > ${f}`].r2! > 0.999);
	assert.equal(Object.keys(fit.ns).length, FEATURES.length);
	const mixed = fit_weights([...pts, ...jit]);
	assert.ok(mixed.families['c.bench.ts > jit'].r2! < mixed.time_led_below);
	assert.ok(mixed.families['c.bench.ts > d'].r2! > mixed.families['c.bench.ts > jit'].r2!);
});

test('weights calibration end to end: counted, timed, fitted, written with a version', async () => {
	const dir = temp_dir('heisenbench-weights-');
	write_files(dir, {
		'work.ts': `export function loop(n: number) { let s = 0; for (let i = 0; i < n; i++) s += i * 3; return s; }
export function objs(n: number) { const o = []; for (let i = 0; i < n; i++) o.push({ i }); return o.length; }
`,
		'work.bench.ts': `import { bench } from ${JSON.stringify(BENCH_API)};
import { loop, objs } from './work.ts';
for (const n of [100, 1000, 10000]) {
	bench(\`loop @\${n}\`, () => loop(n));
	bench(\`objs @\${n}\`, () => objs(n));
}
`
	});
	const out = join(dir, 'weights.json');
	const { weights, points } = await calibrate_weights({
		root: dir,
		files: [join(dir, 'work.bench.ts')],
		out,
		time_ms: 20,
		repeats: 1
	});
	assert.equal(points.length, 6);
	assert.equal(weights.version, 1);
	assert.deepEqual(Object.keys(weights.families).sort(), [
		'work.bench.ts > loop',
		'work.bench.ts > objs'
	]);
	assert.equal(weights.families['work.bench.ts > loop'].points, 3);
	assert.deepEqual(load_weights(out), weights);
	// the same fit written again keeps its version
	assert.equal(write_weights(out, { ...weights }).version, 1);
});

test('estimate: ns next to steps; time-led from the family fit or from the measured time', () => {
	const prices = load_prices().prices;
	const w = {
		version: 3,
		prices: { version: prices.version, hash: load_prices().hash },
		node: process.version,
		ns: Object.fromEntries(FEATURES.map((f) => [f, f === 'call' ? 2 : f === 'case' ? 10 : 0])),
		time_led_below: 0.9,
		fit: { r2: 0.95, points: 10 },
		families: {
			'x.bench.ts > fast': { r2: 0.99, points: 4 },
			'x.bench.ts > jit': { r2: 0.2, points: 4 }
		}
	};
	const c = (name: string): CaseReport =>
		({
			name,
			file: 'x.bench.ts',
			functions: [{ units: { call: 5, prop_read: 3 } }]
		}) as unknown as CaseReport;
	const fast = estimate_case(c('fast @10'), w, prices);
	assert.equal(fast.ns, 20);
	assert.equal(fast.time_led, false);
	assert.equal(fast.weights_version, 3);
	assert.equal(estimate_case(c('jit @10'), w, prices).time_led, true);
	assert.equal(estimate_case(c('other'), w, prices).r2, null);
	assert.equal(with_measured(fast, 25).time_led, false);
	assert.equal(with_measured(fast, 25).ratio, 1.25);
	assert.equal(with_measured(fast, 200).time_led, true);
});
