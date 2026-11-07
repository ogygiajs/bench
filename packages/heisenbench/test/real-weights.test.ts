import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync } from 'node:zlib';
import { FrameMapper } from '../src/weight/frames.ts';
import {
	TRAFFIC_UNIT,
	import_traffic,
	read_cpuprofile,
	traffic_weights
} from '../src/weight/traffic.ts';
import { build_weights, merge_weights } from '../src/weight/weights.ts';
import type { AppWeights } from '../src/weight/weights.ts';
import { basis_of, rank_changes, rank_findings, render_weighted } from '../src/weight/rank.ts';
import { cost_text, coverage_line, real_cost, requests_per_day } from '../src/weight/cost.ts';
import { load_weights, units_ns } from '../src/calibrate/weights.ts';
import { load_prices } from '../src/prices.ts';
import type { DiffResult, FunctionChange } from '../src/diff/index.ts';
import type { FunctionReport } from '../src/report.ts';
import type { AppReport } from '../src/app/types.ts';
import { temp_dir } from './helpers.ts';

const ROOT = fileURLToPath(new URL('./fixtures/traffic/', import.meta.url));
const APP = 'file://' + join(ROOT, 'packages/demo/src/app.js');
const BUILT = 'file://' + join(ROOT, 'bundle/server/shop.js');

interface Node {
	id: number;
	callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
	children?: number[];
}

/** A CPU profile with the given tree and so many 100 µs samples per node. */
function cpuprofile(
	nodes: Array<
		[id: number, parent: number | null, name: string, url: string, line0: number, col0: number]
	>,
	hits: Record<number, number>,
	window_us = 10_000_000
) {
	const out: Node[] = nodes.map(([id, , name, url, line, col]) => ({
		id,
		callFrame: { functionName: name, url, lineNumber: line, columnNumber: col },
		children: []
	}));
	for (const [id, parent] of nodes)
		if (parent !== null) out.find((n) => n.id === parent)!.children!.push(id);
	const samples: number[] = [];
	for (const [id, n] of Object.entries(hits)) for (let i = 0; i < n; i++) samples.push(Number(id));
	return {
		nodes: out,
		startTime: 0,
		endTime: window_us,
		samples,
		timeDeltas: samples.map(() => 100)
	};
}

// Positions are what V8 reported for this file (`node --cpu-prof`): the `(` of each function.
const APP_PROFILE = cpuprofile(
	[
		[1, null, '(root)', '', -1, -1],
		[2, 1, 'heavy', APP, 0, 21],
		[3, 1, 'light', APP, 15, 21],
		[4, 3, '', APP, 16, 15],
		[5, 1, '(idle)', '', -1, -1],
		[6, 1, 'Box', APP, 6, 12],
		[7, 6, 'heavy', APP, 0, 21],
		[8, 1, '(garbage collector)', '', -1, -1],
		[9, 1, 'readSync', 'node:fs', 10, 4],
		[10, 1, 'get twice', APP, 9, 10]
	],
	{ 2: 30, 3: 10, 4: 20, 5: 10, 7: 10, 8: 5, 9: 5, 10: 4 }
);

test('a .cpuprofile: self time per function, total once per stack, ids as a bench names them', () => {
	const w = traffic_weights([{ ...read_cpuprofile(APP_PROFILE), hash: 'a' }], {
		root: ROOT,
		requests: 10
	});
	const f = (id: string) => w.functions[id]?.[TRAFFIC_UNIT];
	// 40 samples of 100 µs over 10 requests: 0.4 ms each, from both callers
	assert.equal(f('demo/app > heavy')?.self_ns, 400_000);
	assert.equal(f('demo/app > heavy')?.samples, 40);
	assert.equal(f('demo/app > light')?.self_ns, 100_000);
	// light's total holds its callback's 20 samples
	assert.equal(f('demo/app > light')?.total_ns, 300_000);
	// the anonymous callback: its place, the id weights are kept under
	assert.equal(f('demo/app > light > map:0')?.self_ns, 200_000);
	// V8 names a constructor after its class, at the constructor's `(`
	assert.equal(f('demo/app > Box > constructor')?.self_ns, 0);
	assert.equal(f('demo/app > Box > constructor')?.total_ns, 100_000);
	assert.equal(f('demo/app > Box > get twice')?.samples, 4);
	assert.equal(f('demo/app > heavy')?.calls_counted, false);
	const t = w.units[TRAFFIC_UNIT].traffic!;
	assert.equal(t.requests, 10);
	assert.equal(t.window_ms, 10_000);
	// idle is no work: 84 samples of code and engine, 74 of them in counted functions
	assert.equal(t.sampled_ms, 8.4);
	assert.equal(t.mapped_ms, 7.4);
	assert.deepEqual(
		t.unmatched.map((u) => [u.frame, u.reason, u.self_ms]),
		[
			['(garbage collector) (native):0', 'engine', 0.5],
			['readSync node:fs:11', 'node internals', 0.5]
		]
	);
	assert.match(coverage_line(w)!, /^88.1% of sampled self time mapped to counted functions/);
	// requests per day at the profile's rate: 10 in 10 s
	assert.deepEqual(requests_per_day(t), { n: 86_400, from: 'profiles' });
});

