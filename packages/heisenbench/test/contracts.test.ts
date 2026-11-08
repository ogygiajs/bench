import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { read_contracts } from '../src/contracts/declare.ts';
import type { CountedFunction } from '../src/contracts/declare.ts';
import { check_contracts, diff_contracts, render_contracts_diff } from '../src/contracts/index.ts';
import type { ContractReport } from '../src/contracts/index.ts';
import { gate, measurement_sources, render_gate, source_inventory } from '../src/coverage/gate.ts';
import { transform, ts_to_js } from '../src/transform/index.ts';
import { private_dts } from '../src/dts.ts';
import { load_prices } from '../src/prices.ts';
import type { GrowthReport } from '../src/growth/index.ts';
import type { RecordedGrowthReport } from '../src/growth/recorded.ts';
import type { Report } from '../src/report.ts';
import { temp_dir, write_files } from './helpers.ts';

/*
 * Complexity contracts: `@heisenbench <class> in <param>` on a function, read from its doc comment
 * and held against the growth layer's curves. Planted: a function declared linear that is
 * quadratic (broken, with its class, exponent, sizes and lines), one declared linear that is
 * (holds), one nothing measures (unmeasured, and a gate failure), and tags that declare nothing.
 */

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const BENCH = fileURLToPath(new URL('../src/bench.ts', import.meta.url));

/** The counted functions of a module, as the transform names them (type stripping keeps places). */
function counted(source: string, file = 'lib.ts'): CountedFunction[] {
	const code = file.endsWith('.ts') ? stripTypeScriptTypes(source) : source;
	return transform(code, { filename: `/x/${file}`, id: file, prices: load_prices() }).meta
		.functions;
}

function contracts_of(source: string, file = 'lib.ts') {
	return read_contracts(source, `/x/${file}`, file, counted(source, file));
}

test('a doc tag declares a contract on the function right after it', () => {
	const src = `/** Ranks rows.
 * @heisenbench linear in rows
 */
export function rank(rows, limit) { return rows.length + limit; }

/** @heisenbench n log n in xs */
export const sort_all = (xs) => [...xs].sort();

/** @heisenbench nlogn */
const plain = async function (a) { return a; };

class Table {
	/** @heisenbench quadratic in cells */
	static join(cells, sep = ',') { return cells.join(sep); }
	/** @heisenbench constant */
	size() { return 1; }
}

const api = {
	/** @heisenbench log in keys */
	find(keys) { return keys[0]; }
};

/** Mentions @heisenbench in passing, which is not a tag. */
export function mention(a) { return a; }
`;
	const { contracts, errors } = contracts_of(src, 'lib.js');
	assert.deepEqual(errors, []);
	assert.deepEqual(
		contracts.map((c) => [c.path, c.class, c.param, c.argument, c.line, c.tag_line]),
		[
			['rank', 'linear', 'rows', 0, 4, 2],
			['sort_all', 'n log n', 'xs', 0, 7, 6],
			['plain', 'n log n', null, null, 10, 9],
			['Table > static join', 'quadratic', 'cells', 0, 14, 13],
			['Table > size', 'constant', null, null, 16, 15],
			['api > find', 'log', 'keys', 0, 21, 20]
		]
	);
	assert.equal(contracts[0].id, 'lib.js > rank');
	assert.equal(contracts[0].text, 'linear in rows');
});

test('a tag on an overload signature binds to the implementation; TypeScript parameters by name', () => {
	const src = `/** @heisenbench linear in source */
export function scan(source: string): number[];
export function scan(source: string, spans: true): number[];
export function scan(source: string, spans = false): number[] {
	return spans ? [source.length] : [];
}

/** @heisenbench quadratic in b */
export function pair(this: void, a?: number, ...b: string[]): number {
	return b.length + (a ?? 0);
}
`;
	const { contracts, errors } = contracts_of(src);
	assert.deepEqual(errors, []);
	assert.deepEqual(
		contracts.map((c) => [c.path, c.line, c.argument]),
		[
			['scan', 4, 0],
			['pair', 9, 1]
		]
	);
});

