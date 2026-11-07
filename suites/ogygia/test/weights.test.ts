import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPORT_SCHEMA, environment } from '@bench/heisenbench';
import type { DiffResult, Report } from '@bench/heisenbench';
import type { AppReport } from '@bench/heisenbench/app';
import type { AppWeights } from '@bench/heisenbench/weight';
import { main_weights, rank_by_weights } from '../src/weights.ts';
import type { StoredWeights } from '../src/weights.ts';
import { weight_lines } from '../src/section.ts';

const SHA = 'a'.repeat(40);

const head: Report = {
	schema: REPORT_SCHEMA,
	prices: { version: 1, hash: 'h' },
	node: process.version,
	env: environment(),
	git: { sha: SHA, prefix: '' },
	cases: []
};

const fn = (self_steps: number, calls: number) => ({ self_steps, calls }) as never;

/** One changed function per case: `match_one` in the router, `+steps` per call. */
function diff_of(changes: Array<[string, string, number]>): DiffResult {
	return {
		changes: changes.map(([name, path, per_call]) => ({
			case: name,
			module: 'packages/router/src/match.ts',
			function: path,
			renamed_from: null,
			line: 140,
			base: fn(100, 10),
			pr: fn(100 + per_call * 10, 10),
			delta: { self_steps: per_call * 10, inclusive_steps: 0, allocations: 0, bytes: 0, calls: 0 },
			findings: [{ line: 140, delta: { steps: per_call * 10, allocations: 0, bytes: 0 } } as never]
		})),
		findings: [],
		renames: [],
		unstable: [],
		failed: [],
		missing: { base: [], pr: [] },
		cases: [],
		packages: [],
		prices_match: true
	};
}

function stored(over: Partial<StoredWeights> = {}): StoredWeights {
	return {
		schema: 'heisenbench-app-weights/1',
		source: { sha: 'b'.repeat(40), ogygia: {}, scenarios: ['dashboard'] },
		units: { 'dashboard server request': { steps: 1_000_000, units: 4, side: 'server' } },
		functions: {
			'router/match > match_one': {
				'dashboard server request': { calls: 300, self_steps: 20_000, inclusive_steps: 20_000 }
			},
			'router/match > rare': {
				'dashboard server request': { calls: 1, self_steps: 10, inclusive_steps: 10 }
			}
		},
		node: process.version,
		env: environment(),
		...over
	};
}

function file_of(w: unknown): string {
	const path = join(mkdtempSync(join(tmpdir(), 'weights-')), 'app-weights.json');
	writeFileSync(path, typeof w === 'string' ? w : JSON.stringify(w));
	return path;
}

test('changed functions are ranked by what they cost per unit of real work', () => {
	const diff = diff_of([
		// one call per request, but 200 steps more each: 0.02% of the request, shown
		['match_path', 'rare', 200],
		['match_path', 'match_one', 4],
		['match_path', 'cold_helper', 3]
	]);
	const w = rank_by_weights(file_of(stored()), diff, head);
	assert.equal(w.status, 'ranked');
	assert.equal(w.sha, 'b'.repeat(40));
	assert.deepEqual(
		w.ranked.map((r) => [r.function, r.heat, r.show]),
		[
			['packages/router/src/match.ts > match_one', 'heavy', true],
			['packages/router/src/match.ts > rare', 'warm', true],
			['packages/router/src/match.ts > cold_helper', 'cold', false]
		]
	);
	assert.equal(w.ranked[0].top?.steps, 1200);
	assert.deepEqual([w.shown, w.suppressed], [2, 1]);
	const md = weight_lines(w).join('\n');
	assert.match(md, /\*\*Real-app weight\*\* \(main `bbbbbbb`\)/);
	assert.match(
		md,
		/\| `packages\/router\/src\/match\.ts > match_one:140` \| \+4 steps \| heavy \| \+1200 steps .*per dashboard server request \(300 calls\) \|/
	);
	assert.match(md, /1 small, on a cold or warm path, not shown\./);
});

test('no weights, unreadable ones or another environment: one line, nothing ranked', () => {
	const diff = diff_of([['c', 'match_one', 4]]);
	const missing = rank_by_weights('/nonexistent/app-weights.json', diff, head);
	assert.equal(missing.status, 'missing');
	assert.deepEqual(weight_lines(missing), [
		'**Real-app weight**: not ranked, no stored weights from a main run yet.',
		''
	]);
	assert.equal(rank_by_weights(file_of('{oops'), diff, head).status, 'unreadable');
	assert.equal(rank_by_weights(file_of({ schema: 'x' }), diff, head).status, 'unreadable');
	const other = rank_by_weights(file_of(stored({ node: 'v25.0.0' })), diff, head);
	assert.equal(other.status, 'mismatch');
	assert.equal(other.ranked.length, 0);
	assert.match(
		weight_lines(other)[0],
		/not ranked, they were counted in another environment \(Node v25\.0\.0 vs v\d.*\) \(main `bbbbbbb`\)\./
	);
	const unstamped = rank_by_weights(file_of(stored({ env: undefined })), diff, head);
	assert.equal(unstamped.status, 'mismatch');
});

