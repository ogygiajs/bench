import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Report } from '../src/report.ts';
import { elide_unused_imports } from '../src/transform/elide.ts';
import { source_candidates } from '../src/loader/resolve.ts';
import { conditions_for, parse_conditions } from '../src/loader/conditions.ts';
import { ts_to_js } from '../src/transform/index.ts';
import { temp_dir, write_files } from './helpers.ts';

/*
 * Sources as TypeScript projects write them: `./x.js` for `x.ts`, no extension at all, a type
 * imported without `type`; a preload given with --import; where a failed case threw.
 */

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const API = JSON.stringify(
	pathToFileURL(fileURLToPath(new URL('../src/bench.ts', import.meta.url))).href
);

function heisenbench(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
	const r = spawnSync(process.execPath, [CLI, ...args], {
		cwd,
		encoding: 'utf8',
		timeout: 120_000,
		env
	});
	return { code: r.status, out: r.stdout + r.stderr };
}

test('source_candidates: what a relative import may name instead', () => {
	const from = 'file:///p/src/index.ts';
	assert.deepEqual(source_candidates('./clone.js', from), ['./clone.ts']);
	assert.deepEqual(source_candidates('../a.mjs?x=1', from), ['../a.mts?x=1']);
	assert.deepEqual(source_candidates('./core', from), [
		'./core.ts',
		'./core.mts',
		'./core.js',
		'./core.mjs',
		'./core/index.ts',
		'./core/index.js'
	]);
	assert.deepEqual(source_candidates('./parser/', from), [
		'./parser/index.ts',
		'./parser/index.js'
	]);
	assert.deepEqual(source_candidates('./data.json', from), [], 'an extension it names stays');
	assert.deepEqual(source_candidates('./x.svelte', from), []);
	assert.deepEqual(source_candidates('pkg/sub', from), [], 'not a relative import');
	const pkg = 'file:///p/node_modules/lib/index.js';
	assert.deepEqual(source_candidates('./x.js', pkg), [], "a package's x.js stays x.js");
	assert.deepEqual(
		source_candidates('./helpers', pkg),
		['./helpers.js', './helpers.mjs', './helpers/index.js'],
		'no extension in a package: what a bundler tries'
	);
	assert.deepEqual(source_candidates('./blocks/', pkg), ['./blocks/index.js']);
});

test('conditions_for: added for the code under test, never for Heisenbench and its packages', () => {
	const node = ['node', 'import'];
	const own = new Set(['file:///p/node_modules/oxc-parser/index.js']);
	const add = (parent: string | undefined) => conditions_for(parent, node, ['svelte'], own);
	assert.deepEqual(add('file:///p/bench/a.bench.ts'), ['node', 'import', 'svelte']);
	assert.deepEqual(add('file:///p/node_modules/lib/index.js?heisenbench_gen=2'), [
		'node',
		'import',
		'svelte'
	]);
	assert.equal(add(pathToFileURL(fileURLToPath(new URL('../src/cli.ts', import.meta.url))).href), node);
	assert.equal(add('file:///p/node_modules/oxc-parser/index.js'), node, 'a package Heisenbench loaded');
	assert.equal(add(undefined), node, 'the entry point');
	assert.deepEqual(parse_conditions(' svelte, browser,svelte,'), ['svelte', 'browser']);
});