test('a tag that declares nothing is an error, never ignored', () => {
	const src = `/** @heisenbench linearish in rows */
export function a(rows) { return rows; }

/** @heisenbench linear in nope */
export function b(rows) { return rows; }

/** @heisenbench linear */
export const not_a_function = 3;

/**
 * @heisenbench linear
 * @heisenbench quadratic
 */
export function c(x) { return x; }

/** @heisenbench exponential */
export function d(x) { return x; }
`;
	const { contracts, errors } = contracts_of(src, 'lib.js');
	assert.deepEqual(contracts, []);
	assert.deepEqual(
		errors.map((e) => [e.line, e.error.split(':')[0].split(' (')[0]]),
		[
			[12, 'one contract per function'],
			[1, 'not a contract'],
			[4, '`nope` is not a parameter of b'],
			[7, 'the tag is on no function'],
			[16, 'not a contract']
		]
	);
});

const LIB = `export interface Row {
	id: number;
	tags: string[];
}

/** Every row's rank among the rows before it.
 * @heisenbench linear in rows
 */
export function rank(rows: Row[]): number[] {
	const out: number[] = [];
	for (let i = 0; i < rows.length; i++) {
		let before = 0;
		for (let j = 0; j < i; j++) {
			if (rows[j].id < rows[i].id) before++;
		}
		out.push(before);
	}
	return out;
}

/** @heisenbench linear in rows */
export function total(rows: Row[]): number {
	let s = 0;
	for (const r of rows) s += r.tags.length;
	return s;
}

/** @heisenbench constant in xs */
export function unused(xs: number[]): number {
	return xs.length;
}
`;

const BENCHES = `import { bench } from '${BENCH}';
import { rank, total } from './lib.ts';

const rows = () => Array.from({ length: 20 }, (_, i) => ({ id: i, tags: ['a' + i, 'bb'] }));
bench('rank', ({ rows }) => rank(rows), { setup: () => ({ rows: rows() }) });
bench('total', ({ rows }) => total(rows), { setup: () => ({ rows: rows() }) });
`;

test('contracts on the CLI: a quadratic function declared linear is broken, with the evidence', async () => {
	const dir = temp_dir('heisenbench-contracts-');
	write_files(dir, { 'lib.ts': LIB, 'lib.bench.ts': BENCHES });
	const out = join(dir, 'r.json');
	await run(process.execPath, [CLI, 'growth', 'lib.bench.ts', '--root', dir, '--out', out], {
		cwd: dir
	});
	const grown = JSON.parse(readFileSync(out, 'utf8')) as Report;
	const curve = grown.growth!.cases.find((c) => c.name === 'rank')!.contracts!;
	assert.deepEqual(
		curve.map((c) => [c.id, c.class, c.calls]),
		[['lib.ts > rank', 'quadratic', [1, 1, 1]]],
		'the growth case keeps the contracted function a curve of its own'
	);
	const md = join(dir, 'c.md');
	const r = await run(
		process.execPath,
		[CLI, 'contracts', 'lib.ts', '--reports', out, '--root', dir, '--out', out, '--md', md],
		{ cwd: dir }
	).then(
		() => null,
		(e: { code: number; stdout: string }) => e
	);
	assert.equal(r?.code, 1, 'a broken contract fails the check');
	const check = (JSON.parse(readFileSync(out, 'utf8')) as Report).contracts!;
	const by = new Map(check.contracts.map((c) => [c.path, c]));
	assert.equal(by.get('rank')!.verdict, 'broken');
	assert.equal(by.get('total')!.verdict, 'holds');
	assert.equal(by.get('unused')!.verdict, 'unmeasured');
	const s = by.get('rank')!.sources[0];
	assert.equal(s.kind, 'growth');
	assert.equal(s.from, 'rank');
	assert.equal(s.class, 'quadratic');
	assert.ok(s.exponent > 1.9 && s.exponent < 2.1, `exponent ${s.exponent}`);
	assert.deepEqual(s.sizes, [1, 10, 100]);
	assert.ok(s.within < 0.01);
	// the inner loop's lines at 100x: the comparison and the loop head
	assert.deepEqual(
		s.lines.slice(0, 2).map((l) => l.at),
		['lib.ts:14', 'lib.ts:13']
	);
	const text = readFileSync(md, 'utf8');
	assert.match(text, /\*\*broken\*\*: `lib\.ts > rank` `@heisenbench linear in rows` is broken/);
	assert.match(text, /measured quadratic \(exponent 1\.99\d\)/);
	assert.match(text, /1x \/ 10x \/ 100x \(input sizes [\d,]+ \/ [\d,]+ \/ [\d,]+\)/);
	assert.match(text, /most steps on `lib\.ts:14`/);
	assert.match(text, /\*\*unmeasured\*\*: `lib\.ts > unused`/);
	assert.match(r!.stdout, /^holds {4}lib\.ts > total `@heisenbench linear in rows` holds/m);
});

