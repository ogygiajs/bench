import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { instrument } from '../src/transform/instrument.ts';
import { compile_svelte } from '../src/transform/index.ts';
import { load_prices } from '../src/prices.ts';
import { fn_of, load_module, loader_root, measure, write_files } from './helpers.ts';

const require = createRequire(import.meta.url);
const { prices, hash } = load_prices();

function counts(report: Awaited<ReturnType<typeof measure>>, path: string): number[] {
	return fn_of(report, path).blocks.map((b) => b.count);
}

test('if/else inside a loop: exact block counts', async () => {
	const m = await load_module(`export function f(n: number) {
	let t = 0;
	for (let i = 0; i < n; i++) {
		if (i % 2 === 0) {
			t += i;
		} else {
			t -= 1;
		}
	}
	return t;
}`);
	const r = await measure(() => m.f(5 as never));
	// entry, loop test, update, body, then, else, after the loop
	assert.deepEqual(counts(r, 'f'), [1, 6, 5, 5, 3, 2, 1]);
	assert.equal(fn_of(r, 'f').calls, 1);
});

test('short-circuit and ternary branches are blocks', async () => {
	const m = await load_module(`export function g(a: unknown, b: unknown) {
	const x = a && b;
	const y = a || b;
	const z = a ?? b;
	const w = a ? 1 : 2;
	return [x, y, z, w];
}`);
	const r = await measure(() => {
		m.g(1 as never, 2 as never);
		m.g(0 as never, 2 as never);
		m.g(null as never, 2 as never);
	});
	assert.deepEqual(counts(r, 'g'), [3, 1, 2, 1, 1, 2]);
});

test('optional chaining: member and call, with and without arguments', async () => {
	const m = await load_module(`export function h(o: any) {
	const a = o?.p;
	const b = o?.fn?.();
	const c = o?.fn?.(1);
	return [a, b, c];
}`);
	const r = await measure(() => {
		m.h(null as never);
		m.h({ p: 1 } as never);
		m.h({ fn: () => 7 } as never);
	});
	assert.deepEqual(counts(r, 'h'), [3, 2, 2, 1, 2, 1]);
});

test('empty function bodies are counted and stay valid code', async () => {
	const m = await load_module(`const noop = () => {};
export const hooks = { restore: () => {}, settle() {} };
export function run(): void {
	noop();
	hooks.restore();
	hooks.settle();
}`);
	const r = await measure(() => m.run());
	assert.deepEqual(counts(r, 'noop'), [1]);
	const restore = r.functions.find((f) => f.path.endsWith('restore'));
	const settle = r.functions.find((f) => f.path.endsWith('settle'));
	assert.equal(restore?.calls, 1);
	assert.equal(settle?.calls, 1);
});

test('a spread of an expression with its own blocks wraps the whole argument', async () => {
	const m = await load_module(`export function all(ast: any, a: number[]): number {
	const o = { ...(ast.o ?? {}), k: 1 };
	const list = [...a, ...(ast.fragment?.nodes ?? [])];
	return Math.max(...(ast.q?.r ?? [0])) + list.length + Object.keys(o).length;
}`);
	const r = await measure(() => {
		assert.equal(m.all({ fragment: { nodes: [1, 2] }, q: { r: [5] } } as never, [1] as never), 9);
		assert.equal(m.all({} as never, [] as never), 1);
	});
	assert.equal(fn_of(r, 'all').calls, 2);
});

test('default parameters and destructuring defaults', async () => {
	const m = await load_module(`export function d(a = 5, { k = 2 } = {}) {
	return a + k;
}`);
	const r = await measure(() => {
		m.d();
		m.d(1 as never, { k: 3 } as never);
		m.d(1 as never);
	});
	assert.deepEqual(counts(r, 'd'), [3, 1, 2, 2]);
});

test('switch: case tests, fallthrough, default', async () => {
	const m = await load_module(`export function s(x: number) {
	let r = 0;
	switch (x) {
		case 1:
			r += 1;
		case 2:
			r += 2;
			break;
		default:
			r = 9;
	}
	return r;
}`);
	const r = await measure(() => {
		m.s(1 as never);
		m.s(2 as never);
		m.s(3 as never);
	});
	assert.deepEqual(counts(r, 's'), [3, 3, 1, 2, 2, 1, 3]);
});

test('try / catch / finally and throw', async () => {
	const m = await load_module(`export function t(x: boolean) {
	try {
		if (x) throw new Error('x');
		return 1;
	} catch (e) {
		return 2;
	} finally {
		x = false;
	}
}`);
	const r = await measure(() => {
		m.t(true as never);
		m.t(false as never);
	});
	// entry, try, then (throw), rest of try, catch, finally
	assert.deepEqual(counts(r, 't'), [2, 2, 1, 1, 1, 2]);
});

