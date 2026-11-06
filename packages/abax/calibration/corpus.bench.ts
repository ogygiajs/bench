import { bench } from '../src/bench.ts';
import * as c from './corpus.ts';

const SIZES = [8, 32, 128, 512];

function numbers(n: number): number[] {
	return Array.from({ length: n }, (_, i) => (i * 7919) % 1009);
}

function record(n: number): Record<string, number> {
	return Object.fromEntries(Array.from({ length: n }, (_, i) => ['k' + i, i]));
}

for (const n of SIZES) {
	bench(`reference @${n}`, () => c.reference(n));
	bench(`points @${n}`, () => c.points(n));
	bench(`objects @${n}`, () => c.objects(n));
	bench(`writes @${n}`, () => c.writes(n));
	bench(`strings @${n}`, () => c.strings(n));
	bench(`iterate @${n}`, ({ xs }) => c.iterate(xs), { setup: () => ({ xs: numbers(n) }) });
	bench(`keys @${n}`, ({ o }) => c.keys(o), { setup: () => ({ o: record(n) }) });
	bench(`logic @${n}`, ({ xs }) => c.logic(xs), {
		setup: () => ({
			xs: Array.from({ length: n }, (_, i) => (i % 3 === 0 ? {} : { a: i, b: { c: i } }))
		})
	});
	bench(`closures @${n}`, () => c.closures(n));
	bench(`sorting @${n}`, ({ xs }) => c.sorting(xs), { setup: () => ({ xs: numbers(n) }) });
	bench(`mapping @${n}`, ({ xs }) => c.mapping(xs), { setup: () => ({ xs: numbers(n) }) });
	bench(`json @${n}`, ({ xs }) => c.json(xs), { setup: () => ({ xs: numbers(n) }) });
	bench(`maps @${n}`, () => c.maps(n));
	bench(`generators @${n}`, () => c.generators(n));
	bench(`throws @${n}`, () => c.throws(n));
	bench(`spreads @${n}`, ({ xs }) => c.spreads(xs), { setup: () => ({ xs: numbers(n) }) });
}

for (const n of [8, 12, 16, 20]) bench(`fib @${n}`, () => c.fib(n));
