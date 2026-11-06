import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { run_child } from '../src/measure/spawn.ts';
import type { CaseResult } from '../src/measure/child.ts';
import type { BytesResult } from '../src/measure/alloc.ts';
import { MAX_SAMPLES } from '../src/measure/alloc.ts';
import { run_benches } from '../src/runner.ts';
import { compare_bytes } from '../src/measure/elision.ts';
import { temp_dir, write_files } from './helpers.ts';

/*
 * Estimated bytes (counted build) and real bytes (V8's sampling heap profiler, plain build) are
 * per call and cover the same code: the source functions, what their built-in calls return, not a
 * dependency's own allocations. Found by a full run of suites/ogygia: real bytes crashed on large
 * cases, and came out 10 to 100 times the estimate on string-heavy ones.
 */

const BENCH_API = fileURLToPath(new URL('../src/bench.ts', import.meta.url));

const LIB = `import { pad } from 'dep';

/** A front-matter-like parse: lines cut by split, keys and values by trim and slice. */
export function parse(text: string): number {
	const out: Array<{ k: string; v: string }> = [];
	for (const line of text.split('\\n')) {
		const at = line.indexOf(':');
		if (at === -1) continue;
		out.push({ k: line.slice(0, at).trim(), v: line.slice(at + 1).trim() });
	}
	return out.length;
}

/** Allocates about 40 MB a call: the profile of a batch used to be longer than V8 can build. */
export function big(): number {
	return new Array(10_000_000).fill(1).length;
}

/** All of its allocating happens in a dependency. */
export function through(): number {
	return pad(1000).length;
}
`;

const DEP = `export function pad(n) {
	const out = [];
	for (let i = 0; i < n; i++) out.push({ i });
	return out;
}
`;

const TEXT = Array.from(
	{ length: 200 },
	(_, i) => `key_number_${i}: a value that is long enough ${i}`
).join('\n');

function files(dir: string): void {
	write_files(dir, {
		'lib.ts': LIB,
		'node_modules/dep/package.json': JSON.stringify({
			name: 'dep',
			type: 'module',
			exports: './index.js'
		}),
		'node_modules/dep/index.js': DEP,
		'lib.bench.ts': `import { bench } from ${JSON.stringify(BENCH_API)};
import * as lib from './lib.ts';
bench('parse', ({ text }) => lib.parse(text), { setup: () => ({ text: ${JSON.stringify(TEXT)} }) });
bench('big', () => lib.big());
bench('through', () => lib.through());
`
	});
}

test('real bytes: a case that allocates a lot is sampled at a coarser interval, not crashed', async () => {
	const dir = temp_dir('abax-big-');
	files(dir);
	const r = await run_child<Array<CaseResult<BytesResult>>>({
		kind: 'bytes',
		roots: [dir],
		files: [['lib.bench.ts']],
		filter: 'big',
		options: { warm: 2, runs: 20, batch: 10 }
	});
	const big = r.find((c) => c.name === 'big')!;
	assert.equal(big.error, null, String(big.error));
	const res = big.result!;
	// 10 M elements (4 or 8 B each, by elements kind) plus the array: tens of MB a call
	const f = res.functions.find((x) => x.id === 'lib.ts > big');
	assert.ok(f && f.bytes > 30e6 && f.bytes < 120e6, `big: ${f?.bytes} B per call`);
	assert.ok(res.interval! > 32, `interval ${res.interval}`);
	assert.ok((f.bytes * 10) / res.interval! <= MAX_SAMPLES * 2);
});

test('estimated and real bytes are both per call, over the same code', async () => {
	const dir = temp_dir('abax-scope-');
	files(dir);
	const report = await run_benches({ files: [`${dir}/lib.bench.ts`], root: dir, sha: null });
	const real = await run_child<Array<CaseResult<BytesResult>>>({
		kind: 'bytes',
		roots: [dir],
		files: [['lib.bench.ts']],
		filter: 'parse',
		options: { warm: 300, runs: 300, batch: 50 }
	});
	const parse_case = report.cases.find((c) => c.name === 'parse')!;
	const est = parse_case.functions.find((f) => f.path === 'parse')!;
	// what split, slice and trim return is in the estimate, on their lines
	const built_in_bytes = est.builtins.reduce((s, b) => s + (b.bytes ?? 0), 0);
	assert.ok(built_in_bytes > 200 * 3 * 20, `built-in results: ${built_in_bytes} B`);
	const measured = compare_bytes(parse_case, real.find((c) => c.name === 'parse')!.result!);
	const m = measured.functions.find((f) => f.id === 'lib.ts > parse')!;
	const ratio = m.real / m.estimated;
	// the same scale (before: 15x and more), and not flagged as elided
	assert.ok(ratio > 0.4 && ratio < 2.5, `parse: estimated ${m.estimated} B, real ${m.real} B`);
	assert.equal(m.elided, false);

	// a dependency's allocations are its own on both sides
	const through_real = await run_child<Array<CaseResult<BytesResult>>>({
		kind: 'bytes',
		roots: [dir],
		files: [['lib.bench.ts']],
		filter: 'through',
		options: { warm: 300, runs: 300, batch: 50 }
	});
	const t = through_real.find((c) => c.name === 'through')!.result!;
	const caller = t.functions.find((f) => f.id === 'lib.ts > through');
	assert.ok(
		!caller || caller.bytes < 200,
		`through: ${caller?.bytes} B per call charged to the caller`
	);
	assert.ok(t.other > 1000 * 12, `the dependency's ${t.other} B per call are its own`);
});