test('do-while, while, for-of with continue, for-in', async () => {
	const m = await load_module(`export function loops(xs: number[]) {
	let n = 0;
	do { n++; } while (n < 3);
	while (n < 5) n++;
	for (const x of xs) { if (x < 0) continue; n += x; }
	for (const k in { a: 1, b: 2 }) n++;
	return n;
}`);
	const r = await measure(() => m.loops([1, -1, 2] as never));
	assert.deepEqual(counts(r, 'loops'), [1, 3, 3, 1, 3, 2, 1, 3, 1, 2, 1, 2, 1]);
});

test('class fields, static blocks, getters, methods and callbacks get stable paths', async () => {
	const m = await load_module(`export class K {
	a = 1;
	b = this.a > 0 ? 'p' : 'n';
	static s = 0;
	static { K.s = 5; }
	get v() { return this.a; }
	m(xs: number[]) { return xs.map((x) => x + 1); }
}`);
	type KClass = new () => { v: number; m(xs: number[]): number[] };
	const K = m.K as unknown as KClass;
	const r = await measure(() => {
		const a = new K();
		new K();
		void a.v;
		a.m([1, 2]);
	});
	assert.deepEqual(counts(r, 'K > <fields>'), [2, 2, 2, 0]);
	assert.equal(fn_of(r, 'K > get v').calls, 1);
	assert.equal(fn_of(r, 'K > m > map:0').calls, 2);
	assert.equal(fn_of(r, 'K > m').calls, 1);
});

function paths_of(code: string, filename = 'a.ts'): string[] {
	const prices = load_prices();
	return instrument(code, {
		id: filename,
		filename,
		prices: prices.prices,
		prices_hash: prices.hash,
		module_specifier: 'heisenbench:none',
		expose: false
	}).meta.functions.map((f) => f.path);
}

test('a callback keeps its id when another callback is added before it', () => {
	const before = paths_of(`function lower(rows) {
	rows.sort((a, b) => a.line - b.line);
	return rows.map((r) => r.id);
}`);
	const after = paths_of(`function lower(rows) {
	rows.filter((r) => r.id > 0);
	rows.sort((a, b) => a.name.localeCompare(b.name));
	rows.sort((a, b) => a.line - b.line);
	return rows.map((r) => r.id);
}`);
	for (const p of before) assert.ok(after.includes(p), `${p} in ${after.join(', ')}`);
	assert.equal(after.length, before.length + 2);
	// a slot is completed by six hex digits of the callback's syntax tree
	assert.match(before[2], /^lower > sort:0~[0-9a-f]{6}$/);
});

test('ids of identical callbacks differ by order only; formatting, comments and types do not move them', () => {
	const twins = paths_of(`function f(xs: number[]) {
	xs.forEach((x) => use(x));
	xs.forEach((x) => use(x));
}`);
	assert.match(twins[2], /^f > forEach:0~[0-9a-f]{6}$/);
	assert.equal(twins[3], `${twins[2]}#2`);
	assert.deepEqual(
		twins,
		paths_of(`function f(xs: number[]) {
	xs.forEach((x) => use(x));
	xs.forEach((x) => use(x));
}`)
	);
	const reformatted = paths_of(`function f(xs) {
	xs.forEach(
		// each one
		(x: number) => use((x as number)),
	);
	xs.forEach(x => use(x));
}`);
	assert.deepEqual(reformatted, twins);
	// a named function keeps its plain name; a second one of that name in the scope gets its hash
	const named = paths_of(`function g(k) {
	if (k) { const on = () => 1; return on; }
	const on = () => 2;
	return on;
}`);
	assert.equal(named[2], 'g > on');
	assert.match(named[3], /^g > on~[0-9a-f]{6}$/);
});

test('steps = sum(block count * block price)', async () => {
	const m = await load_module(`export function p(a: number, b: number) {
	return a + b * 2;
}`);
	const r = await measure(() => {
		for (let i = 0; i < 10; i++) m.p(i as never, 1 as never);
	});
	const f = fn_of(r, 'p');
	assert.equal(f.blocks[0].price, 2 * prices.ops.arith);
	assert.equal(f.self_steps, 10 * f.blocks[0].price);
	assert.equal(f.calls, 10);
	assert.equal(r.totals.steps, f.self_steps);
});

