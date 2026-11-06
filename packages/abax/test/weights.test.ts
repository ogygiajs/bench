import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build_weights, canonical_function, canonical_module } from '../src/weight/weights.ts';
import {
	COLD_STEPS,
	HEAVY_CALLS,
	HEAVY_SHARE,
	TINY_SHARE,
	judge,
	rank_changes,
	render_weighted
} from '../src/weight/rank.ts';
import type { AppReport, AppCaseReport } from '../src/app/types.ts';
import type { FunctionReport } from '../src/report.ts';
import type { DiffResult, FunctionChange } from '../src/diff/index.ts';

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
		units: { call: calls }
	};
}

function app_case(
	scenario: string,
	unit: AppCaseReport['app']['unit'],
	units: number,
	steps: number,
	functions: FunctionReport[]
): AppCaseReport {
	return {
		name: `${scenario} ${unit}`,
		file: '',
		stable: true,
		timers: 0,
		runaway_timers: false,
		error: null,
		totals: { steps, allocations: 0, bytes: 0, calls: 0 },
		functions,
		edges: [],
		app: {
			scenario,
			side: unit === 'request' || unit === 'prerender' ? 'server' : 'browser',
			unit,
			units,
			label: 'x',
			unstable_functions: []
		}
	};
}

function app_report(cases: AppCaseReport[]): AppReport {
	return {
		schema: 'abax-report/1',
		prices: { version: 1, hash: 'h' },
		node: 'v26',
		git: { sha: 'abc', prefix: '' },
		cases,
		app: { packages: ['ogygia'], ogygia: { ogygia: '1.0.0' }, scenarios: [], loaded: {} }
	};
}

test('canonical ids match an installed package to the source it was built from', () => {
	assert.equal(canonical_module('@ogygia/core/dist/router/match.js'), 'core/router/match');
	assert.equal(canonical_module('packages/core/src/router/match.ts'), 'core/router/match');
	assert.equal(canonical_module('ogygia/dist/index.js'), 'ogygia/index');
	assert.equal(canonical_module('packages/ogygia/src/index.ts'), 'ogygia/index');
	assert.equal(canonical_module('@ogygia/core/dist/Region.svelte'), 'core/Region.svelte');
	assert.equal(canonical_module('packages/core/src/state.svelte.ts'), 'core/state.svelte');
	assert.equal(canonical_module('@ogygia/core/dist/state.svelte.js'), 'core/state.svelte');
	assert.equal(
		canonical_module('svelte/src/internal/client/render.js'),
		'svelte/internal/client/render'
	);
	assert.equal(
		canonical_function('@ogygia/core/dist/a.js', 'Router > match'),
		'core/a > Router > match'
	);
});

test('weights are calls and steps per unit, averaged over every case of the unit', () => {
	const w = build_weights([
		app_report([
			app_case('dashboard', 'request', 5, 5000, [fn('@ogygia/core/dist/a.js', 'f', 50, 500)]),
			app_case('dashboard', 'request', 5, 3000, [fn('@ogygia/core/dist/a.js', 'f', 10, 100)]),
			app_case('dashboard', 'interaction', 1, 70, [fn('@ogygia/core/dist/b.js', 'g', 7, 70)])
		])
	]);
	assert.deepEqual(w.units['dashboard server request'], { steps: 800, units: 10, side: 'server' });
	assert.deepEqual(w.units['dashboard interaction'], { steps: 70, units: 1, side: 'browser' });
	assert.deepEqual(w.functions['core/a > f'], {
		'dashboard server request': { calls: 6, self_steps: 60, inclusive_steps: 60 }
	});
	assert.equal(w.functions['core/b > g']['dashboard interaction'].calls, 7);
	assert.deepEqual(w.source.scenarios, ['dashboard']);
});