test('a built, minified module: frames map through its source map to the source ids', () => {
	const m = new FrameMapper({ root: ROOT });
	// positions V8 reported running bundle/server/shop.js (rolldown, minified, with a map)
	const ids = (
		[
			['e', 10],
			['', 30],
			['add', 80],
			['cheapest', 111],
			['', 141]
		] as const
	).map(([name, col]) => m.map({ url: BUILT, name, line: 1, col }).id);
	assert.deepEqual(ids, [
		'demo/shop > total',
		'demo/shop > total > reduce:0',
		'demo/shop > Cart > add',
		'demo/shop > Cart > cheapest',
		'demo/shop > Cart > cheapest > sort:0'
	]);
	// the same functions straight from the source give the same ids
	const src = 'file://' + join(ROOT, 'packages/demo/src/shop.ts');
	assert.equal(m.map({ url: src, name: 'total', line: 6, col: 21 }).id, 'demo/shop > total');
	// a path recorded on another machine
	const moved = new FrameMapper({ root: ROOT, path_map: [['/srv/app', ROOT.replace(/\/$/, '')]] });
	assert.equal(
		moved.map({ url: 'file:///srv/app/bundle/server/shop.js', name: 'add', line: 1, col: 80 }).id,
		'demo/shop > Cart > add'
	);
	assert.deepEqual(m.map({ url: 'file:///nowhere/x.js', name: 'f', line: 1, col: 0 }), {
		id: null,
		reason: 'no file here'
	});
});

/** An ogygia profiler dump of one page rendered 4 times, with V8's exact call counts. */
function ogygia_dump() {
	return {
		kind: 'ogygia-profiler-dump',
		version: 1,
		meta: {
			id: 'x',
			created: Date.UTC(2026, 10, 1, 12),
			trigger: 'page',
			duration_ms: 2000,
			sample_interval_us: 500,
			runs: [10, 11, 9, 10],
			requests: [{ path: '/secret?token=1', internal: true }]
		},
		analysis: {
			duration_ms: 2000,
			functions: [
				{
					name: 'total',
					path: join(ROOT, 'packages/demo/src/shop.ts'),
					line: 6,
					col: 22,
					self_ms: 8,
					total_ms: 10,
					calls: 400
				},
				{
					name: '(anonymous)',
					path: join(ROOT, 'packages/demo/src/shop.ts'),
					line: 7,
					col: 22,
					self_ms: 2,
					total_ms: 2,
					calls: 8000
				},
				{ name: '(idle)', path: '', line: 0, col: 0, self_ms: 50, total_ms: 50 }
			]
		},
		extras: {}
	};
}

function ogp(dump: unknown, secret: string): Buffer {
	const salt = randomBytes(16);
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', scryptSync(secret, salt, 32), iv);
	const ct = Buffer.concat([
		c.update(brotliCompressSync(Buffer.from(JSON.stringify(dump)))),
		c.final()
	]);
	return Buffer.concat([Buffer.from('OGP1'), salt, iv, ct, c.getAuthTag()]);
}