test('the main run’s weights carry the commit and the environment that counted them', () => {
	const report = {
		...head,
		cases: [
			{
				name: 'dashboard GET /',
				file: '',
				stable: true,
				timers: 0,
				runaway_timers: false,
				error: null,
				totals: { steps: 1000, allocations: 0, bytes: 0, calls: 1 },
				functions: [
					{
						module: '@ogygia/core/dist/router/match.js',
						path: 'match_one',
						calls: 30,
						self_steps: 600,
						inclusive_steps: 600
					}
				],
				edges: [],
				app: {
					scenario: 'dashboard',
					side: 'server',
					unit: 'request',
					units: 2,
					label: 'GET /',
					unstable_functions: []
				}
			}
		],
		app: { packages: [], ogygia: {}, scenarios: ['dashboard'], loaded: {} }
	} as unknown as AppReport;
	const w = main_weights([report], SHA);
	assert.equal(w.source.sha, SHA);
	assert.equal(w.node, process.version);
	assert.deepEqual(w.env, environment());
	assert.equal(w.functions['core/router/match > match_one']['dashboard server request'].calls, 15);
	assert.throws(() => main_weights([{ ...report, node: 'v1.0.0' }], SHA), /Node v1\.0\.0/);
});

/** Weights of real traffic as `heisenbench weights import` writes them: 100 requests in 10 s. */
function real(): AppWeights {
	return {
		schema: 'heisenbench-app-weights/1',
		source: { sha: null, ogygia: {}, scenarios: [] },
		units: {
			'real request': {
				steps: 0,
				units: 100,
				side: 'server',
				traffic: {
					profiles: { cpuprofile: 1 },
					requests: 100,
					window_ms: 10_000,
					start: null,
					end: null,
					sampled_ms: 100,
					mapped_ms: 82,
					unmatched: [{ frame: 'parse (native):0', reason: 'no file', self_ms: 18 }]
				}
			}
		},
		functions: {
			'router/match > rare': {
				'real request': {
					calls: 0,
					self_steps: 0,
					inclusive_steps: 0,
					self_ns: 50_000,
					total_ns: 50_000,
					samples: 400,
					calls_counted: false
				}
			}
		}
	};
}

test('with real traffic on the results branch, findings are ranked by real cost', () => {
	const diff = diff_of([
		['match_path', 'match_one', 4],
		['match_path', 'rare', 200]
	]);
	const w = rank_by_weights(file_of(stored()), diff, head, { real_path: file_of(real()) });
	assert.equal(w.basis, 'real traffic');
	assert.equal(w.real?.status, 'used');
	// `rare` runs once per scenario request, but real traffic spends 50 µs a request in it
	assert.deepEqual(
		w.ranked.map((r) => [r.function, r.cost ? 'real' : 'none']),
		[
			['packages/router/src/match.ts > rare', 'real'],
			['packages/router/src/match.ts > match_one', 'none']
		]
	);
	assert.equal(w.ranked[0].cost?.requests_per_day_from, 'profiles');
	const md = weight_lines(w).join('\n');
	assert.match(md, /\*\*Real cost\*\*; app weights of main `bbbbbbb`/);
	assert.match(md, /82% of sampled self time mapped to counted functions/);
	assert.match(
		md,
		/\| `packages\/router\/src\/match\.ts > rare:140` \| \+200 steps per call \| .*≈ .*CPU-.*\/day at 864K requests\/day/
	);
	assert.match(
		md,
		/match_one:140` \| \+4 steps per call \| not in the imported traffic \| \+1200 steps per dashboard server request/
	);
	// no file: today's ranking, never a failure
	const none = rank_by_weights(file_of(stored()), diff, head, {
		real_path: '/nonexistent/real-weights.json'
	});
	assert.equal(none.basis, 'app weights');
	assert.equal(none.real?.status, 'missing');
	assert.match(weight_lines(none).join('\n'), /\*\*Real-app weight\*\* \(main `bbbbbbb`\)/);
	// unreadable: said, and today's ranking
	const bad = rank_by_weights(file_of(stored()), diff, head, { real_path: file_of('{nope') });
	assert.equal(bad.real?.status, 'unreadable');
	assert.equal(bad.basis, 'app weights');
	// app weights from another environment: real traffic still ranks, and the section says why
	const other = rank_by_weights(file_of(stored({ node: 'v25.0.0' })), diff, head, {
		real_path: file_of(real())
	});
	assert.equal(other.status, 'ranked');
	assert.equal(other.basis, 'real traffic');
	assert.match(
		weight_lines(other).join('\n'),
		/App weights not used: they were counted in another environment/
	);
});