test('judge: one place decides heavy, warm and cold, show and suppress', () => {
	const units = { 'dashboard server request': { steps: 1_000_000 } };
	const w = (calls: number, self_steps = 0) => ({
		'dashboard server request': { calls, self_steps }
	});

	// heavy by calls: even one step per call shows
	const heavy = judge(1, w(HEAVY_CALLS), units);
	assert.equal(heavy.heat, 'heavy');
	assert.equal(heavy.show, true);
	assert.equal(heavy.top?.steps, HEAVY_CALLS);

	// heavy by its own share of the unit
	const share = judge(0.5, w(2, HEAVY_SHARE * 1_000_000), units);
	assert.equal(share.heat, 'heavy');
	assert.equal(share.show, true);

	// warm: shown only when the impact reaches TINY_SHARE of the unit
	const tiny = judge(10, w(5), units); // 50 steps of 1M = 5e-5
	assert.equal(tiny.heat, 'warm');
	assert.equal(tiny.show, false);
	const visible = judge(TINY_SHARE * 1_000_000, w(1), units);
	assert.equal(visible.show, true);

	// cold: no scenario runs it; small changes suppressed, big ones still show
	assert.deepEqual(
		{ ...judge(COLD_STEPS - 1, undefined, units), impacts: [] },
		{ heat: 'cold', show: false, top: null, impacts: [] }
	);
	assert.equal(judge(COLD_STEPS, undefined, units).show, true);
	assert.equal(judge(-COLD_STEPS, {}, units).show, true);

	// no change is never shown
	assert.equal(judge(0, w(10_000), units).show, false);

	// ns follows the calls
	assert.equal(judge(2, w(300), units, 0.5).top?.ns, 150);
});

function change(
	module: string,
	path: string,
	base: [number, number],
	pr: [number, number]
): FunctionChange {
	const b = fn(module, path, base[0], base[1]);
	const p = fn(module, path, pr[0], pr[1]);
	return {
		case: 'bench',
		module,
		function: path,
		renamed_from: null,
		line: 10,
		base: b,
		pr: p,
		delta: {
			self_steps: pr[1] - base[1],
			inclusive_steps: pr[1] - base[1],
			allocations: 0,
			bytes: 0,
			calls: pr[0] - base[0]
		},
		findings: [
			{
				case: 'bench',
				kind: 'changed',
				module,
				function: path,
				line: 12,
				base: { steps: base[1], allocations: 0, bytes: 0 },
				pr: { steps: pr[1], allocations: 0, bytes: 0 },
				delta: { steps: pr[1] - base[1], allocations: 0, bytes: 0 }
			}
		]
	};
}

test('rank_changes: a bench change times real-app calls, heaviest first, cold ones suppressed', () => {
	const weights = build_weights([
		app_report([
			app_case('dashboard', 'request', 1, 100_000, [
				fn('@ogygia/core/dist/router/match.js', 'match', 300, 30_000),
				fn('@ogygia/core/dist/util.js', 'small', 2, 20)
			])
		])
	]);
	const diff = {
		changes: [
			// a bench of the source: same function, its source path
			change('packages/core/src/router/match.ts', 'match', [10, 1000], [10, 1400]),
			// +10 per call x 2 calls = 20 steps of 100K: 2e-4 of the request, above TINY_SHARE
			change('packages/core/src/util.ts', 'small', [1, 10], [1, 20]),
			change('packages/core/src/unused.ts', 'cold', [1, 10], [1, 12])
		]
	} as unknown as DiffResult;
	const ranked = rank_changes(diff, weights, null);
	assert.deepEqual(
		ranked.map((r) => [r.function, r.judgement.heat, r.judgement.show]),
		[
			['match', 'heavy', true],
			['small', 'warm', true],
			['cold', 'cold', false]
		]
	);
	// +40 steps per call x 300 calls per request
	assert.equal(ranked[0].judgement.top?.steps, 12_000);
	assert.equal(ranked[0].judgement.top?.unit, 'dashboard server request');
	const md = render_weighted(ranked);
	assert.match(
		md,
		/`packages\/core\/src\/router\/match.ts > match`.*\+12\.0K steps per dashboard server request \(300 calls\)/
	);
	assert.match(md, /1 suppressed/);
	assert.match(md, /`packages\/core\/src\/unused.ts > cold`: \+2 steps per call, cold/);
});
