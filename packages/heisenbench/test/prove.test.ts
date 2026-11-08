import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { serialize } from 'node:v8';
import type { FunctionRecord, Sample } from '../src/coverage/recorder.ts';
import { deeper_than } from '../src/coverage/recorder.ts';
import { CandidateError, prove_candidate, target_of } from '../src/prove/index.ts';
import type { ProveOptions, ProveReport } from '../src/prove/index.ts';
import { first_difference } from '../src/prove/equal.ts';
import { fitting_factors } from '../src/prove/run.ts';
import { unsafe_reason } from '../src/prove/safety.ts';
import { SpliceError, splice } from '../src/prove/splice.ts';
import { unified_diff } from '../src/prove/diff.ts';
import { code_of, run_proposals } from '../src/prove/propose.ts';
import { prove_command } from '../src/prove/cli.ts';
import { canonical_function } from '../src/weight/weights.ts';
import type { ProposalRequest, Provider } from '../src/prove/propose.ts';
import { temp_dir, write_files } from './helpers.ts';

/*
 * `heisenbench prove`, planted: a quadratic function (count the pairs of equal numbers) and
 * candidates for it. The correct linear one is proven. Three that are wrong in one small way each
 * (on a value seen three times, on -0 next to 0, by sorting the caller's array) are rejected with
 * the smallest input they differ on. A correct but slower one is rejected on its steps. The inputs
 * are recorded samples, as a test run's recorder keeps them; every value appears twice in them,
 * so the recorded inputs alone never reach the mistakes on a third copy or on -0: the edge cases
 * do (and the grown inputs, for the third copy). The one that sorts its argument differs on every
 * unsorted input, in the argument only.
 */

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

const LIB = `/** How many pairs of equal numbers: every pair compared. */
export function equal_pairs(xs: number[]): number {
	let n = 0;
	for (let i = 0; i < xs.length; i++) {
		for (let j = i + 1; j < xs.length; j++) if (xs[i] === xs[j]) n++;
	}
	return n;
}

export function unrelated(): number {
	return 1;
}
`;

/** Linear and the same: NaN equals nothing, -0 equals 0, as with ===. */
const LINEAR = `export function equal_pairs(xs: number[]): number {
	const seen = new Map<number, number>();
	let n = 0;
	for (const x of xs) {
		if (x !== x) continue;
		const c = seen.get(x) ?? 0;
		n += c;
		seen.set(x, c + 1);
	}
	return n;
}
`;

/** Wrong on a value seen three times or more: counts c - 1 pairs instead of c (c - 1) / 2. */
const WRONG_ON_DUPLICATES = `export function equal_pairs(xs: number[]): number {
	const seen = new Set<number>();
	let n = 0;
	for (const x of xs) {
		if (x !== x) continue;
		if (seen.has(x)) n++;
		seen.add(x);
	}
	return n;
}
`;

/** Wrong on -0 next to 0: keys by Object.is, which tells them apart (=== does not). */
const WRONG_ON_NEGATIVE_ZERO = `function key_of(x: number): string {
	return Object.is(x, -0) ? '-0' : String(x);
}

export function equal_pairs(xs: number[]): number {
	const seen = new Map<string, number>();
	let n = 0;
	for (const x of xs) {
		if (x !== x) continue;
		const k = key_of(x);
		const c = seen.get(k) ?? 0;
		n += c;
		seen.set(k, c + 1);
	}
	return n;
}
`;

/** Right count, n log n, but it sorts the caller's array. */
const MUTATES = `export function equal_pairs(xs: number[]): number {
	xs.sort((a, b) => a - b);
	let n = 0;
	let run = 1;
	for (let i = 1; i <= xs.length; i++) {
		if (i < xs.length && xs[i] === xs[i - 1]) run++;
		else {
			n += (run * (run - 1)) / 2;
			run = 1;
		}
	}
	return n;
}
`;

/** Right, and slower: every pair compared twice. */
const SLOWER = `export function equal_pairs(xs: number[]): number {
	let n = 0;
	for (let i = 0; i < xs.length; i++) {
		for (let j = 0; j < xs.length; j++) if (i !== j && xs[i] === xs[j]) n++;
	}
	return n / 2;
}
`;

/** The same pairs, the same curve, fewer reads: cheaper on every input. */
const HOISTED = `export function equal_pairs(xs: number[]): number {
	let n = 0;
	const len = xs.length;
	for (let i = 0; i < len; i++) {
		const x = xs[i];
		for (let j = i + 1; j < len; j++) if (x === xs[j]) n++;
	}
	return n;
}
`;

