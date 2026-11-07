import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engine_health, why_not_optimized } from '../src/engine/health.ts';
import { diff_engine } from '../src/engine/diff.ts';
import type { EngineCase, EngineReport } from '../src/engine/types.ts';
import { temp_dir, write_files } from './helpers.ts';

/*
 * Found by a full run of suites/ogygia: keyed sites reported "megamorphic" with maps=1 or 2, and
 * 209 of 1085 functions "not optimized", most of them run a few times per case. Both were true,
 * and both were worded as if something was wrong with shapes or with V8.
 */

const BENCH_API = fileURLToPath(new URL('../src/bench.ts', import.meta.url));

const LIB = `/** One object, many property names: the keyed site sees one shape. */
export function walk(o: Record<string, number>, keys: string[]): number {
	let s = 0;
	for (const k of keys) s += o[k];
	return s;
}

/** One property name, many shapes. */
export function read_x(list: Array<Record<string, number>>): number {
	let s = 0;
	for (const o of list) s += o.x;
	return s;
}

export function cases(o: Record<string, number>, keys: string[], list: Array<Record<string, number>>): number {
	// runs once per case, out of reach of the forced optimization and never inlined (a
	// generator): it never gets hot enough to optimize
	function* once(n: number) {
		yield n + 1;
	}
	return walk(o, keys) + read_x(list) + (once(1).next().value ?? 0);
}
`;

async function health(): Promise<EngineCase> {
	const dir = temp_dir('heisenbench-engine-causes-');
	write_files(dir, {
		'lib.ts': LIB,
		'x.bench.ts': [
			`import { bench } from ${JSON.stringify(BENCH_API)};`,
			"import { cases } from './lib.ts';",
			"bench('causes', ({ o, keys, list }) => cases(o, keys, list), {",
			'	setup: () => ({',
			"		o: Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['k' + i, i])),",
			"		keys: Array.from({ length: 40 }, (_, i) => 'k' + i),",
			'		list: [{ x: 1 }, { x: 1, a: 1 }, { x: 1, b: 1 }, { x: 1, c: 1 }, { x: 1, d: 1 }, { x: 1, e: 1 }, { x: 1, f: 1 }]',
			'	})',
			'});',
			''
		].join('\n')
	});
	const r = await engine_health({ files: [join(dir, 'x.bench.ts')], root: dir, check: false });
	return r.cases[0];
}

test('a keyed site that goes megamorphic on one shape is "keys of many names", not shapes', async () => {
	const c = await health();
	const walk = c.sites.find((s) => s.function === 'lib.ts > walk' && s.kind === 'keyed read');
	assert.ok(walk, JSON.stringify(c.sites));
	assert.equal(walk.state, 'megamorphic');
	assert.ok(walk.maps <= 2, `maps ${walk.maps}`);
	assert.ok((walk.keys ?? 0) > 1);
	assert.equal(walk.cause, 'keys');
	const x = c.sites.find((s) => s.function === 'lib.ts > read_x' && s.key === 'x');
	assert.ok(x, JSON.stringify(c.sites));
	assert.equal(x.state, 'megamorphic');
	assert.equal(x.cause, 'shapes');

	// the diff says what happened in plain words
	const base: EngineCase = {
		...c,
		sites: c.sites.map((s) => ({ ...s, state: 'monomorphic', cause: undefined }))
	};
	const report = (cs: EngineCase): EngineReport => ({
		schema: 'heisenbench-engine/1',
		node: '',
		v8: '',
		flags: [],
		warmup: 0,
		runs: 0,
		cases: [cs]
	});
	const d = diff_engine(report(base), report(c));
	const texts = d.findings.map((f) => f.text);
	assert.ok(
		texts.some((t) => t.includes('keyed read') && t.includes('generic (keys of many names')),
		texts.join('\n')
	);
	assert.ok(
		texts.some((t) => t.includes('-> megamorphic')),
		texts.join('\n')
	);
});

test('a function that never ran hot is cold, not "not optimized", and is no finding', async () => {
	// the classes: lost optimized code, forced and refused, or never hot
	assert.equal(why_not_optimized('baseline', false, false, []), 'cold');
	assert.equal(why_not_optimized('interpreted', false, false, []), 'cold');
	assert.equal(
		why_not_optimized('baseline', false, false, [
			{ reason: 'Insufficient type feedback for call', kind: 'deopt-soft', line: 1, count: 1 }
		]),
		'cold',
		'a deopt on code that had not run yet is cold'
	);
	assert.equal(why_not_optimized('baseline', false, true, []), 'refused');
	assert.equal(why_not_optimized('baseline', true, false, []), 'deoptimized');
	assert.equal(why_not_optimized('deoptimized', true, true, []), 'deoptimized');

	const c = await health();
	// a nested function the forced optimization does not reach: optimized only when inlined into
	// its caller, and otherwise cold, never "refused" or "deoptimized"
	const once = c.functions.find((f) => f.id === 'lib.ts > cases > once');
	assert.ok(once, JSON.stringify(c.functions.map((f) => f.id)));
	assert.ok(once.optimized || once.not_optimized === 'cold', JSON.stringify(once));
	const report = (cs: EngineCase): EngineReport => ({
		schema: 'heisenbench-engine/1',
		node: '',
		v8: '',
		flags: [],
		warmup: 0,
		runs: 0,
		cases: [cs]
	});
	// optimized on the base, cold on the PR: not V8 refusing it
	const base: EngineCase = {
		...c,
		functions: c.functions.map((f) =>
			f.id === once.id ? { ...f, optimized: true, tier: 'turbofan', not_optimized: undefined } : f
		)
	};
	const cold: EngineCase = {
		...c,
		functions: c.functions.map((f) =>
			f.id === once.id
				? { ...f, optimized: false, tier: 'baseline', inlined: false, not_optimized: 'cold' }
				: f
		)
	};
	const d = diff_engine(report(base), report(cold));
	assert.ok(!d.findings.some((f) => f.function === once.path), JSON.stringify(d.findings));
	// refused or deoptimized is still a finding
	const refused: EngineCase = {
		...cold,
		functions: cold.functions.map((f) =>
			f.id === once.id ? { ...f, not_optimized: 'refused' } : f
		)
	};
	const d2 = diff_engine(report(base), report(refused));
	assert.ok(
		d2.findings.some((f) => f.function === once.path && f.text.includes('refused')),
		JSON.stringify(d2.findings)
	);
});