test('every block maps to the original TS line through an input source map', () => {
	const ts = require('typescript') as typeof import('typescript');
	const source = `interface A {
	x: number;
}
type B = string;
export function q(a: A): number {
	if (a.x > 1) {
		return a.x * 2;
	}
	return 0;
}
`;
	const out = ts.transpileModule(source, {
		fileName: 'q.ts',
		compilerOptions: {
			sourceMap: true,
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext
		}
	});
	assert.notEqual(
		out.outputText.split('\n').indexOf('export function q(a) {'),
		4,
		'TS output moved lines'
	);
	const r = instrument(out.outputText, {
		id: 'q.ts',
		filename: 'q.js',
		input_map: JSON.parse(out.sourceMapText!),
		prices,
		prices_hash: hash,
		module_specifier: 'heisenbench:module/q'
	});
	const q = r.meta.functions.findIndex((f) => f.path === 'q');
	assert.equal(r.meta.functions[q].line, 5);
	const blocks = r.meta.blocks.filter((b) => b.fn === q);
	assert.deepEqual(
		blocks.map((b) => b.line),
		[5, 6, 9]
	);
	const lines_with_ops = new Set<number>();
	for (const b of blocks)
		for (let i = 0; i < b.line_ops.length; i += 3) lines_with_ops.add(b.line_ops[i]);
	assert.ok(lines_with_ops.has(7), 'the multiplication is priced on line 7');

	// the output map is chained: instrumented code maps back to the TS file
	const map = new TraceMap(r.map as never);
	const at = r.code.indexOf('a.x * 2');
	const before = r.code.slice(0, at);
	const line = before.split('\n').length;
	const column = at - before.lastIndexOf('\n') - 1;
	const o = originalPositionFor(map, { line, column });
	assert.equal(o.line, 7);
	assert.ok(o.source?.endsWith('q.ts'));
});

const SVELTE = `<script>
	let { items = [] } = $props();
	function label(item) {
		if (item.done) {
			return 'done: ' + item.name;
		}
		return item.name;
	}
</script>

{#each items as item}
	<p>{label(item)}</p>
{/each}
`;

test('compiled .svelte output maps back to the .svelte lines', () => {
	for (const generate of ['server', 'client'] as const) {
		const c = compile_svelte(SVELTE, '/virtual/List.svelte', generate);
		const r = instrument(c.code, {
			id: 'List.svelte',
			filename: '/virtual/List.svelte.js',
			input_map: c.map,
			prices,
			prices_hash: hash,
			module_specifier: 'heisenbench:module/list'
		});
		const fi = r.meta.functions.findIndex((f) => f.path.endsWith('label'));
		assert.ok(fi >= 0, `label found (${generate})`);
		assert.equal(r.meta.functions[fi].line, 3, generate);
		const lines = r.meta.blocks.filter((b) => b.fn === fi).map((b) => b.line);
		assert.deepEqual(lines, [3, 4, 7], generate);
		assert.ok(r.meta.file.endsWith('List.svelte'));
	}
});

test('the loader instruments .svelte components it renders', async () => {
	const { render } = (await import('svelte/server')) as {
		render: (c: unknown, o: { props: unknown }) => { body: string };
	};
	const List = (await import('./fixtures/svelte/List.svelte')) as { default: unknown };
	const items = [
		{ name: 'a', done: true },
		{ name: 'b', done: false },
		{ name: 'c', done: true }
	];
	let body = '';
	const r = await measure(() => {
		body = render(List.default, { props: { items } }).body;
	});
	assert.ok(body.includes('done: a'));
	const label = r.functions.find((f) => f.path.endsWith('label'));
	assert.ok(label, 'label was counted');
	assert.equal(label.calls, 3);
	assert.equal(label.line, 3);
	const then = label.blocks.find((b) => b.line === 4);
	assert.equal(then?.count, 2);
});

test('__heisenbench exposes private top-level bindings (live for let)', async () => {
	const m = await load_module<{
		bump(): void;
		__heisenbench: {
			helper(x: number): number;
			LIMIT: number;
			count: number;
			Box: new () => { v: number };
		};
	}>(`function helper(x: number) { return x * 2; }
const LIMIT = 3;
let count = 0;
class Box { v = 1; }
export function bump() { count++; }
`);
	assert.equal(m.__heisenbench.helper(4), 8);
	assert.equal(m.__heisenbench.LIMIT, 3);
	assert.equal(new m.__heisenbench.Box().v, 1);
	m.bump();
	m.bump();
	assert.equal(m.__heisenbench.count, 2);
	assert.equal('bump' in m.__heisenbench, false);
});

test('instrumented functions called through an import cycle before their module ran', async () => {
	const dir = loader_root();
	write_files(dir, {
		'cycle-a.ts': `import { at_load } from './cycle-b.ts';
export function early() { return 1; }
export const value = at_load + 1;
`,
		'cycle-b.ts': `import { early } from './cycle-a.ts';
export const at_load = early();
`
	});
	const r = await measure(async () => {
		const m = (await import(pathToFileURL(join(dir, 'cycle-a.ts')).href)) as { value: number };
		assert.equal(m.value, 2);
	});
	assert.equal(fn_of(r, 'early').calls, 1);
});