test('ogygia profiler reports (plain and .ogp) and the simple format, aggregated in any order', async () => {
	const dir = temp_dir();
	const dump = join(dir, 'page.json');
	const enc = join(dir, 'page.ogp');
	const simple = join(dir, 'traffic.json');
	writeFileSync(dump, JSON.stringify(ogygia_dump()));
	writeFileSync(enc, ogp(ogygia_dump(), 's3cret'));
	writeFileSync(
		simple,
		JSON.stringify({
			schema: 'heisenbench-traffic/1',
			requests: 2,
			window_ms: 1000,
			functions: [{ id: 'packages/demo/src/shop.ts > total', self_ms: 4, total_ms: 5, calls: 200 }]
		})
	);
	const w = await import_traffic([dump, enc, simple], { root: ROOT, secret: 's3cret' });
	const total = w.functions['demo/shop > total'][TRAFFIC_UNIT];
	// 4 + 4 + 2 requests; 8 + 8 + 4 ms of self time; 400 + 400 + 200 counted calls
	assert.equal(w.units[TRAFFIC_UNIT].units, 10);
	assert.equal(total.self_ns, 2_000_000);
	assert.equal(total.calls, 100);
	assert.equal(total.calls_counted, true);
	assert.equal(w.functions['demo/shop > total > reduce:0'][TRAFFIC_UNIT].calls, 1600);
	const t = w.units[TRAFFIC_UNIT].traffic!;
	assert.deepEqual(t.profiles, { json: 1, ogygia: 2 });
	assert.equal(t.start, '2026-11-01T12:00:00.000Z');
	// nothing about a request is kept
	assert.doesNotMatch(JSON.stringify(w), /secret|token/);
	// the same files in another order: the same bytes
	const again = await import_traffic([simple, enc, dump], { root: ROOT, secret: 's3cret' });
	assert.equal(JSON.stringify(again), JSON.stringify(w));
	await assert.rejects(import_traffic([enc], { root: ROOT, secret: 'wrong' }), /does not open/);
	await assert.rejects(
		import_traffic([simple, join(dir, 'x.cpuprofile')], { root: ROOT }),
		/ENOENT|no such file/
	);
});

function fn(module: string, path: string, calls: number, self_steps: number): FunctionReport {
	return {
		id: `${module} > ${path}`,
		module,
		path,
		kind: 'function',
		line: 1,
		end_line: 2,
		calls,
		self_steps,
		inclusive_steps: self_steps,
		allocations: 0,
		bytes: 0,
		shape: [],
		blocks: [],
		sites: [],
		builtins: [],
		lines: [],
		// steps are calls × 4 (call) + the rest in branches (1 step each)
		units: { call: calls, branch: self_steps - 4 * calls }
	};
}

function change(
	module: string,
	path: string,
	base: [number, number],
	pr: [number, number]
): FunctionChange {
	return {
		case: 'bench',
		module,
		function: path,
		renamed_from: null,
		line: 3,
		base: fn(module, path, ...base),
		pr: fn(module, path, ...pr),
		delta: {
			self_steps: pr[1] - base[1],
			inclusive_steps: pr[1] - base[1],
			allocations: 0,
			bytes: 0,
			calls: 0
		},
		findings: [
			{
				case: 'bench',
				kind: 'changed',
				module,
				function: path,
				line: 3,
				base: { steps: base[1], allocations: 0, bytes: 0 },
				pr: { steps: pr[1], allocations: 0, bytes: 0 },
				delta: { steps: pr[1] - base[1], allocations: 0, bytes: 0 }
			}
		]
	};
}

const DIFF = {
	changes: [
		// heavy: the bench calls it 10 times; each call goes from 104 to 404 steps
		change('packages/demo/src/app.js', 'heavy', [10, 1040], [10, 4040]),
		// light gains 10 steps a call; the traffic runs it less
		change('packages/demo/src/app.js', 'light', [10, 1040], [10, 1140]),
		// not in the traffic
		change('packages/demo/src/cold.js', 'cold', [1, 10], [1, 1010])
	]
} as unknown as DiffResult;

function app_weights(): AppWeights {
	const r = {
		schema: 'heisenbench-report/1',
		prices: { version: 1, hash: 'h' },
		node: 'v26',
		git: { sha: 'abc', prefix: '' },
		cases: [
			{
				name: 'shop request',
				file: '',
				stable: true,
				timers: 0,
				runaway_timers: false,
				error: null,
				totals: { steps: 100_000, allocations: 0, bytes: 0, calls: 0 },
				functions: [fn('packages/demo/src/cold.js', 'cold', 300, 3000)],
				edges: [],
				app: {
					scenario: 'shop',
					side: 'server',
					unit: 'request',
					units: 1,
					label: 'x',
					unstable_functions: []
				}
			}
		],
		app: { packages: [], ogygia: {}, scenarios: [], loaded: {} }
	} as unknown as AppReport;
	return build_weights([r]);
}

