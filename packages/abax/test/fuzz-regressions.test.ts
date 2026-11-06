import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counts_by_line, fn_of, load_module, measure } from './helpers.ts';

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
