import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counts_by_line, fn_of, load_module, measure, rt } from './helpers.ts';
import { StepCapError } from '../src/runtime/index.ts';
import { Measurer } from '../src/growth/measure.ts';
import { search_case } from '../src/search/index.ts';
import type { BenchCase } from '../src/bench.ts';

/*
 * Bugs the fuzzer (fuzz/) found, each as its minimized program: the instrumented code must do what
 * the plain code does, and count what V8 counts.
 */

/** The same module, not instrumented (a data: URL never goes through the counting loader). */
async function plain<T>(source: string): Promise<T> {
	return (await import('data:text/javascript,' + encodeURIComponent(source))) as T;
}

test('an anonymous function keeps the name its field, default value or logical assignment gives it', async () => {
	const source = `export class C { h = (q) => q; #p = () => 1; get p() { return this.#p; } }
export function d(cb = () => 1, { k = function () {} } = {}) { return [cb.name, k.name]; }
export function l() { let x; x ||= () => 1; let y = 1; y &&= class {}; return [x.name, y.name]; }`;
	const m = await load_module<Record<string, (...a: never[]) => unknown>>(source, '.js');
	const p = await plain<typeof m>(source);
	const names = (mod: typeof m) => {
		const C = mod.C as unknown as new () => { h: { name: string }; p: { name: string } };
		const c = new C();
		return [c.h.name, c.p.name, ...(mod.d() as string[]), ...(mod.l() as string[])];
	};
	assert.deepEqual(names(m), ['h', '#p', 'cb', 'k', 'x', 'y']);
	assert.deepEqual(names(m), names(p));
});

/**
 * An error message without the source text V8 quotes in some (`x is not iterable`): what is quoted
 * is the instrumented expression, a difference in wording only.
 */
function kind_of(e: unknown): string {
	const m = (e as Error).message;
	const at = m.lastIndexOf(' is not');
	return `${(e as Error).name}: ${at === -1 ? m : m.slice(at)}`;
}

test('spreading something that is not iterable throws the error the language throws there', async () => {
	// minimized from seed 11: a call's arguments and an array literal word it differently; the
	// runtime spread it itself and always threw the array literal's
	const source = `export function call(x) { return Math.max(...x); }
export function array(x) { return [...x]; }`;
	const m = await load_module<Record<string, (x: unknown) => unknown>>(source, '.js');
	const p = await plain<typeof m>(source);
	for (const name of ['call', 'array']) {
		for (const x of [5, null, {}]) {
			let got = '';
			let want = '';
			try {
				m[name](x);
			} catch (e) {
				got = kind_of(e);
			}
			try {
				p[name](x);
			} catch (e) {
				want = kind_of(e);
			}
			assert.equal(got, want, `${name}(${JSON.stringify(x)})`);
		}
	}
});

test('a comma expression stays one argument when the transform wraps it', async () => {
	// minimized from seed 2: `Object.entries((log(), {}))` became `Object.entries(log(), {})`
	const m = await load_module(`export async function all(log: () => void) {
	const entries = Object.entries((log(), { a: 1 }));
	const arr = [...(log(), [2])];
	const obj = { ...(log(), { b: 3 }) };
	const opt = (log(), { c: 4 })?.c;
	const out: unknown[] = [];
	for await (const x of (log(), [5])) out.push(x);
	return [entries, arr, obj, opt, out];
}`);
	let logged = 0;
	const r = await m.all((() => logged++) as never);
	assert.deepEqual(r, [[['a', 1]], [2], { b: 3 }, 4, [5]]);
	assert.equal(logged, 5);
});

test('an async generator that returns a value leaves the stack while it awaits it', async () => {
	// minimized from seed 18: the value returned is awaited, unseen; the generator stayed on the
	// shadow stack and became the caller of what main called next
	const m = await load_module(`async function* gen() {
	return 1;
}
function after() {
	return 2;
}
export async function main() {
	for await (const q of gen()) void q;
	return after();
}`);
	const r = await measure(() => m.main());
	const callers = r.edges.filter((e) => e.to.endsWith('> after')).map((e) => e.from);
	assert.deepEqual(callers, [fn_of(r, 'main').id]);
	assert.equal(fn_of(r, 'gen').calls, 1);
});

test('break out of a labeled block starts a new block where it lands', async () => {
	// minimized from seed 46: the code after the labeled block shared a block with code `break`
	// jumps over, and was counted as not run
	const m = await load_module(`export function f(a: boolean) {
	B: {
		if (a) {
			if (a) break B;
		}
		;
	}
	return [1].length;
}`);
	const r = await measure(() => {
		m.f(true as never);
		m.f(false as never);
	});
	assert.equal(counts_by_line(fn_of(r, 'f'))[8], 2);
});

test('a generator closed by return() disposes its using declarations as itself', async () => {
	// minimized from seed 187: the disposal ran before the frame was resumed, so it was charged to
	// the function that called return()
	const m = await load_module(`function res() {
	return { [Symbol.dispose]() {} };
}
function* gen() {
	{
		using u = res();
		yield 1;
	}
}
export function first() {
	for (const x of gen()) return x;
}`);
	const r = await measure(() => m.first());
	const dispose = r.functions.find((f) => f.path.endsWith('[computed]'))!;
	const callers = r.edges.filter((e) => e.to === dispose.id).map((e) => e.from);
	assert.deepEqual(callers, [fn_of(r, 'gen').id]);
});