test('--conditions picks the build a bundler would, and package imports with no extension load', () => {
	const dir = temp_dir('heisenbench-sources-');
	const build = (which: string) =>
		`import { label } from './helpers';\nexport function name() { return label('${which}'); }\n`;
	write_files(dir, {
		'package.json': '{ "type": "module" }',
		// a package built for bundlers: exports by condition, and `./helpers` with no extension
		'node_modules/lib/package.json': JSON.stringify({
			name: 'lib',
			version: '1.2.3',
			type: 'module',
			exports: {
				'.': { svelte: './svelte/index.js', browser: './browser/index.js', default: './node/index.js' }
			}
		}),
		'node_modules/lib/svelte/index.js': build('svelte'),
		'node_modules/lib/svelte/helpers.js': 'export const label = (s) => s + "!";\n',
		'node_modules/lib/browser/index.js': build('browser'),
		'node_modules/lib/browser/helpers.js': 'export const label = (s) => s + "!";\n',
		'node_modules/lib/node/index.js': build('node'),
		'node_modules/lib/node/helpers.js': 'export const label = (s) => s + "!";\n',
		'bench/lib.bench.ts': `import { bench } from ${API};
import { name } from 'lib';
bench('name ' + name(), () => name());
`
	});
	const names = (args: string[]) => {
		const r = heisenbench(['run', 'bench/lib.bench.ts', '--out', 'r.json', ...args], dir);
		assert.equal(r.code, 0, r.out);
		const report = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')) as Report;
		return report.cases.map((c) => c.name);
	};
	assert.deepEqual(names([]), ['name node!']);
	assert.deepEqual(names(['--conditions', 'svelte']), ['name svelte!']);
	// `browser` for the code under test only: Heisenbench's own parser has a browser build too
	assert.deepEqual(names(['--conditions', 'browser', '--measure', 'time', '--time-ms', '20']), [
		'name browser!'
	]);
	const bad = heisenbench(['run', 'bench/lib.bench.ts', '--conditions', ','], dir);
	assert.equal(bad.code, 2, bad.out);
});

test('elide_unused_imports: names nothing reads go, offsets stay', () => {
	const cases: Array<[string, string, number]> = [
		['import { A, b } from "./x.js";\nb();', 'import {    b } from "./x.js";\nb();', 1],
		['import { b, A } from "./x.js";\nb();', 'import { b,   } from "./x.js";\nb();', 1],
		[
			'import { A, b, C, d, } from "./x.js";\nb(d);',
			'import {    b,    d, } from "./x.js";\nb(d);',
			2
		],
		[
			'import {\n\tA as B,\n\tb,\n} from "./x.js";\nb();',
			'import {\n\t       \n\tb,\n} from "./x.js";\nb();',
			1
		],
		['import D, { A } from "./x.js";\nD();', 'import D, {   } from "./x.js";\nD();', 1],
		['import { A } from "./x.js";', 'import {   } from "./x.js";', 1],
		// any identifier spelled the same keeps it
		[
			'import { A } from "./x.js";\nconst o = { A: 1 };',
			'import { A } from "./x.js";\nconst o = { A: 1 };',
			0
		],
		['import { A } from "./x.js";\nexport { A };', 'import { A } from "./x.js";\nexport { A };', 0],
		['import * as ns from "./x.js";\n', 'import * as ns from "./x.js";\n', 0],
		['import é, { Ä } from "./x.js";\né();', 'import é, {   } from "./x.js";\né();', 1]
	];
	for (const [js, want, n] of cases) {
		const r = elide_unused_imports(js, 'm.ts');
		assert.equal(r.code, want, js);
		assert.equal(r.elided, n, js);
		assert.equal(r.code.length, js.length);
	}
	// what type stripping leaves: an annotation is whitespace, so the type name is unused
	const ts = `import { Rule, apply } from './rules.ts';\nexport const run = (r: Rule) => apply(r);\n`;
	const out = ts_to_js(ts, '/p/run.ts');
	assert.equal(out.elided, 1);
	assert.match(out.code, /^import \{ {7}apply \} from '\.\/rules\.ts';/);
	// compiled TypeScript (an enum) is elided the same way
	const compiled = ts_to_js(
		`import { Rule, apply } from './rules.ts';\nenum E { A }\nexport const run = (r: Rule) => apply(r) + E.A;\n`,
		'/p/run.ts'
	);
	assert.equal(compiled.elided, 1);
	assert.ok(compiled.map !== null);
});

