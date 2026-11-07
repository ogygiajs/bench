import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load_module, rt } from './helpers.ts';
import { Measurer } from '../src/growth/measure.ts';
import { render_search, search_case } from '../src/search/index.ts';
import type { SearchCase } from '../src/search/index.ts';
import type { BenchCase } from '../src/bench.ts';

/*
 * The worst-case search on planted code: a regex that backtracks, reached only through valid JSON;
 * a parser that is linear on flat input and quadratic on deep valid nesting; and a clean linear
 * function. Each search is seeded and bounded by evaluations, so its result is the same every run.
 */

const m = await load_module<Record<string, (...a: never[]) => unknown>>(`
export function plain_words(doc: string): number {
	const o = JSON.parse(doc);
	let n = 0;
	for (const k of Object.keys(o)) {
		const v = o[k];
		if (typeof v === 'string' && /^(\\w+\\s?)*$/.test(v)) n++;
	}
	return n;
}

export function groups(src: string): number {
	let depth = 0;
	for (const ch of src) {
		if (ch === '(') depth++;
		else if (ch === ')' && --depth < 0) throw new Error('unbalanced');
	}
	if (depth !== 0) throw new Error('unbalanced');
	let total = 0;
	for (let i = 0; i < src.length; i++) {
		if (src[i] !== '(') continue;
		let d = 0;
		for (let j = i; j < src.length; j++) {
			if (src[j] === '(') d++;
			else if (src[j] === ')' && --d === 0) {
				total += j - i;
				break;
			}
		}
	}
	return total;
}

export function count_words(text: string): number {
	let n = 0;
	let inside = false;
	for (let i = 0; i < text.length; i++) {
		const space = text[i] === ' ' || text[i] === '\\n';
		if (!space && !inside) n++;
		inside = !space;
	}
	return n;
}`);

const me = new Measurer();

function bench_case<T>(
	name: string,
	fn: (ctx: T) => unknown,
	opts: Partial<BenchCase<T>>
): BenchCase {
	return { name, file: 'planted.bench.ts', fn, ...opts } as unknown as BenchCase;
}

const words = bench_case<{ doc: string }>('plain words', (ctx) => m.plain_words(ctx.doc as never), {
	setup: () => ({
		doc: JSON.stringify({
			title: 'hello world',
			author: 'ann lee',
			tags: 'red blue',
			note: 'ok',
			id: 'a1',
			kind: 'post',
			lang: 'en'
		})
	})
});

const nesting = bench_case<{ src: string }>('groups', (ctx) => m.groups(ctx.src as never), {
	setup: () => ({ src: '(add 1 2) (mul 3 4) (sub 5 6) (div 7 8) (neg 9) (max 1 2 3)' }),
	grammar: 'js'
});

const linear = bench_case<{ text: string }>(
	'count words',
	(ctx) => m.count_words(ctx.text as never),
	{
		setup: () => ({
			text: 'the quick brown fox jumps over the lazy dog\nand a cat naps in a sunny spot all day long'
		})
	}
);

const SEEDS = [1, 2, 3];

test('a regex that backtracks behind valid JSON: the plain mutator misses it, the guided search finds and shrinks it', async () => {
	for (const seed of SEEDS) {
		// the plain search, regex model on: random edits break the JSON or never grow a value
		const plain = await search_case(words, me, { seed, guided: false });
		assert.equal(plain.error, null);
		assert.equal(plain.runaway, undefined, JSON.stringify(plain));
		assert.ok(plain.ratio < 3, `seed ${seed}: plain ${plain.ratio}`);

		const s = await search_case(words, me, { seed });
		assert.equal(s.error, null);
		assert.equal(s.stopped, 'runaway', JSON.stringify(s));
		assert.ok(s.exceeded?.regex?.includes('/^(\\w+\\s?)*$/'), String(s.exceeded?.regex));
		assert.deepEqual(s.finding?.reasons, ['runaway']);
		// shrunk to one member: a run of word characters and one character off
		const p = s.pattern!;
		assert.ok(p.size < p.from_size / 2, JSON.stringify(p));
		const doc = (JSON.parse(p.input) as { doc: string }).doc;
		const values = Object.values(JSON.parse(doc) as Record<string, string>);
		assert.equal(values.length, 1, doc);
		assert.match(values[0], /^(\w)\1{10,}\W$/, doc);
	}
	assert.equal(rt.cap, Infinity);
});

