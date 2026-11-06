import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engine_health } from '../src/engine/health.ts';
import { parse_v8_log, unescape_field } from '../src/engine/log.ts';
import { temp_dir, write_files } from './helpers.ts';
import { decode } from '../src/engine/natives.ts';
import { diff_engine, render_engine_markdown } from '../src/engine/diff.ts';
import { ENGINE_SCHEMA } from '../src/engine/types.ts';
import type { EngineCase, EngineFunction, EngineReport, EngineSite } from '../src/engine/types.ts';

test('V8 log fields are unescaped', () => {
	assert.equal(unescape_field('a\\x2Cb'), 'a,b');
	assert.equal(unescape_field('line\\nnext'), 'line\nnext');
	assert.equal(unescape_field('back\\\\slash'), 'back\\slash');
	assert.equal(unescape_field('\\u00e9'), 'é');
	assert.equal(unescape_field('plain'), 'plain');
});

test('the log parser ties ICs, tiers, deopts and windows to measured functions', () => {
	const url = 'file:///x/lib.ts';
	const code = 'export function f(o) {\n\treturn o.a;\n}\n';
	// f starts at offset 17 ("(" of the parameters): line 1, column 18
	const log = [
		`script-details,7,${url},0,0,`,
		`code-creation,JS,10,1,0x1000,100,f ${url}:1:18,0x9000,~`,
		'code-source-info,0x1000,7,17,36,,,',
		'script-source,8,<unknown>,(function anonymous(\\n) {\\n"abax:open:0"\\n})',
		'function,first-execution,7,17,36,0.1,2,f',
		'LoadIC,0x1010,3,2,11,0,1,0xaaa,a,,',
		'LoadIC,0x1010,4,2,11,1,P,0xbbb,a,,',
		`code-creation,JS,13,5,0x2000,300,f ${url}:1:18,0x9000,*`,
		'code-source-info,0x2000,7,17,36,,,',
		`code-deopt,6,300,0x2000,-1,30,deopt-eager,<${url}:2:11>,wrong map`,
		'script-source,9,<unknown>,(function anonymous(\\n) {\\n"abax:close:0"\\n})',
		'LoadIC,0x1010,7,2,11,P,N,0xccc,a,,',
		'LoadIC,0x5000,8,9,9,0,1,0xddd,elsewhere,,'
	].join('\n');
	const facts = parse_v8_log(log, [{ url, path: '/x/lib.ts', code }]);
	assert.equal(facts.windows, 1);
	assert.equal(facts.scripts.get(7), 0);
	const f = facts.functions.get('0:17')!;
	assert.equal(f.name, 'f');
	assert.equal(f.in_window, true);
	assert.deepEqual(
		f.codes.map((c) => [c.tier, c.window]),
		[
			['interpreted', -1],
			['turbofan', 0]
		]
	);
	assert.deepEqual(
		facts.ics.map((i) => [i.type, i.line, i.col, i.state, i.key, i.window]),
		[
			['LoadIC', 2, 11, '1', 'a', 0],
			['LoadIC', 2, 11, 'P', 'a', 0],
			['LoadIC', 2, 11, 'N', 'a', -1]
		],
		'the IC at an unknown pc is dropped'
	);
	assert.equal(facts.deopts.length, 1);
	assert.equal(facts.deopts[0].reason, 'wrong map');
	assert.deepEqual(facts.deopts[0].at, { module: 0, line: 2, col: 11 });
});

test('optimization status bits decode into plain words', () => {
	const bits = {
		lazy: 1 << 17,
		interpreted: 1 << 6,
		baseline: 1 << 14,
		optimized: 1 << 3,
		maglev: 1 << 4,
		turbofan: 1 << 5
	};
	assert.equal(decode(1 | (1 << 3) | (1 << 5), bits), 'turbofan');
	assert.equal(decode(1 | (1 << 3) | (1 << 4), bits), 'maglev');
	assert.equal(decode(1 | (1 << 14), bits), 'baseline');
	assert.equal(decode(1 | (1 << 6), bits), 'interpreted');
	assert.equal(decode(1 | (1 << 17), bits), 'not compiled');
});

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

function site(path: string, key: string, state: EngineSite['state'], line = 12): EngineSite {
	return {
		id: `lib.ts > ${path} > property read ${key} #0`,
		function: `lib.ts > ${path}`,
		module: 'lib.ts',
		line,
		col: 3,
		kind: 'property read',
		key,
		state,
		maps: 1
	};
}

function report(functions: EngineFunction[], sites: EngineSite[]): EngineReport {
	const c: EngineCase = { name: 'c', file: 'x', stable: true, error: null, functions, sites };
	return { schema: ENGINE_SCHEMA, node: '', v8: '', flags: [], warmup: 1, runs: 1, cases: [c] };
}

test('engine diff: lost optimization, new deopts and slower inline caches are findings', () => {
	const base = report(
		[fn('a'), fn('b'), fn('c'), fn('d', { optimized: false, tier: 'baseline' })],
		[site('a', 'x', 'monomorphic'), site('c', 'y', 'megamorphic')]
	);
	const pr = report(
		[
			fn('a', {
				tier: 'deoptimized',
				optimized: false,
				deopts: [{ reason: 'wrong map', kind: 'deopt-eager', line: 12, count: 3 }]
			}),
			fn('b', {
				deopts: [
					{ reason: 'Insufficient type feedback for call', kind: 'deopt-eager', line: 11, count: 1 }
				]
			}),
			fn('c'),
			fn('d')
		],
		[site('a', 'x', 'megamorphic', 14), site('c', 'y', 'monomorphic')]
	);
	const d = diff_engine(base, pr);
	assert.deepEqual(
		d.findings.map((f) => f.text),
		[
			'`lib.ts:10` `a` is no longer optimized (now deoptimized; reason: wrong map at line 12, 3x)',
			'`lib.ts:14` property read `x` went monomorphic -> megamorphic'
		],
		'a deopt on code that had not run yet (b) is not a finding'
	);
	assert.deepEqual(d.better.map((f) => f.text).sort(), [
		'`lib.ts:10` `d` is optimized now (turbofan)',
		'`lib.ts:12` property read `y` went megamorphic -> monomorphic'
	]);
	const md = render_engine_markdown(d);
	assert.ok(md.includes('#### Engine'));
	assert.ok(md.includes('went monomorphic -> megamorphic'));
	assert.ok(md.includes('<summary>Better</summary>'));
});