test('the generated declarations of private functions carry their contracts', () => {
	const dir = temp_dir('heisenbench-contracts-dts-');
	write_files(dir, {
		'lib.ts': `/** Sums the rows.
 * @heisenbench linear in rows
 */
function total(rows: number[]): number {
	let s = 0;
	for (const r of rows) s += r;
	return s;
}
export const x = total([1]);
`
	});
	const dts = private_dts({ files: [join(dir, 'lib.ts')], out: join(dir, 'private.d.ts') });
	assert.match(
		dts,
		/\* @heisenbench linear in rows\n\t\t \*\/\n\t\texport function total\(rows: number\[\]\): number;/
	);
});

test('a contracted function with no measurement source fails the gate, exemption or not', () => {
	const dir = temp_dir('heisenbench-contracts-gate-');
	write_files(dir, { 'lib.ts': LIB });
	const inv = source_inventory(dir, [join(dir, 'lib.ts')]);
	assert.deepEqual(
		inv.contracts!.map((c) => c.id),
		['lib.ts > rank', 'lib.ts > total', 'lib.ts > unused']
	);
	const measured = measurement_sources(inv, new Set(['lib.ts > rank', 'lib.ts > total']));
	const ids = new Set(inv.functions.map((f) => f.id));
	const g = gate(measured, ids, [{ id: 'lib.ts > unused', reason: 'tiny' }], {
		contracts: inv.contracts
	});
	assert.equal(g.pass, false);
	assert.deepEqual(
		g.unmeasured_contracts!.map((f) => [f.id, f.contract]),
		[['lib.ts > unused', 'constant in xs']]
	);
	assert.match(render_gate(g), /1 function with a complexity contract and no measurement source/);
	assert.equal(gate(measured, ids, [{ id: 'lib.ts > unused', reason: 'tiny' }]).pass, true);
});

/** A recorded-growth report of one function over its argument sizes. */
function recorded(
	id: string,
	o: Partial<RecordedGrowthReport['functions'][number]>
): RecordedGrowthReport {
	return {
		schema: 'heisenbench-recorded-growth/1',
		functions: [
			{
				id,
				calls: 40,
				call_sizes: null,
				source: 'recorded',
				argument: 0,
				kind: 'array length',
				points: [
					{ size: 10, steps: 1000 },
					{ size: 100, steps: 10_000 },
					{ size: 1000, steps: 100_000 }
				],
				class: 'linear',
				power: 1,
				confident: true,
				superlinear: false,
				grows: false,
				...o
			}
		],
		skipped: {},
		steps_spent: 0
	};
}

const CONTRACT = {
	id: 'lib.ts > f',
	module: 'lib.ts',
	path: 'f',
	line: 2,
	tag_line: 1,
	class: 'linear' as const,
	param: 'items',
	argument: 1,
	text: 'linear in items'
};