test('TypeScript imports as projects write them load and count, in the counting and the plain build', () => {
	const dir = temp_dir('heisenbench-sources-');
	write_files(dir, {
		'package.json': '{ "type": "module" }',
		'src/rules.ts': `export type Rule = { weight: number };\nexport interface Named { name: string }\nexport const apply = (r: Rule) => r.weight * 2;\n`,
		'src/core.ts': `export const twice = (n: number) => n * 2;\n`,
		'src/parser/index.ts': `export const parse = (s: string) => s.length;\n`,
		'src/kinds.ts': `import { Rule } from './rules.js';\nexport enum Kind { A = 1 }\nexport const weight_of = (r: Rule) => r.weight + Kind.A;\n`,
		// `./rules.js` for rules.ts; `./core` and `./parser` with no extension; `Rule` and
		// `Named` are types imported without `type`
		'src/index.ts': `import { Rule, Named, apply } from './rules.js';
import { twice } from './core';
import { parse } from './parser';
import { weight_of } from './kinds.js';
export function score(r: Rule, n: Named): number {
	return twice(apply(r)) + parse(n.name) + weight_of(r);
}
`,
		'bench/score.bench.ts': `import { bench } from ${API};
import { score } from '../src/index.js';
bench('score', () => score({ weight: 3 }, { name: 'abc' }));
`
	});
	const r = heisenbench(
		['run', 'bench/score.bench.ts', '--measure', 'time', '--time-ms', '20', '--out', 'r.json'],
		dir
	);
	assert.equal(r.code, 0, r.out);
	const report = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')) as Report;
	assert.equal(report.load_errors, undefined);
	const c = report.cases[0];
	assert.equal(c.error, null);
	const modules = new Set(c.functions.map((f) => f.module));
	for (const m of [
		'src/index.ts',
		'src/rules.ts',
		'src/core.ts',
		'src/parser/index.ts',
		'src/kinds.ts'
	])
		assert.ok(modules.has(m), `${m} counted`);
	assert.ok(
		(c.measure?.time?.samples ?? 0) > 0 && c.measure?.errors === undefined,
		'the plain build ran it too: ' + JSON.stringify(c.measure)
	);
});

test('--import loads a preload first, here and in the children; a failed case keeps where it threw', () => {
	const dir = temp_dir('heisenbench-sources-');
	write_files(dir, {
		'package.json': '{ "type": "module" }',
		// a path alias only a bundler knows, mapped by the preload
		'preload.ts': `import { registerHooks } from 'node:module';
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === '#lib') return next(new URL('./src/lib.ts', import.meta.url).href, context);
		return next(specifier, context);
	}
});
`,
		'src/lib.ts': `export function total(xs: number[]): number {
	let s = 0;
	for (const x of xs) s += x;
	return s;
}

function broken(o: { f?: () => number }): number {
	return o.f!();
}

export function fails(): number {
	return broken({});
}
`,
		'bench/lib.bench.ts': `import { bench } from ${API};
import { fails, total } from '#lib';
bench('total', () => total([1, 2, 3]));
bench('fails', () => fails());
`
	});
	const without = heisenbench(['run', 'bench/lib.bench.ts', '--out', 'r.json'], dir);
	assert.equal(without.code, 1);
	assert.match(without.out, /FAILED   bench\/lib\.bench\.ts: .*#lib/);
	const r = heisenbench(
		[
			'run',
			'bench/lib.bench.ts',
			'--import',
			'preload.ts',
			'--measure',
			'time',
			'--time-ms',
			'20',
			'--out',
			'r.json'
		],
		dir
	);
	assert.equal(r.code, 1, 'the failing case fails the run');
	const report = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')) as Report;
	const by = new Map(report.cases.map((c) => [c.name, c]));
	assert.ok(by.get('total')!.totals.steps > 0);
	assert.ok(
		(by.get('total')!.measure?.time?.samples ?? 0) > 0,
		'the time child loaded the preload'
	);
	const failed = by.get('fails')!;
	assert.match(failed.error!, /is not a function/);
	assert.deepEqual(
		failed.error_stack!.slice(0, 2).map((f) => f.replace(/:\d+\)$/, ')')),
		['broken (src/lib.ts:8)', 'fails (src/lib.ts:12)'],
		'the source lines, relative to the root'
	);
	assert.match(r.out, /FAILED   fails: .* \(at broken \(src\/lib\.ts:8:\d+\)\)/);
	const debug = heisenbench(
		[
			'run',
			'bench/lib.bench.ts',
			'--import',
			'preload.ts',
			'--filter',
			'fails',
			'--debug',
			'--out',
			'r.json'
		],
		dir
	);
	assert.match(
		debug.out,
		/\n {11}at broken \(src\/lib\.ts:8:\d+\)\n {11}at fails \(src\/lib\.ts:12:\d+\)/
	);
	const missing = heisenbench(['run', 'bench/lib.bench.ts', '--import', 'nope.ts'], dir);
	assert.equal(missing.code, 2);
	assert.match(missing.out, /--import nope\.ts: no such file/);
});