test('engine diff: an identical report has nothing to say', () => {
	const r = report([fn('a')], [site('a', 'x', 'polymorphic')]);
	const d = diff_engine(r, r);
	assert.deepEqual(d.findings, []);
	assert.deepEqual(d.better, []);
	assert.ok(render_engine_markdown(d).includes('No function lost optimization'));
});

test('engine health reads .svelte components and .svelte.ts classes on their own lines', async () => {
	const abax = fileURLToPath(new URL('../', import.meta.url));
	const dir = temp_dir('abax-health-svelte-');
	symlinkSync(join(abax, 'node_modules'), join(dir, 'node_modules'));
	copyFileSync(join(abax, 'test/fixtures/svelte/List.svelte'), join(dir, 'List.svelte'));
	write_files(dir, {
		'counter.svelte.ts': [
			'export class Counter {',
			'	count = $state(0);',
			'	add(n: number): number {',
			'		this.count += n;',
			'		return this.count;',
			'	}',
			'}',
			''
		].join('\n'),
		'x.bench.ts': [
			`import { bench } from ${JSON.stringify(join(abax, 'src/bench.ts'))};`,
			"import { render } from 'svelte/server';",
			"import List from './List.svelte';",
			"import { Counter } from './counter.svelte.ts';",
			"bench('list', ({ items }) => render(List, { props: { items } }).body, {",
			"	setup: () => ({ items: Array.from({ length: 50 }, (_, i) => ({ name: 'n' + i, done: i % 3 === 0 })) })",
			'});',
			"bench('counter', () => { const c = new Counter(); for (let i = 0; i < 100; i++) c.add(i); return c.count; });",
			''
		].join('\n')
	});
	const r = await engine_health({ files: [join(dir, 'x.bench.ts')], root: dir });
	const [list, counter] = r.cases;
	assert.equal(list.error, null);
	assert.equal(list.stable, true);
	const label = list.functions.find((f) => f.path === 'List > label')!;
	assert.equal(label.line, 3);
	assert.ok(label.optimized);
	const done = list.sites.find((s) => s.key === 'done')!;
	assert.deepEqual([done.line, done.state], [4, 'monomorphic']);
	for (const s of list.sites) assert.ok(s.line >= 1 && s.line <= 13, `${s.id} at ${s.line}`);
	assert.equal(counter.stable, true);
	const add = counter.functions.find((f) => f.path === 'Counter > add')!;
	assert.deepEqual([add.line, add.optimized], [3, true]);
});

test('engine health leaves exported bound functions, proxies and built-ins alone', async () => {
	const abax = fileURLToPath(new URL('../', import.meta.url));
	const dir = temp_dir('abax-engine-natives-');
	write_files(dir, {
		'lib.ts': [
			'function sum(xs: number[]): number {',
			'	let s = 0;',
			'	for (const x of xs) s += x;',
			'	return s;',
			'}',
			'export const bound = sum.bind(null);',
			'export const proxied = new Proxy(sum, {});',
			'export const parse = JSON.parse;',
			'export { sum };',
			''
		].join('\n'),
		'x.bench.ts': [
			`import { bench } from ${JSON.stringify(join(abax, 'src/bench.ts'))};`,
			"import { bound, proxied, sum } from './lib.ts';",
			"bench('sum', ({ xs }) => sum(xs) + bound(xs) + proxied(xs), {",
			'	setup: () => ({ xs: Array.from({ length: 200 }, (_, i) => i) })',
			'});',
			''
		].join('\n')
	});
	const r = await engine_health({ files: [join(dir, 'x.bench.ts')], root: dir });
	assert.equal(r.cases[0].error, null);
	const sum = r.cases[0].functions.find((f) => f.path === 'sum')!;
	assert.equal(sum.optimized, true);
});

test('engine health ends when a measured module leaves a live interval, and kills a child that never ends', async () => {
	const abax = fileURLToPath(new URL('../', import.meta.url));
	const dir = temp_dir('abax-engine-hang-');
	write_files(dir, {
		'lib.ts': [
			'export const ticks = { n: 0 };',
			'setInterval(() => ticks.n++, 1000);',
			'export function twice(x: number): number {',
			'	return x * 2;',
			'}',
			''
		].join('\n'),
		'x.bench.ts': [
			`import { bench } from ${JSON.stringify(join(abax, 'src/bench.ts'))};`,
			"import { twice } from './lib.ts';",
			"bench('interval', () => twice(21));",
			"bench('forever', () => { for (;;) twice(1); });",
			''
		].join('\n')
	});
	const r = await engine_health({ files: [join(dir, 'x.bench.ts')], root: dir, timeout_ms: 5000 });
	const [interval, forever] = r.cases;
	assert.equal(interval.error, null);
	assert.equal(interval.stable, true);
	assert.match(forever.error ?? '', /did not finish within 5 s/);
});