function samples(): Sample[] {
	// every value twice; 0 among them
	return [4, 6, 10, 16, 24, 40].map((n) => {
		const xs = Array.from({ length: n }, (_, i) => (i * 7) % (n / 2));
		return { args: [xs], this_value: undefined, sizes: [n * 2] };
	});
}

function setup(): { dir: string; o: ProveOptions } {
	const dir = temp_dir('heisenbench-prove-');
	write_files(dir, { 'lib.ts': LIB });
	return {
		dir,
		o: { root: dir, module: join(dir, 'lib.ts'), fn: 'equal_pairs', sizes: [1, 10, 100] }
	};
}

async function prove(source: string): Promise<ProveReport> {
	const { o } = setup();
	const t = target_of(o.root, o.module, o.fn);
	return prove_candidate(o, t, samples(), source, 'candidate.ts');
}

test('prove: a correct linear candidate that costs more on the smallest inputs is proven at scale, not proven', async () => {
	const r = await prove(LINEAR);
	assert.equal(r.verdict.kind, 'proven at scale', r.verdict.reason);
	assert.equal(r.verdict.proven, false);
	// the Map costs more than the double loop on 2 to 5 numbers; the headline says how much and where
	assert.match(
		r.headline,
		/^proven at scale: n\^2\.\d\d -> n\^1\.\d\d, [\d.e]+ -> [\d,]+ steps at 100x, identical on [\d,]+ inputs; costs \+\d+% \(91 -> [\d,]+ steps\) on \d of the recorded inputs \(sizes 8\.\.\d+\), cheaper from 1x up on the steepest grown input \(from size 80\)$/
	);
	const s = r.verdict.steps.at_scale!;
	assert.equal(s.recorded, s.inputs);
	assert.equal(s.worst.label, 'recorded #1');
	assert.equal(s.within_setup_tolerance, false);
	const g = r.verdict.growth!;
	assert.equal(g.original.class, 'quadratic');
	assert.equal(g.candidate!.class, 'linear');
	assert.equal(r.verdict.inputs.differing, 0);
	assert.ok(r.verdict.inputs.by_kind.edge > 100, `edge cases: ${r.verdict.inputs.by_kind.edge}`);
	assert.equal(r.verdict.inputs.by_kind.recorded, 6);
	// the three largest recorded inputs, each at 10x and 100x
	assert.equal(r.verdict.inputs.by_kind.grown, 6);
	assert.ok(g.rows[2].candidate!.steps < g.rows[2].original!.steps / 10);
	// the patch replaces equal_pairs and leaves the rest of the module alone
	assert.deepEqual(r.replaced, ['equal_pairs']);
	assert.match(r.diff, /^--- a\/lib\.ts\n\+\+\+ b\/lib\.ts\n@@ /);
	assert.ok(!r.diff.includes('unrelated'));
});

test('prove: a candidate cheaper on every input is proven', async () => {
	const r = await prove(HOISTED);
	assert.equal(r.verdict.kind, 'proven', r.verdict.reason);
	assert.equal(r.verdict.proven, true);
	assert.equal(r.verdict.steps.regressed, 0);
	assert.equal(r.verdict.steps.at_scale, null);
	assert.match(r.headline, /^proven: n\^2\.\d\d -> n\^2\.\d\d, .* identical on [\d,]+ inputs$/);
});

test('prove: --setup-tolerance is an opt-in that turns proven at scale into proven', async () => {
	const { o } = setup();
	const t = target_of(o.root, o.module, o.fn);
	const tight = await prove_candidate({ ...o, setup_tolerance: 0.5 }, t, samples(), LINEAR, 'c');
	// +326% on the smallest input is past 50%: still at scale
	assert.equal(tight.verdict.kind, 'proven at scale');
	const loose = await prove_candidate({ ...o, setup_tolerance: 4 }, t, samples(), LINEAR, 'c');
	assert.equal(loose.verdict.kind, 'proven');
	assert.equal(loose.verdict.steps.at_scale!.within_setup_tolerance, true);
	assert.match(loose.headline, /^proven within the setup tolerance: .*; costs \+\d+% /);
});