test('real cost: Δ per call × real calls per request × requests per day, in CPU time with a range', () => {
	const real = traffic_weights([{ ...read_cpuprofile(APP_PROFILE), hash: 'a' }], {
		root: ROOT,
		requests: 10
	});
	const ns_w = load_weights()!;
	const prices = load_prices().prices;
	const ranked = rank_changes(DIFF, real, ns_w, { requests_per_day: 1_000_000 });
	assert.deepEqual(
		ranked.map((r) => r.function),
		['heavy', 'light', 'cold']
	);
	const c = ranked[0].cost!;
	// by time: 0.4 ms of real self time per request × the change over one base call
	const base_ns = units_ns({ call: 1, branch: 100 }, ns_w, prices);
	const delta_ns = units_ns({ branch: 300 }, ns_w, prices);
	assert.deepEqual(
		c.ways.map((w) => w.from),
		['by time']
	);
	assert.ok(Math.abs(c.ways[0].ratio! - delta_ns / base_ns) < 1e-3);
	assert.ok(Math.abs(c.ns - (400_000 * delta_ns) / base_ns) / c.ns < 1e-3);
	assert.ok(Math.abs(c.cpu_s_per_day - (c.ns * 1e6) / 1e9) / c.cpu_s_per_day < 1e-3);
	// the fit's relative spread (one estimate over another of the same code) times sampling of 40
	const s = Math.exp(1.645 / Math.sqrt(40));
	const [p10, , p90] = ns_w.fit.spread!.relative;
	assert.ok(Math.abs(c.range[0] - (c.ns * p10) / s) / c.ns < 1e-3);
	assert.ok(Math.abs(c.range[1] - c.ns * p90 * s) / c.ns < 1e-3);
	assert.equal(c.requests_per_day_from, 'given');
	assert.match(
		cost_text(c),
		/^≈ [\d.]+ CPU-(seconds|minutes|hours)\/day at 1M requests\/day \(range [\d.]+–[\d.]+\)$/
	);
	assert.equal(ranked[2].cost, null);
	// shown: in the traffic, any change shows; the cold one is big enough on its own
	assert.deepEqual(
		ranked.map((r) => r.judgement.show),
		[true, true, true]
	);
	const md = render_weighted(ranked, basis_of(real), { coverage: coverage_line(real) });
	assert.match(md, /Basis: ranked by real cost/);
	assert.match(
		md,
		/`packages\/demo\/src\/app.js > heavy` \(`:3`\) \| \+300 steps \| cold \| 400 µs\/request of real time × 2\.8 → ≈ /
	);
	assert.match(md, /88.1% of sampled self time mapped/);
});

