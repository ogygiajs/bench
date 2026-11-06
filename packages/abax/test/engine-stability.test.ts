import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engine_health } from '../src/engine/health.ts';
import { diff_engine, render_engine_markdown, skipped_line } from '../src/engine/diff.ts';
import { merge_runs, same_runs } from '../src/engine/stability.ts';
import { ENGINE_SCHEMA } from '../src/engine/types.ts';
import type { EngineCase, EngineFunction, EngineReport, EngineSite } from '../src/engine/types.ts';
import { temp_dir, write_files } from './helpers.ts';

/*
 * Repeatability of engine health: functions and sites whose runs disagree are marked unstable,
 * one by one, and the engine diff never makes a finding of them.
 */

function fn(path: string, over: Partial<EngineFunction> = {}): EngineFunction {
	return {
		id: `lib.ts > ${path}`,
		module: 'lib.ts',
		path,
		line: 10,
		tier: 'turbofan',
		inlined: false,
		optimized: true,
		forced: true,
		deopts: [],
		...over
	};
}

function site(path: string, key: string, state: EngineSite['state'], maps = 1): EngineSite {
	return {
		id: `lib.ts > ${path} > property read ${key} #0`,
		function: `lib.ts > ${path}`,
		module: 'lib.ts',
		line: 12,
		col: 3,
		kind: 'property read',
		key,
		state,
		maps
	};
}

function kase(functions: EngineFunction[], sites: EngineSite[]): EngineCase {
	return { name: 'c', file: 'x', stable: true, error: null, functions, sites };
}

function report(...cases: EngineCase[]): EngineReport {
	return { schema: ENGINE_SCHEMA, node: '', v8: '', flags: [], warmup: 1, runs: 1, cases };
}

const WEAK = {
	reason: 'embedded weak objects cleared',
	kind: 'dependency-change',
	line: 12,
	count: 1
};

test('runs that agree merge into the same case, marked stable', () => {
	const a = kase([fn('a'), fn('b')], [site('a', 'x', 'monomorphic')]);
	const b = structuredClone(a);
	assert.equal(same_runs(a, b), true);
	const m = merge_runs([a, b]);
	assert.equal(m.stable, true);
	assert.equal(m.repeats, 2);
	assert.deepEqual(m.functions, a.functions);
	assert.deepEqual(m.sites, a.sites);
});

test('two differing runs mark only the functions and sites that differ, with the reason', () => {
	const first = kase(
		[fn('a'), fn('b', { deopts: [WEAK] }), fn('c'), fn('only_first')],
		[site('a', 'x', 'monomorphic'), site('a', 'y', 'polymorphic', 2)]
	);
	const second = kase(
		[fn('a'), fn('b'), fn('c', { tier: 'maglev' })],
		[site('a', 'x', 'monomorphic'), site('a', 'y', 'megamorphic', 5)]
	);
	assert.equal(same_runs(first, second), false);
	const m = merge_runs([first, second]);
	assert.equal(m.stable, false);
	const by = new Map(m.functions.map((f) => [f.path, f]));
	assert.equal(by.get('a')!.unstable, undefined, 'a function both runs agree on stays clean');
	assert.equal(
		by.get('b')!.unstable,
		'deopt "embedded weak objects cleared" (line 12) in 1 of 2 runs'
	);
	assert.equal(by.get('c')!.unstable, 'tier turbofan / maglev');
	assert.equal(by.get('c')!.tier, 'turbofan', "an unstable entry keeps the first run's values");
	assert.equal(by.get('only_first')!.unstable, 'ran in 1 of 2 runs');
	const sites = new Map(m.sites.map((s) => [s.key, s]));
	assert.equal(sites.get('x')!.unstable, undefined);
	assert.equal(sites.get('y')!.unstable, 'state polymorphic / megamorphic; maps 2 / 5');
	assert.deepEqual(
		m.functions.map((f) => f.id),
		m.functions.map((f) => f.id).sort(),
		'merged entries stay sorted by id'
	);
});

test('a run that failed fails the merged case', () => {
	const ok = kase([fn('a')], []);
	const bad: EngineCase = { ...kase([], []), error: 'boom' };
	const m = merge_runs([ok, bad]);
	assert.equal(m.error, 'boom');
	assert.equal(m.stable, false);
});