test('prove --weights: the sizes app traffic calls the function at, read from its steps a call', async () => {
	const { dir, o } = setup();
	const t = target_of(o.root, o.module, o.fn);
	const id = canonical_function('lib.ts', 'equal_pairs');
	// one scenario calls it twice a request at the cost of the 16-number input (size 32), one not at all
	const weights = {
		schema: 'heisenbench-app-weights/1',
		source: { sha: null, ogygia: {}, scenarios: ['docs', 'shop'] },
		units: {
			'docs server request': { steps: 1e5, units: 1, side: 'server' },
			'shop server request': { steps: 1e5, units: 1, side: 'server' }
		},
		functions: {
			[id]: { 'docs server request': { calls: 2, self_steps: 2 * 1117, inclusive_steps: 2 * 1117 } }
		}
	};
	writeFileSync(join(dir, 'w.json'), JSON.stringify(weights));
	const r = await prove_candidate(
		{ ...o, weights: join(dir, 'w.json') },
		t,
		samples(),
		LINEAR,
		'c'
	);
	const tr = r.verdict.traffic!;
	assert.equal(tr.of, 2);
	assert.deepEqual(
		tr.units.map((u) => [u.unit, u.calls, u.steps_per_call, u.size]),
		[['docs server request', 2, 1117, 32]]
	);
	assert.match(
		r.headline,
		/; app traffic \(docs server request\): size ~32, where the candidate costs \d\.\d\dx the original's steps$/
	);
	const none = { ...weights, functions: {} };
	writeFileSync(join(dir, 'none.json'), JSON.stringify(none));
	const n = await prove_candidate(
		{ ...o, weights: join(dir, 'none.json') },
		t,
		samples(),
		LINEAR,
		'c'
	);
	assert.match(n.headline, /; app traffic: not called in the 2 app scenarios$/);
});

test('prove: a candidate wrong only on a value seen three times is rejected with the minimal input', async () => {
	const r = await prove(WRONG_ON_DUPLICATES);
	assert.equal(r.verdict.proven, false);
	assert.match(r.verdict.reason, /^rejected: behaves differently/);
	const m = r.verdict.minimal!;
	// shrunk to one value three times (size: 3 elements and 3 numbers)
	assert.equal(m.size, 6, m.input);
	assert.match(m.input, /^\[ \[ (\d+), \1, \1 \] \]$/);
	assert.match(m.difference, /^out: 3 vs 2$/);
});

test('prove: a candidate that tells -0 from 0 is rejected on -0 next to 0', async () => {
	const r = await prove(WRONG_ON_NEGATIVE_ZERO);
	assert.equal(r.verdict.proven, false);
	const m = r.verdict.minimal!;
	assert.match(m.input, /^\[ \[ (-0, 0|0, -0) \] \]$/, m.input);
	assert.equal(m.difference, 'out: 1 vs 0');
	assert.deepEqual(r.added, ['key_of']);
});

test('prove: a candidate that changes its argument is rejected, though its result is right', async () => {
	const r = await prove(MUTATES);
	assert.equal(r.verdict.proven, false);
	const m = r.verdict.minimal!;
	assert.match(m.difference, /^args after the call\[0\]\[0\]: (\d+) vs (?!\1)\d+$/);
	// two numbers out of order: the smallest input sorting changes
	assert.match(m.input, /^\[ \[ (\d+), (\d+) \] \]$/);
	assert.equal(m.size, 4, m.input);
	// on the recorded inputs its results are right: only the argument tells
	for (const i of r.child.inputs)
		if (i.kind === 'recorded') assert.match(i.difference ?? '', /^args after the call/);
});

test('prove: a correct but slower candidate is rejected on its steps', async () => {
	const r = await prove(SLOWER);
	assert.equal(r.verdict.inputs.differing, 0);
	assert.equal(r.verdict.kind, 'rejected');
	assert.match(
		r.verdict.reason,
		/^rejected: costs more steps on \d+ input\(s\) \(more than 5% \+ 256 steps\), and is not cheaper at scale$/
	);
	assert.ok(r.verdict.steps.regressed >= 6);
	assert.equal(r.verdict.steps.at_scale, null);
});