test('the two ways: per call, by time; the narrower when they agree, both when they do not', () => {
	const unit = {
		key: TRAFFIC_UNIT,
		traffic: {
			profiles: {},
			requests: 1,
			window_ms: 0,
			start: null,
			end: null,
			sampled_ms: 1,
			mapped_ms: 1,
			unmatched: []
		}
	};
	const ctx = {
		ns_weights: load_weights(),
		prices: load_prices().prices,
		requests_per_day: 86_400
	};
	const delta_ns = units_ns({ branch: 300 }, ctx.ns_weights!, ctx.prices);
	const base_ns = units_ns({ call: 1, branch: 100 }, ctx.ns_weights!, ctx.prices);
	const input = {
		delta_steps: 300,
		delta_units: { branch: 300 },
		kind: 'self' as const,
		per_call: true
	};
	const with_base = { ...input, ref_steps: 104, ref_units: { call: 1, branch: 100 } };
	const w = {
		calls: 40,
		self_steps: 0,
		inclusive_steps: 0,
		self_ns: 0,
		samples: 0,
		calls_counted: true
	};
	// counted calls: Δns per call × 40, the fit's absolute range
	const c = real_cost(w, unit, input, ctx)!;
	assert.deepEqual(
		c.ways.map((x) => [x.from, x.calls]),
		[['counted', 40]]
	);
	assert.ok(Math.abs(c.ns - delta_ns * 40) / c.ns < 1e-3);
	const [a10, , a90] = ctx.ns_weights!.fit.spread!.absolute;
	assert.ok(Math.abs(c.range[1] / c.range[0] - a90 / a10) < 1e-2);
	// the app scenarios' calls when the profile did not count
	const app = real_cost(
		{ ...w, calls: 0, calls_counted: false },
		unit,
		{ ...input, app_calls: 2 },
		ctx
	)!;
	assert.deepEqual(
		app.ways.map((x) => [x.from, x.calls]),
		[['app scenarios', 2]]
	);
	// both ways agree (the real time is 40 base calls): the narrower range, by time
	const agree = real_cost({ ...w, self_ns: 40 * base_ns, samples: 10_000 }, unit, with_base, ctx)!;
	assert.equal(agree.disagree, null);
	assert.equal(agree.ns, agree.ways.find((x) => x.from === 'by time')!.ns);
	// they disagree (the real time is a million base calls' worth): the geometric mean, a range over both
	const apart = real_cost({ ...w, self_ns: 1e6 * base_ns, samples: 10_000 }, unit, with_base, ctx)!;
	const [p, t] = apart.ways.map((x) => x.ns);
	assert.ok(Math.abs(apart.ns - Math.sqrt(p * t)) / apart.ns < 1e-3);
	assert.ok(apart.disagree! > 20_000);
	assert.ok(apart.range[0] <= Math.min(...apart.ways.map((x) => x.range[0])));
	assert.ok(apart.range[1] >= Math.max(...apart.ways.map((x) => x.range[1])));
	assert.match(cost_text(apart), /range [\d.]+ CPU-\w+ to [\d.]+ CPU-\w+/);
	assert.equal(requests_per_day(unit.traffic), null);
	assert.equal(
		real_cost(
			w,
			unit,
			{ delta_steps: 300, kind: 'self', per_call: true },
			{ ...ctx, requests_per_day: undefined }
		),
		null
	);
});

test('the basis: real traffic, else app weights, else steps; said in the section', () => {
	const real = traffic_weights([{ ...read_cpuprofile(APP_PROFILE), hash: 'a' }], {
		root: ROOT,
		requests: 10
	});
	const app = app_weights();
	assert.equal(basis_of(merge_weights([app, real])), 'real traffic');
	assert.equal(basis_of(app), 'app weights');
	assert.equal(basis_of(null), 'steps');
	// with both, a change real traffic does not run is still ranked by its app weight
	const both = rank_findings(DIFF, null, null, merge_weights([app, real]), load_weights(), {
		requests_per_day: 1e6
	});
	assert.equal(both.basis, 'real traffic');
	const cold = both.ranked.find((r) => r.function === 'cold')!;
	assert.equal(cold.cost, null);
	assert.equal(cold.judgement.top?.unit, 'shop server request');
	// app weights only: today's order, by steps per unit
	const by_app = rank_findings(DIFF, null, null, app, load_weights());
	assert.equal(by_app.basis, 'app weights');
	assert.equal(by_app.ranked[0].function, 'cold');
	assert.doesNotMatch(render_weighted(by_app.ranked, by_app.basis), /Basis:/);
	// nothing: by steps per call
	const by_steps = rank_findings(DIFF, null, null, null, load_weights());
	assert.deepEqual(
		by_steps.ranked.map((r) => r.function),
		['cold', 'heavy', 'light']
	);
	assert.match(render_weighted(by_steps.ranked, by_steps.basis), /Basis: ranked by steps per call/);
});

test('determinism: the same profiles give the same weights file and the same ranking', () => {
	const a = traffic_weights([{ ...read_cpuprofile(APP_PROFILE), hash: 'a' }], {
		root: ROOT,
		requests: 10
	});
	const b = traffic_weights([{ ...read_cpuprofile(APP_PROFILE), hash: 'a' }], {
		root: ROOT,
		requests: 10
	});
	assert.equal(JSON.stringify(a), JSON.stringify(b));
	const ra = rank_findings(DIFF, null, null, a, load_weights(), { requests_per_day: 1e6 });
	const rb = rank_findings(DIFF, null, null, b, load_weights(), { requests_per_day: 1e6 });
	assert.equal(JSON.stringify(ra), JSON.stringify(rb));
});