test('engine diff never makes a finding (or a "better") of an unstable function or site', () => {
	const base = report(
		kase(
			[fn('a'), fn('b'), fn('c', { optimized: false, tier: 'baseline' })],
			[site('b', 'x', 'monomorphic')]
		)
	);
	// on the PR side every planted change is on an entry its runs did not agree on
	const pr = report({
		...kase(
			[
				fn('a', {
					tier: 'deoptimized',
					optimized: false,
					deopts: [{ reason: 'wrong map', kind: 'deopt-eager', line: 12, count: 1 }],
					unstable: 'tier deoptimized / turbofan'
				}),
				fn('b'),
				fn('c', { unstable: 'tier turbofan / baseline' }),
				fn('fresh', {
					deopts: [{ reason: 'wrong map', kind: 'deopt-eager', line: 30, count: 1 }],
					unstable: 'ran in 1 of 2 runs'
				})
			],
			[{ ...site('b', 'x', 'megamorphic', 6), unstable: 'state monomorphic / megamorphic' }]
		),
		stable: false
	});
	const d = diff_engine(base, pr);
	assert.deepEqual(d.findings, []);
	assert.deepEqual(d.better, [], 'c "optimized now" is not claimed either');
	assert.deepEqual(d.skipped, { functions: 3, sites: 1 });
	assert.deepEqual(d.unstable, ['c']);
	assert.equal(skipped_line(d), '3 functions and 1 inline cache skipped: V8 not repeatable (`c`)');
	assert.ok(render_engine_markdown(d).includes('3 functions and 1 inline cache skipped'));

	// the same reports without the marks: every one of them would have been a finding
	const unmarked = structuredClone(pr);
	const c = unmarked.cases[0];
	c.stable = true;
	for (const f of c.functions) delete f.unstable;
	for (const s of c.sites) delete s.unstable;
	const loud = diff_engine(base, unmarked);
	assert.equal(loud.findings.length, 3);
	assert.equal(loud.better.length, 1);
	assert.deepEqual(loud.skipped, { functions: 0, sites: 0 });
	assert.equal(skipped_line(loud), null);
});

test('engine diff: a base-side unstable entry is skipped too', () => {
	const base = report({
		...kase([fn('a', { unstable: 'tier turbofan / maglev' })], [site('a', 'x', 'monomorphic')]),
		stable: false
	});
	const pr = report(
		kase([fn('a', { tier: 'baseline', optimized: false })], [site('a', 'x', 'megamorphic', 4)])
	);
	const d = diff_engine(base, pr);
	assert.deepEqual(d.findings, []);
	assert.deepEqual(d.skipped, { functions: 1, sites: 0 });
});

test('engine diff: a case marked unstable without per-entry marks (an older report) is all skipped', () => {
	const base = report(kase([fn('a'), fn('b')], [site('a', 'x', 'monomorphic')]));
	const pr = report({
		...kase(
			[fn('a', { tier: 'baseline', optimized: false }), fn('b')],
			[site('a', 'x', 'megamorphic', 4)]
		),
		stable: false
	});
	const d = diff_engine(base, pr);
	assert.deepEqual(d.findings, []);
	assert.deepEqual(d.skipped, { functions: 2, sites: 0 });
	assert.deepEqual(d.unstable, ['c']);
});

test('engine diff: a deopt the garbage collector decides is never a finding', () => {
	const base = report(kase([fn('a'), fn('b', { deopts: [WEAK] })], []));
	const pr = report(
		kase(
			[
				fn('a', { deopts: [WEAK] }),
				fn('b'),
				fn('fresh', {
					deopts: [
						{
							reason: 'dependent allocation site tenuring changed',
							kind: 'dependency-change',
							line: 3,
							count: 1
						}
					]
				})
			],
			[]
		)
	);
	const d = diff_engine(base, pr);
	assert.deepEqual(d.findings, []);
	assert.deepEqual(d.better, [], 'nor a "better" when it goes away');
});

/*
 * A fixture whose engine state really differs from one child process to the next: the module
 * counts the processes that loaded it (a file next to it), and every other one feeds `read_x`
 * objects of eight shapes instead of one and, after the forced optimization, a double to
 * `add_one`. `sum` does the same thing in every process.
 */