test('recorded calls measure a contract over the argument it names', () => {
	const odds = (shape: 'linear' | 'quadratic', p: number) => ({
		odds: [
			{ shape, p },
			{ shape: shape === 'linear' ? ('quadratic' as const) : ('linear' as const), p: 1 - p }
		],
		superlinear: shape === 'quadratic' ? p : 1 - p,
		points: 6
	});
	// growth chose argument 1: its own curve decides
	const own = check_contracts(
		[CONTRACT],
		[],
		[{ recorded_growth: recorded(CONTRACT.id, { argument: 1, odds: odds('linear', 0.97) }) }]
	);
	assert.equal(own.contracts[0].verdict, 'holds');
	assert.equal(own.pass, true);
	// growth chose argument 0; argument 1's own fit is in `recorded`
	const other = check_contracts(
		[CONTRACT],
		[],
		[
			{
				recorded_growth: recorded(CONTRACT.id, {
					argument: 0,
					recorded: [
						{
							argument: 1,
							class: 'quadratic',
							power: 2,
							r2: 0.99,
							reason: null,
							odds: odds('quadratic', 0.95),
							top_steps: 50_000
						}
					]
				})
			}
		]
	);
	assert.equal(other.contracts[0].verdict, 'broken');
	assert.equal(other.contracts[0].sources[0].from, 'recorded calls, argument 1 (`items`)');
	// a few steps that grow say nothing about real sizes: unsure, not broken
	const tiny = check_contracts(
		[CONTRACT],
		[],
		[
			{
				recorded_growth: recorded(CONTRACT.id, {
					argument: 0,
					recorded: [
						{
							argument: 1,
							class: 'quadratic',
							power: 2,
							r2: 0.99,
							reason: null,
							odds: odds('quadratic', 0.95),
							top_steps: 80
						}
					]
				})
			}
		]
	);
	assert.equal(tiny.contracts[0].verdict, 'unsure');
	assert.equal(tiny.pass, false);
	// argument 1's sizes span too little: nothing measured it
	const narrow = check_contracts(
		[CONTRACT],
		[],
		[
			{
				recorded_growth: recorded(CONTRACT.id, {
					argument: 0,
					recorded: [{ argument: 1, class: null, power: 0, r2: 0, reason: 'sizes span too little' }]
				})
			}
		]
	);
	assert.equal(narrow.contracts[0].verdict, 'unmeasured');
	assert.match(narrow.contracts[0].sources[0].why!, /sizes span too little/);
});

test('one source that breaks a contract breaks it; a close call is not a pass', () => {
	const growth = (
		shape: 'linear' | 'n log n',
		p: number,
		rest: 'n log n' | 'quadratic'
	): GrowthReport => ({
		schema: 'heisenbench-growth/1',
		sizes: [1, 10, 100],
		cases: [
			{
				name: 'case',
				file: 'lib.bench.ts',
				sizes: [1, 10, 100],
				input_sizes: [10, 100, 1000],
				steps: [100, 1000, 10_000],
				stable: true,
				scaler: 'case',
				class: 'linear',
				exponent: 1,
				error: null,
				contracts: [
					{
						id: CONTRACT.id,
						steps: [100, 1000, 10_000],
						calls: [1, 1, 1],
						class: 'linear',
						exponent: 1,
						odds: {
							odds: [
								{ shape, p },
								{ shape: rest, p: 1 - p }
							],
							superlinear: 0,
							points: 3
						},
						lines: []
					}
				]
			}
		]
	});
	assert.equal(
		check_contracts([CONTRACT], [], [{ growth: growth('linear', 0.99, 'n log n') }]).contracts[0]
			.verdict,
		'holds'
	);
	const close = check_contracts([CONTRACT], [], [{ growth: growth('linear', 0.56, 'n log n') }]);
	assert.equal(close.contracts[0].verdict, 'unsure', 'linear 56%, n log n 44%: not shown to hold');
	assert.equal(close.contracts[0].sources[0].within, 0.56);
	const nlogn = { ...CONTRACT, class: 'n log n' as const, text: 'n log n in items' };
	assert.equal(
		check_contracts([nlogn], [], [{ growth: growth('linear', 0.56, 'n log n') }]).contracts[0]
			.verdict,
		'holds',
		'the declared class or a cheaper one: n log n holds on linear 56%, n log n 44%'
	);
	const both = check_contracts(
		[CONTRACT],
		[],
		[
			{ growth: growth('linear', 0.99, 'n log n') },
			{ growth: growth('n log n', 0.05, 'quadratic') }
		]
	);
	assert.equal(both.contracts[0].verdict, 'broken');
});