test('using errors are worded as the language words them', async () => {
	const source = `export async function f(v, awaited) {
	try {
		if (awaited) {
			await using x = v;
		} else {
			using x = v;
		}
	} catch (e) {
		return e.message;
	}
	return 'ok';
}`;
	const m = await load_module<Record<string, (v: unknown, a: boolean) => Promise<string>>>(
		source,
		'.js'
	);
	const p = await plain<typeof m>(source);
	for (const v of [5, {}, { [Symbol.dispose]: 1 }, { [Symbol.asyncDispose]: 1 }]) {
		for (const a of [false, true]) assert.equal(await m.f(v, a), await p.f(v, a));
	}
});

test('leaving a for await loop by a break to an outer label resumes the frame', async () => {
	// minimized from seed 20: the break skipped the resume after the loop, and the function's
	// next call was charged to the root
	const m = await load_module(`function after() {
	return 1;
}
export async function f() {
	B: {
		for await (const v of [6, Promise.resolve('x')]) {
			if (v) break B;
		}
	}
	L: for await (const v of [1, 2]) {
		for (const w of [1]) {
			if (v === 1) continue L;
		}
	}
	return after();
}`);
	const r = await measure(() => m.f());
	const callers = r.edges.filter((e) => e.to.endsWith('> after')).map((e) => e.from);
	assert.deepEqual(callers, [fn_of(r, 'f').id]);
});

test('await using disposal takes as many microtask turns as the language: interleaving is kept', async () => {
	// minimized from seed 114563: the disposal awaited Promise.resolve(out).then(...), one turn more
	// than the language, and concurrent async code ran in another order
	const source = `function res(name) {
	return { async [Symbol.asyncDispose]() { await null; log.push('disposed ' + name); } };
}
function sync_only() {
	return { [Symbol.dispose]() { log.push('sync disposed'); } };
}
function rejects() {
	return { [Symbol.asyncDispose]() { return Promise.reject(new Error('no')); } };
}
let log = [];
async function a() {
	{
		await using u = res('u');
		await using s = sync_only();
		await using n = null;
	}
	try {
		await using r = rejects();
		await using u2 = res('u2');
	} catch (e) {
		log.push('caught ' + e.message);
	}
	log.push('a done');
}
async function b() {
	for (let i = 0; i < 12; i++) {
		await null;
		log.push('b' + i);
	}
}
export async function main() {
	log = [];
	await Promise.all([a(), b()]);
	return log;
}`;
	const m = await load_module<{ main: () => Promise<string[]> }>(source, '.js');
	const p = await plain<typeof m>(source);
	assert.deepEqual(await m.main(), await p.main());
});

test('each ?. link of a chain counts its own runs', async () => {
	// minimized from seed 201: the counters of `a?.b?.c` were nested the wrong way round, so the
	// `?.b` link counted the runs of `?.c` and the other way round
	const m = await load_module(`export function f(o: any) {
	return o?.a?.b;
}
export function g(o: any) {
	return (o?.a)?.b;
}`);
	const inputs = [null, {}, { a: {} }, { a: { b: 1 } }];
	const r = await measure(() => {
		for (const o of inputs) {
			m.f(o as never);
			m.g(o as never);
		}
	});
	// entry, then `?.a` (o is not nullish: 3 of 4), then `?.b` (o.a is not nullish: 2 of 4)
	for (const name of ['f', 'g'])
		assert.deepEqual(
			fn_of(r, name).blocks.map((b) => b.count),
			[4, 3, 2]
		);
});

test("an arrow's => is found past comments that hold one", async () => {
	// from the corpus run: svelte/src/internal/client/dom/elements/attachments.js casts with a
	// JSDoc comment holding `=>`, and the body was opened there (code that does not parse)
	const m = await load_module(
		`export const f = (fn, node) => /** @type {(node: Element) => void} */ (fn)(node);
export const g = (a) /* => */ => // and =>
	a + 1;`,
		'.js'
	);
	assert.equal(m.f(((n: number) => n * 2) as never, 4 as never), 8);
	assert.equal(m.g(1 as never), 2);
});

test('a run past its step cap ends, in a loop or in recursion, even under a catch-all', async () => {
	const m = await load_module(`export function spin(n: number) {
	let i = 0;
	while (n > 0) i++;
	return i;
}
export function deep(n: number): number {
	return n > 0 ? deep(n) + 1 : 0;
}
export function stubborn() {
	for (;;) {
		try {
			spin(1);
		} catch {
			// keeps going, if it could
		}
	}
}`);
	for (const run of [() => m.spin(1 as never), () => m.deep(1 as never), () => m.stubborn()]) {
		rt.reset();
		rt.cap = 5000;
		try {
			assert.throws(run, (e: unknown) => e instanceof StepCapError && e.steps > 5000);
		} finally {
			rt.cap = Infinity;
		}
	}
	// without a cap nothing changes
	rt.reset();
	assert.equal(m.spin(0 as never), 0);
});

test('the slow-input search finds an input the code never finishes on, and stops there', async () => {
	const m = await load_module(`export function count_down(n: number) {
	let steps = 0;
	while (n !== 0) {
		n--;
		steps++;
	}
	return steps;
}`);
	const c: BenchCase<{ n: number }> = {
		name: 'count down',
		file: '',
		fn: (ctx) => m.count_down(ctx.n as never),
		setup: () => ({ n: 5 })
	};
	const s = await search_case(c as BenchCase, new Measurer(), { evals: 200, steps: 2e5, seed: 1 });
	assert.equal(s.error, null);
	assert.equal(s.runaway, true);
	assert.equal(s.stopped, 'runaway');
	// the try ran out its own cap, not the budget's leftover, and is not the worst input
	assert.ok(s.exceeded && s.exceeded.cap >= 1e4 && s.exceeded.cap < 2e5, JSON.stringify(s));
	assert.ok(s.worst < s.exceeded.cap, JSON.stringify(s));
	assert.equal(rt.cap, Infinity);
});