test('prove: candidate code that reaches outside the runtime is refused before it runs', () => {
	const refused = [
		['process.env.X', 'it names `process`'],
		["require('node:fs')", 'it names `require`'],
		["import('node:fs')", 'it has a dynamic import()'],
		["fetch('http://x')", 'it names `fetch`'],
		['globalThis', 'it names `globalThis`'],
		['globalThis.process.env', 'it names `globalThis.process`'],
		['(globalThis as any)[name]', 'it names `globalThis` with a computed key'],
		["(() => 0).constructor('return 1')", 'it uses the property `constructor`'],
		['this.constructor.constructor', 'it uses the property `constructor`'],
		["({})['constructor']", 'a string in it names `constructor` as a key'],
		["Reflect.get({}, '__proto__')", 'a string in it names `__proto__` as a key'],
		["eval('1')", 'it names `eval`'],
		['import.meta.url', 'it has import.meta or new.target']
	];
	for (const [expr, why] of refused) {
		const src = `export function f(name: string): unknown {\n\treturn ${expr};\n}\n`;
		assert.equal(unsafe_reason('a.ts', src), why, expr);
	}
	// scope-aware: a local named like a global is the candidate's own; the global itself is not
	const local = `export function count(rows: number[]): number {
	const frames = rows.length;
	let self = 0;
	for (const process of rows) self += process;
	return frames + self;
}
`;
	assert.equal(unsafe_reason('a.ts', local), null);
	assert.equal(
		unsafe_reason('a.ts', `function frames() { return 1; }\nexport const n = frames();\n`),
		null
	);
	assert.equal(
		unsafe_reason(
			'a.ts',
			`export function f(): number {\n\t{ const process = 1; }\n\treturn process.exitCode;\n}\n`
		),
		'it names `process`',
		'a local of another block does not reach this reference'
	);
	// what a class reaches through its own names: a global object's harmless property, its
	// own constructor, `typeof` of a global, and a string that only guards a key
	const cls = `export class Core {
	tt(): unknown {
		return (globalThis as unknown as { trustedTypes?: unknown }).trustedTypes;
	}
	again(): Core {
		const Ctor = this.constructor as new () => Core;
		return new Ctor();
	}
	browser(): boolean {
		return typeof window !== 'undefined';
	}
	safe(k: string): boolean {
		return k === '__proto__' || k === 'constructor' || k === 'prototype';
	}
}
`;
	assert.equal(unsafe_reason('a.ts', cls), null);
	// a property is not the global of that name; types never run
	assert.equal(
		unsafe_reason(
			'a.ts',
			'export function f(x: { self: number; process: Function }): number {\n\treturn x.self + ({ module: 1 }).module;\n}\n'
		),
		null
	);
	assert.equal(
		unsafe_reason('a.ts', 'import { a } from "./a.ts";\nexport const b = a;\n'),
		'it has an import'
	);
});

test('prove: an unsafe candidate is refused, and the sandbox holds what the check cannot see', async () => {
	const { dir, o } = setup();
	const t = target_of(o.root, o.module, o.fn);
	await assert.rejects(
		prove_candidate(
			o,
			t,
			samples(),
			LINEAR.replace('let n = 0;', 'let n = process.exitCode ?? 0;'),
			'c'
		),
		(e: unknown) => e instanceof CandidateError && /refused: it names `process`/.test(e.message)
	);
	// a name built at run time passes the check; the child's permissions stop the write
	const marker = join(dir, 'escaped.txt');
	const sneaky = LINEAR.replace(
		'let n = 0;',
		`const k = 'con' + 'struc' + 'tor';
	const F = (() => 0)[k] as (s: string) => () => { getBuiltinModule(m: string): { writeFileSync(p: string, s: string): void } };
	F('return pro' + 'cess')().getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');
	let n = 0;`
	);
	assert.equal(unsafe_reason('lib.ts', sneaky), null);
	const r = await prove_candidate(o, t, samples(), sneaky, 'sneaky');
	assert.equal(existsSync(marker), false);
	assert.equal(r.verdict.proven, false);
	assert.match(
		r.verdict.minimal!.difference,
		/candidate threw Error: Access to this API has been restricted/
	);
});