test('a parser quadratic on deep valid nesting: found, shrunk, and grown by nesting', async () => {
	for (const seed of SEEDS) {
		// random edits unbalance the brackets, which the parser rejects
		const plain = await search_case(nesting, me, { seed, guided: false });
		assert.ok(plain.ratio < 1.5, `seed ${seed}: plain ${plain.ratio}`);

		const s = await search_case(nesting, me, { seed });
		assert.equal(s.error, null);
		assert.equal(s.stopped, 'evals');
		assert.ok(s.finding, JSON.stringify(s));
		assert.ok(s.finding.reasons.includes('superlinear'), JSON.stringify(s.finding));
		const p = s.pattern!;
		assert.equal(p.way, 'nest');
		assert.equal(p.class, 'quadratic');
		assert.ok(p.exponent! >= 1.8, JSON.stringify(p));
		assert.ok(p.size < p.from_size, JSON.stringify(p));
		// shrunk to a group or a few (`(m)`): nesting it deeper is what costs
		const src = (JSON.parse(p.input) as { src: string }).src;
		assert.ok(src.startsWith('(') && src.length <= 12, src);
		assert.doesNotThrow(() => m.groups(src as never), 'the shrunk input is valid');
		// the extra steps are in the inner scan
		assert.equal(p.blame[0].fn, `${p.blame[0].at.split(':')[0]} > groups`);
		assert.ok(p.blame.reduce((n, b) => n + b.share, 0) > 0.9, JSON.stringify(p.blame));
	}
});

test('a linear function has no finding', async () => {
	for (const seed of SEEDS) {
		const s = await search_case(linear, me, { seed });
		assert.equal(s.error, null);
		assert.equal(s.finding ?? null, null, JSON.stringify(s));
		assert.ok(s.density!.ratio < 2, JSON.stringify(s.density));
	}
});

test('an input with a getter that throws is searched, and the getter is never read', async () => {
	let reads = 0;
	const app = {
		words: 'one two three four five six',
		get $infer(): never {
			reads++;
			throw new Error('a type-only phantom');
		}
	};
	const c = bench_case<{ app: typeof app }>(
		'phantom',
		(ctx) => m.count_words(ctx.app.words as never),
		{
			setup: () => ({ app })
		}
	);
	const s = await search_case(c, me, { seed: 1, evals: 60 });
	assert.equal(s.error, null);
	assert.equal(reads, 0);
	assert.match(s.input, /"\$infer":"<getter>"/);
});

test('a case past 2e8 / 256 steps still gets its tries: the budget grows with the case', async () => {
	const big = bench_case<{ text: string }>(
		'a long text',
		(ctx) => m.count_words(ctx.text as never),
		{
			setup: () => ({ text: 'one two three four '.repeat(12_000) })
		}
	);
	const s = await search_case(big, me, { seed: 1, evals: 12, shrink: 0 });
	assert.equal(s.error, null);
	assert.ok(s.typical * 256 > 2e8, `typical ${s.typical}`);
	assert.equal(s.evals, 12);
	assert.equal(s.stopped, 'evals');
});

test('the same seed finds the same thing', async () => {
	const strip = (s: SearchCase) => JSON.stringify(s);
	for (const c of [words, nesting, linear]) {
		const a = await search_case(c, me, { seed: 7 });
		const b = await search_case(c, me, { seed: 7 });
		assert.equal(strip(a), strip(b), c.name);
	}
	const md = render_search({
		schema: 'heisenbench-search/2',
		options: {
			evals: 300,
			steps: 2e8,
			ms: 30_000,
			seed: 1,
			size_factor: 1,
			patience: 40,
			shrink: 200,
			flag: 4,
			guided: true,
			regex: true
		},
		cases: [await search_case(nesting, me, { seed: 1 }), await search_case(linear, me, { seed: 1 })]
	});
	assert.match(md, /1 of 2 cases have an input worth a look/);
	assert.match(md, /`groups` \(planted\.bench\.ts\): .*grows quadratic/);
	assert.doesNotMatch(md, /count words/);
});