test('the PR comment shows contracts that change, and any that fail', () => {
	const report = (
		rs: Array<[string, string, ContractReport['contracts'][number]['verdict']]>
	): ContractReport => ({
		schema: 'heisenbench-contracts/1',
		bar: 0.9,
		contracts: rs.map(([path, text, verdict]) => ({
			...CONTRACT,
			id: `lib.ts > ${path}`,
			path,
			text,
			verdict,
			sources: []
		})),
		errors: [],
		pass: rs.every((r) => r[2] === 'holds')
	});
	const base = report([
		['a', 'linear in items', 'holds'],
		['b', 'linear in items', 'holds'],
		['c', 'linear in items', 'broken'],
		['gone', 'linear in items', 'holds']
	]);
	const same = diff_contracts(
		base,
		report([
			['a', 'linear in items', 'holds'],
			['b', 'linear in items', 'holds']
		])
	);
	assert.equal(same.removed.length, 2);
	const quiet = diff_contracts(base, base);
	assert.deepEqual(
		quiet.failing.map((c) => c.path),
		['c'],
		'a failing contract is always shown'
	);
	const d = diff_contracts(
		base,
		report([
			['a', 'linear in items', 'holds'],
			['b', 'n log n in items', 'holds'],
			['c', 'linear in items', 'holds'],
			['new', 'constant', 'unmeasured']
		])
	);
	const md = render_contracts_diff(d);
	assert.match(md, /^#### Complexity contracts/);
	assert.match(md, /- \*\*unmeasured\*\*: `lib\.ts > new`/);
	assert.match(md, /- changed from `@heisenbench linear in items`: `lib\.ts > b`/);
	assert.match(md, /- holds now: `lib\.ts > c`/);
	assert.match(md, /- removed: `lib\.ts > gone`/);
	assert.doesNotMatch(md, /`lib\.ts > a`/, 'an unchanged contract that holds is not shown');
	assert.equal(
		render_contracts_diff(
			diff_contracts(report([['a', 'linear', 'holds']]), report([['a', 'linear', 'holds']]))
		),
		''
	);
});

test('a contract on a method of a class TypeScript compiles (a parameter property) is measured', async () => {
	const dir = temp_dir('heisenbench-contracts-');
	write_files(dir, {
		'package.json': '{ "type": "module" }',
		// `private readonly base` in a constructor: type stripping cannot run it, the compiler does
		'src/lib.ts': `export class Summer {
	constructor(private readonly base: number) {}

	/** @heisenbench linear in xs */
	total(xs: number[]): number {
		let s = this.base;
		for (const x of xs) s += x;
		return s;
	}
}
`,
		'lib.bench.ts': `import { bench } from ${JSON.stringify(BENCH)};
import { Summer } from './src/lib.ts';
const list = (n: number) => Array.from({ length: n }, (_, i) => i);
bench('summer', ({ xs }) => new Summer(1).total(xs), {
	setup: () => ({ xs: list(20) }),
	scale: (_c, k) => ({ xs: list(20 * k) })
});
`
	});
	const out = join(dir, 'r.json');
	await run(process.execPath, [CLI, 'growth', 'lib.bench.ts', '--root', dir, '--out', out], {
		cwd: dir
	});
	const grown = JSON.parse(readFileSync(out, 'utf8')) as Report;
	assert.deepEqual(
		grown.growth!.cases[0].contracts?.map((c) => [c.id, c.class]),
		[['src/lib.ts > Summer > total', 'linear']]
	);
	const r = await run(process.execPath, [CLI, 'contracts', 'src/lib.ts', '--reports', out], {
		cwd: dir
	});
	assert.match(r.stdout, /^holds {4}src\/lib\.ts > Summer > total /m);
});

test('a module TypeScript compiles names its own file, not the base name its source map gives', () => {
	const { map } = ts_to_js('enum E { A }\nexport const a = E.A;\n', '/x/src/e.ts');
	assert.deepEqual((map as { sources: string[] }).sources, ['/x/src/e.ts']);
});