function flaky_fixture(): { dir: string; bench: string; set_count: (n: number) => void } {
	const abax = fileURLToPath(new URL('../', import.meta.url));
	const dir = temp_dir('abax-engine-flaky-');
	write_files(dir, {
		'lib.ts': [
			"import { readFileSync, writeFileSync } from 'node:fs';",
			"const counter = new URL('./loads.txt', import.meta.url);",
			'let loads = 0;',
			'try {',
			"	loads = Number(readFileSync(counter, 'utf8'));",
			'} catch {}',
			'writeFileSync(counter, String(loads + 1));',
			'/** Odd processes see many shapes. */',
			'export const flip = loads % 2 === 1;',
			'export function read_x(o: { x: number }): number {',
			'	return o.x;',
			'}',
			'export function add_one(v: number): number {',
			'	return v + 1;',
			'}',
			'export function sum(xs: number[]): number {',
			'	let s = 0;',
			'	for (let i = 0; i < xs.length; i++) s += xs[i];',
			'	return s;',
			'}',
			''
		].join('\n'),
		'x.bench.ts': [
			`import { bench } from ${JSON.stringify(join(abax, 'src/bench.ts'))};`,
			"import { add_one, flip, read_x, sum } from './lib.ts';",
			'let calls = 0;',
			'function objects(): Array<{ x: number }> {',
			'	const out: Array<{ x: number }> = [];',
			'	for (let i = 0; i < 64; i++) {',
			'		const k = flip ? i % 8 : 0;',
			'		const o: Record<string, number> = {};',
			'		o["p" + k] = k;',
			'		o.x = i;',
			'		out.push(o as { x: number });',
			'	}',
			'	return out;',
			'}',
			"bench('flaky', ({ objs, xs }) => {",
			'	calls++;',
			'	let s = sum(xs);',
			'	for (const o of objs) s += read_x(o);',
			'	for (let i = 0; i < 50; i++) s += add_one(flip && calls > 21 ? i + 0.5 : i);',
			'	return s;',
			'}, {',
			'	setup: () => ({ objs: objects(), xs: Array.from({ length: 100 }, (_, i) => i) })',
			'});',
			''
		].join('\n')
	});
	return {
		dir,
		bench: join(dir, 'x.bench.ts'),
		set_count: (n) => writeFileSync(join(dir, 'loads.txt'), String(n))
	};
}

test('engine health marks what a genuinely nondeterministic case varies in, and the diff stays quiet', async () => {
	const fx = flaky_fixture();
	// base: one run (the list child loads 0, the case child 1... set so the case run is even)
	fx.set_count(1);
	const base = await engine_health({ files: [fx.bench], root: fx.dir, check: false });
	assert.equal(base.cases[0].error, null);
	// PR: the list child, then case runs alternate odd, even, odd, even
	fx.set_count(0);
	const pr = await engine_health({ files: [fx.bench], root: fx.dir });
	const c = pr.cases[0];
	assert.equal(c.error, null);
	assert.equal(c.stable, false);
	assert.equal(c.repeats, 4, 'two differing runs bring two more');
	const read = c.sites.find((s) => s.function.endsWith('> read_x') && s.key === 'x')!;
	assert.ok(read.unstable?.includes('state'), `read_x site: ${read.unstable}`);
	const add = c.functions.find((f) => f.path === 'add_one')!;
	assert.ok(add.unstable !== undefined, 'add_one deopts in every other process');
	const sum = c.functions.find((f) => f.path === 'sum')!;
	assert.equal(sum.unstable, undefined, 'sum does the same in every process');
	assert.ok(c.sites.filter((s) => s.function.endsWith('> sum')).every((s) => !s.unstable));

	const d = diff_engine(base, pr);
	assert.deepEqual(d.findings, [], 'no finding from an unstable entry');
	assert.ok(d.skipped.functions >= 1 && d.skipped.sites >= 1, JSON.stringify(d.skipped));
	assert.deepEqual(d.unstable, ['flaky']);

	// without the marks the first run's values (the odd process) would have made findings
	const unmarked = structuredClone(pr);
	unmarked.cases[0].stable = true;
	for (const f of unmarked.cases[0].functions) delete f.unstable;
	for (const s of unmarked.cases[0].sites) delete s.unstable;
	assert.ok(diff_engine(base, unmarked).findings.length > 0);
});
