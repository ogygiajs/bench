/*
 * Delta debugging (Zeller and Hildebrandt, "Simplifying and Isolating Failure-Inducing Input",
 * 2002): from a set of changes whose test fails, a smaller set whose test still fails, so that
 * leaving out any one of its changes passes (1-minimal).
 *
 * The test has three outcomes. `fail` is what the search keeps; `pass` is not; `unresolved` is a
 * candidate that could not be judged at all (here: a tree that did not load or run). Unresolved
 * counts as "not fail", the standard handling: the search goes on with finer parts, and a set of
 * changes that only work together is kept together.
 *
 * Each round's candidates go to the tester as one list, in the order the sequential algorithm
 * would try them; the tester answers with the first failing one. It may judge several at once,
 * and the answer is the same as one at a time, so the result never depends on how many run side
 * by side. It may also say the budget ran out: the search then stops with the smallest failing
 * set it has, which is still an answer, only not minimal yet.
 */

export type Outcome = 'fail' | 'pass' | 'unresolved';

export interface Tester<T> {
	/** The index of the first candidate whose test fails (-1: none), or null: out of budget. */
	first_failing(candidates: T[][]): Promise<number | null>;
}

export interface DdminResult<T> {
	/** The smallest failing set found (the whole input when nothing smaller fails). */
	set: T[];
	/** False when the budget ran out before the set was 1-minimal. */
	complete: boolean;
}

/** `items` cut into `n` parts as even as can be, in order. */
export function split<T>(items: readonly T[], n: number): T[][] {
	const out: T[][] = [];
	let at = 0;
	for (let i = 0; i < n; i++) {
		const size = Math.floor((items.length - at) / (n - i));
		out.push(items.slice(at, at + size));
		at += size;
	}
	return out.filter((p) => p.length > 0);
}

/**
 * A 1-minimal failing subset of `items`, whose test must fail (the caller checked it). The empty
 * set must not fail either: then there is nothing to look for.
 */
export async function ddmin<T>(items: readonly T[], tester: Tester<T>): Promise<DdminResult<T>> {
	let c = [...items];
	let n = 2;
	while (c.length >= 2) {
		n = Math.min(n, c.length);
		const parts = split(c, n);
		const sub = await tester.first_failing(parts);
		if (sub === null) return { set: c, complete: false };
		if (sub >= 0) {
			c = parts[sub];
			n = 2;
			continue;
		}
		// With two parts each complement is the other part, already tested.
		if (parts.length > 2) {
			const complements = parts.map((p) => c.filter((x) => !p.includes(x)));
			const comp = await tester.first_failing(complements);
			if (comp === null) return { set: c, complete: false };
			if (comp >= 0) {
				c = complements[comp];
				n = Math.max(n - 1, 2);
				continue;
			}
		}
		if (n >= c.length) break;
		n = Math.min(n * 2, c.length);
	}
	return { set: c, complete: true };
}