test('prove: splicing replaces declarations by name and adds new ones before the target', () => {
	const s = splice('lib.ts', LIB, WRONG_ON_NEGATIVE_ZERO, 'equal_pairs');
	assert.deepEqual(s.replaced, ['equal_pairs']);
	assert.deepEqual(s.added, ['key_of']);
	assert.ok(s.source.indexOf('function key_of') < s.source.indexOf('export function equal_pairs'));
	assert.ok(s.source.includes('export function unrelated'));
	assert.throws(
		() => splice('lib.ts', LIB, `import { x } from './x.ts';\n${LINEAR}`, 'equal_pairs'),
		SpliceError
	);
	assert.throws(() => splice('lib.ts', LIB, LIB, 'equal_pairs'), /the same as the original/);
	assert.throws(
		() => splice('lib.ts', LIB, 'export function other() {}\n', 'equal_pairs'),
		/does not declare equal_pairs/
	);
	const d = unified_diff('lib.ts', LIB, s.source);
	assert.match(d, /\n\+function key_of\(x: number\): string \{\n/);
	assert.match(d, /\n-\tfor \(let i = 0; i < xs\.length; i\+\+\) \{\n/);
});

test('prove: same behavior is told value by value', () => {
	assert.equal(first_difference(NaN, NaN), null);
	assert.equal(first_difference(0, -0), 'out: 0 vs -0');
	assert.equal(first_difference({ a: undefined }, {}), 'out.a: present vs missing');
	assert.equal(
		first_difference({ a: 1, b: 2 }, { b: 2, a: 1 }),
		'out: keys in another order (a, b vs b, a)'
	);
	assert.equal(
		first_difference(
			new Map([
				[1, 'a'],
				[2, 'b']
			]),
			new Map([
				[2, 'b'],
				[1, 'a']
			])
		),
		'out key 0: 1 vs 2'
	);
	assert.equal(first_difference(new Set([1]), new Set([1])), null);
	assert.equal(
		first_difference(new Uint8Array([1, 2]), new Uint8Array([1, 3])),
		'out: byte 1 is 2 vs 3'
	);
	assert.equal(
		first_difference(new Uint8Array([1]), new Int8Array([1])),
		'out: Uint8Array vs Int8Array'
	);
	assert.equal(first_difference(new Date(5), new Date(5)), null);
	const holey = [1, 2, 3];
	delete holey[1];
	assert.equal(first_difference(holey, [1, undefined, 3]), 'out[1]: a hole vs a value');
	assert.equal(
		first_difference(new TypeError('x'), new RangeError('x')),
		'out: TypeError vs RangeError'
	);
	class A {
		v = 1;
	}
	class B {
		v = 1;
	}
	// two modules make their own classes: the name is what is compared
	assert.equal(
		first_difference(
			new A(),
			new (class A {
				v = 1;
			})()
		),
		null
	);
	assert.equal(first_difference(new A(), new B()), 'out: A vs B');
});

/** A provider that hands out fixed candidates, in turn, and keeps what it was asked. */
function stub(candidates: string[]): Provider & { asked: ProposalRequest[] } {
	const asked: ProposalRequest[] = [];
	let n = 0;
	return {
		name: 'stub',
		asked,
		async propose(req) {
			asked.push(structuredClone(req));
			return code_of('Here it is:\n```ts\n' + candidates[n++] + '```\n');
		}
	};
}

test('prove --propose: every proposal is proven like a hand-written one; only proven ones are kept', async () => {
	const { o } = setup();
	const t = target_of(o.root, o.module, o.fn);
	const p = stub([
		WRONG_ON_DUPLICATES,
		LINEAR.replace('let n = 0;', 'let n = globalThis.process.exitCode ?? 0;'),
		HOISTED
	]);
	const out = await run_proposals(o, t, samples(), p, { count: 3, send_inputs: false });
	assert.match(out[0].outcome, /^rejected: behaves differently on \d+ of \d+ inputs$/);
	assert.equal(out[1].outcome, 'the candidate is refused: it names `globalThis.process`');
	assert.equal(out[1].report, null);
	assert.equal(out[2].outcome, 'proven');
	assert.equal(out[2].report!.verdict.proven, true);
	// what was sent: the source, the blame and the growth; no recorded input without --send-inputs
	const first = p.asked[0];
	assert.match(
		first.source,
		/^\/\*\* How many pairs of equal numbers: every pair compared\. \*\/\nexport function equal_pairs/
	);
	assert.match(first.growth, /^n\^2\.\d\d in argument 0 \(array size\)/);
	assert.ok(first.blame.length > 0);
	assert.ok(first.blame.some((b) => b.text.includes('xs[i] === xs[j]')));
	assert.deepEqual(first.inputs, []);
	// each proposal sees why the ones before it were not proven
	assert.equal(p.asked[2].tried.length, 2);
	assert.match(p.asked[2].tried[0].outcome, /out: \d+ vs \d+$/);
	assert.ok(!JSON.stringify(p.asked).includes('[ [ '), 'no input text without --send-inputs');
	const sent = stub([LINEAR]);
	await run_proposals(o, t, samples(), sent, { count: 1, send_inputs: true });
	assert.equal(sent.asked[0].inputs.length, 3);
});

function write_records(dir: string): void {
	const rec: FunctionRecord = {
		id: 'lib.ts > equal_pairs',
		calls: 6,
		uncloneable: 0,
		inconsistent: 0,
		samples: samples()
	};
	mkdirSync(join(dir, 'records'), { recursive: true });
	writeFileSync(join(dir, 'records', 'run-1.bin'), serialize([rec]));
}

test('heisenbench prove: the CLI proves from a records directory and writes JSON and markdown', async () => {
	const { dir } = setup();
	write_records(dir);
	write_files(dir, { 'linear.ts': LINEAR, 'hoisted.ts': HOISTED, 'wrong.ts': WRONG_ON_DUPLICATES });
	const prove_args = (file: string) => [
		CLI,
		'prove',
		'lib.ts',
		'equal_pairs',
		'--candidate',
		file,
		'--records',
		'records',
		'--md',
		'prove.md'
	];
	const ok = await run(process.execPath, prove_args('hoisted.ts'), { cwd: dir });
	assert.match(
		ok.stdout,
		/^prove {4}lib\.ts > equal_pairs: 6 recorded inputs \(of 6 recorded calls\)\nPROVEN {3}lib\.ts > equal_pairs {2}proven: n\^2/
	);
	const json = JSON.parse(readFileSync(join(dir, 'heisenbench-prove.json'), 'utf8')) as ProveReport;
	assert.equal(json.schema, 'heisenbench-prove/1');
	assert.equal(json.verdict.kind, 'proven');
	const md = readFileSync(join(dir, 'prove.md'), 'utf8');
	assert.match(md, /^#### Proof: `lib\.ts > equal_pairs`\n\n\*\*proven: /);
	assert.match(md, /```diff\n--- a\/lib\.ts\n/);
	// proven at scale: its own label, the headline says where it costs more, exit 3
	await assert.rejects(
		run(process.execPath, prove_args('linear.ts'), { cwd: dir }),
		(e: { code: number; stdout: string }) =>
			e.code === 3 &&
			/\nAT SCALE lib\.ts > equal_pairs {2}proven at scale: n\^2\.\d\d -> n\^1\.\d\d, .*; costs \+\d+% \(91 -> \d+ steps\) on \d of the recorded inputs/.test(
				e.stdout
			)
	);
	assert.match(
		readFileSync(join(dir, 'prove.md'), 'utf8'),
		/\nIt costs \+\d+% \(91 -> \d+ steps\) on /
	);
	await assert.rejects(
		run(
			process.execPath,
			[CLI, 'prove', 'lib.ts', 'equal_pairs', '--candidate', 'wrong.ts', '--records', 'records'],
			{ cwd: dir }
		),
		(e: { code: number; stdout: string }) =>
			e.code === 1 &&
			/^REJECTED /m.test(e.stdout) &&
			/differs on: \[ \[ \d+, \d+, \d+ \] \]/.test(e.stdout)
	);
	await assert.rejects(
		run(process.execPath, [CLI, 'prove', 'lib.ts', 'equal_pairs', '--records', 'records'], {
			cwd: dir
		}),
		(e: { code: number; stderr: string }) =>
			e.code === 2 && /give a candidate \(--candidate <file>\) or --propose/.test(e.stderr)
	);
});

test('heisenbench prove --propose: with a provider, the command reports only the proven proposals, each with its diff', async () => {
	const { dir } = setup();
	write_records(dir);
	const out = join(dir, 'proposals.json');
	const md = join(dir, 'proposals.md');
	const flags = new Map([
		['propose', ''],
		['records', join(dir, 'records')],
		['root', dir],
		['proposals', '3'],
		['out', out],
		['md', md]
	]);
	const log = console.log;
	console.log = () => {};
	const run_with = async (cands: string[]): Promise<number> => {
		console.log = () => {};
		try {
			return await prove_command([join(dir, 'lib.ts'), 'equal_pairs'], flags, stub(cands));
		} finally {
			console.log = log;
		}
	};
	const code = await run_with([MUTATES, LINEAR, HOISTED]);
	assert.equal(code, 0);
	const r = JSON.parse(readFileSync(out, 'utf8')) as {
		proposals: Array<{ n: number; outcome: string }>;
		proven: ProveReport[];
	};
	assert.equal(r.proposals.length, 3);
	assert.match(r.proposals[0].outcome, /^rejected: behaves differently/);
	assert.match(r.proposals[1].outcome, /^proven at scale: /);
	assert.equal(r.proposals[2].outcome, 'proven');
	// both kept, the proven one first, each under its own verdict
	assert.deepEqual(
		r.proven.map((x) => [x.candidate, x.verdict.kind]),
		[
			['stub proposal 3', 'proven'],
			['stub proposal 2', 'proven at scale']
		]
	);
	assert.match(
		readFileSync(md, 'utf8'),
		/^#### Proof: `lib\.ts > equal_pairs`\n\n\*\*proven: [\s\S]*```diff\n--- a\/lib\.ts[\s\S]*\*\*proven at scale: /
	);
	// only proven at scale: exit 3
	flags.set('proposals', '2');
	assert.equal(await run_with([MUTATES, LINEAR]), 3);
});

test('heisenbench prove --propose: without a key it says how to set one and does nothing else', async () => {
	const { dir } = setup();
	write_records(dir);
	const env = { ...process.env };
	delete env.ANTHROPIC_API_KEY;
	delete env.ANTHROPIC_AUTH_TOKEN;
	await assert.rejects(
		run(
			process.execPath,
			[CLI, 'prove', 'lib.ts', 'equal_pairs', '--propose', '--records', 'records'],
			{ cwd: dir, env }
		),
		(e: { code: number; stderr: string; stdout: string }) =>
			e.code === 1 &&
			e.stdout === '' &&
			e.stderr.includes('export ANTHROPIC_API_KEY=') &&
			e.stderr.includes('Nothing was sent and nothing was run.')
	);
	assert.equal(existsSync(join(dir, 'heisenbench-prove.json')), false);
});

test('heisenbench prove: a class method, recorded from a bench, with its receiver rebuilt on the class', async () => {
	const dir = temp_dir('heisenbench-prove-');
	const bench_api = JSON.stringify(fileURLToPath(new URL('../src/bench.ts', import.meta.url)));
	const cls = (body: string) => `export class Index {
	words: string[];
	constructor(words: string[]) {
		this.words = words;
	}
	key(w: string): string {
		return w.toLowerCase();
	}
	/** How many words appear more than once, by key. */
	repeated(): number {
${body}
	}
}
`;
	write_files(dir, {
		'package.json': '{ "type": "module" }',
		'src/index.ts': cls(`		let n = 0;
		for (let i = 0; i < this.words.length; i++) {
			for (let j = 0; j < i; j++) {
				if (this.key(this.words[i]) === this.key(this.words[j])) {
					n++;
					break;
				}
			}
		}
		return n;`),
		'fast.ts': cls(`		const seen = new Set<string>();
		let n = 0;
		for (const w of this.words) {
			const k = this.key(w);
			if (seen.has(k)) n++;
			else seen.add(k);
		}
		return n;`),
		'wrong.ts': cls(`		return new Set(this.words).size === this.words.length ? 0 : 1;`),
		'index.bench.ts': `import { bench } from ${bench_api};
import { Index } from './src/index.ts';
const words = (n: number) => Array.from({ length: n }, (_, i) => (i % 3 === 0 ? 'A' : 'a') + (i % 7));
bench('repeated', ({ ix }) => ix.repeated(), { setup: () => ({ ix: new Index(words(24)) }) });
`
	});
	const prove_args = (file: string) => [
		CLI,
		'prove',
		'src/index.ts',
		'Index > repeated',
		'--candidate',
		file,
		'--bench',
		'index.bench.ts',
		'--out',
		'p.json'
	];
	const ok = await run(process.execPath, prove_args('fast.ts'), { cwd: dir }).catch(
		(e: { code: number; stdout: string; stderr: string }) => e
	);
	const report = JSON.parse(readFileSync(join(dir, 'p.json'), 'utf8')) as ProveReport;
	assert.equal(report.function, 'src/index.ts > Index > repeated', JSON.stringify(ok));
	assert.ok(report.verdict.inputs.by_kind.recorded > 0, 'the bench case recorded calls');
	// the receiver has the class's methods: `this.key` runs, nothing throws on either side
	assert.ok(report.child.inputs.every((i) => i.original.threw === null && !i.candidate?.threw));
	assert.equal(report.verdict.inputs.differing, 0, report.verdict.reason);
	assert.ok(['proven', 'proven at scale'].includes(report.verdict.kind), report.verdict.reason);
	assert.deepEqual(report.replaced, ['Index']);
	await assert.rejects(
		run(process.execPath, prove_args('wrong.ts'), { cwd: dir }),
		(e: { code: number; stdout: string }) => e.code === 1 && /^REJECTED /m.test(e.stdout)
	);
	// the nested functions of a method are still not a target
	assert.throws(
		() => target_of(dir, join(dir, 'src/index.ts'), 'Index > repeated > map:0'),
		/is nested/
	);
});

test('heisenbench prove: an async function, recorded from a bench, compared on what it settles to', async () => {
	const dir = temp_dir('heisenbench-prove-');
	const bench_api = JSON.stringify(fileURLToPath(new URL('../src/bench.ts', import.meta.url)));
	write_files(dir, {
		'package.json': '{ "type": "module" }',
		'src/load.ts': `export async function distinct(ids: number[]): Promise<number[]> {
	await null;
	const out: number[] = [];
	for (const id of ids) if (!out.includes(id)) out.push(id);
	return out;
}
`,
		'fast.ts': `export async function distinct(ids: number[]): Promise<number[]> {
	await null;
	const seen = new Set<number>();
	const out: number[] = [];
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}
`,
		'wrong.ts': `export async function distinct(ids: number[]): Promise<number[]> {
	await null;
	return [...new Set(ids)].sort((a, b) => a - b);
}
`,
		'load.bench.ts': `import { bench } from ${bench_api};
import { distinct } from './src/load.ts';
const ids = (n: number) => Array.from({ length: n }, (_, i) => (i * 7) % 11);
bench('distinct', ({ xs }) => distinct(xs), { setup: () => ({ xs: ids(40) }) });
`
	});
	const prove_args = (file: string) => [
		CLI,
		'prove',
		'src/load.ts',
		'distinct',
		'--candidate',
		file,
		'--bench',
		'load.bench.ts',
		'--out',
		'p.json'
	];
	await run(process.execPath, prove_args('fast.ts'), { cwd: dir }).catch(() => null);
	const report = JSON.parse(readFileSync(join(dir, 'p.json'), 'utf8')) as ProveReport;
	assert.ok(report.verdict.inputs.by_kind.recorded > 0, report.verdict.reason);
	assert.equal(report.verdict.inputs.differing, 0, report.verdict.reason);
	await assert.rejects(
		run(process.execPath, prove_args('wrong.ts'), { cwd: dir }),
		(e: { code: number; stdout: string }) => e.code === 1 && /^REJECTED /m.test(e.stdout)
	);
});

test('heisenbench prove: a recording too deep to read back is kept out, the scales below it are proven', async () => {
	const dir = temp_dir('heisenbench-prove-');
	const bench_api = JSON.stringify(fileURLToPath(new URL('../src/bench.ts', import.meta.url)));
	const total = (body: string) => `export interface Link { v: number; next: Link | null }
export function total(l: Link | null): number {
${body}
}
`;
	write_files(dir, {
		'package.json': '{ "type": "module" }',
		'src/chain.ts': total('\tlet s = 0;\n\tfor (let x = l; x; x = x.next) s += x.v;\n\treturn s;'),
		'same.ts': total(
			'\tlet s = 0;\n\tfor (let x = l; x !== null; x = x.next) s += x.v;\n\treturn s;'
		),
		// a chain of 100 links grown to 1,000 and 10,000: both grown ones are past the cap (the
		// 1,000 links sit inside the arguments' array), and main crashed reading them back
		'chain.bench.ts': `import { bench } from ${bench_api};
import { total, type Link } from './src/chain.ts';
const chain = (n: number): Link | null => {
	let l: Link | null = null;
	for (let i = 0; i < n; i++) l = { v: i, next: l };
	return l;
};
bench('total', ({ l }) => total(l), {
	setup: () => ({ l: chain(100) }),
	scale: (_c, k) => ({ l: chain(100 * k) })
});
`
	});
	const r = await run(
		process.execPath,
		[
			CLI,
			'prove',
			'src/chain.ts',
			'total',
			'--candidate',
			'same.ts',
			'--bench',
			'chain.bench.ts',
			'--out',
			'p.json'
		],
		{ cwd: dir }
	).catch((e: { stdout: string; stderr: string; code: number }) => e);
	assert.match(
		r.stdout,
		/^prove {4}src\/chain\.ts > total: \d+ recorded inputs \(of 3 recorded calls; 2 nested deeper than 1000 levels, not kept/m,
		r.stderr
	);
	const report = JSON.parse(readFileSync(join(dir, 'p.json'), 'utf8')) as ProveReport;
	assert.equal(report.verdict.inputs.differing, 0);
	assert.equal(report.verdict.inputs.by_kind.recorded, 1);
	assert.ok(report.verdict.inputs.by_kind.grown > 0, 'the kept one is grown instead');
	assert.equal(deeper_than({ a: { b: { c: 1 } } }, 2), true);
	assert.equal(deeper_than({ a: { b: { c: 1 } } }, 3), false);
});

test('prove: a grown input past the size cap stops at the largest factor that fits, and says so', () => {
	assert.deepEqual(fitting_factors([1, 10, 100], 1_000), { sizes: [1, 10, 100], note: null });
	const cut = fitting_factors([1, 10, 100], 65_000, 4_000_000);
	assert.deepEqual(cut.sizes, [1, 10, 61]);
	assert.match(
		cut.note!,
		/^100x would hold 6,500,000 or more units of input, past the cap of 4,000,000; grown to 61x instead$/
	);
	// nothing fits but the input as it is: no growth at all
	assert.deepEqual(fitting_factors([1, 10, 100], 3_000_000, 4_000_000).sizes, [1]);
});
