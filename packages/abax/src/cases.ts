/**
 * Cases of two runs, paired. A case is its bench file plus its name: two files may each have a
 * case called `small`. A case whose file moved is still paired by its name, when that name is
 * unique on both sides among the cases left over.
 */
export interface Paired<T> {
	pairs: Array<[T, T]>;
	only_base: T[];
	only_pr: T[];
}

export function case_key(c: { file: string; name: string }): string {
	return `${c.file} > ${c.name}`;
}

export function pair_cases<T extends { file: string; name: string }>(
	base: readonly T[],
	pr: readonly T[]
): Paired<T> {
	const pr_by_key = new Map<string, T>();
	for (const c of pr) if (!pr_by_key.has(case_key(c))) pr_by_key.set(case_key(c), c);
	const pairs: Array<[T, T]> = [];
	const used = new Set<T>();
	const left: T[] = [];
	for (const b of base) {
		const p = pr_by_key.get(case_key(b));
		if (p && !used.has(p)) {
			pairs.push([b, p]);
			used.add(p);
		} else {
			left.push(b);
		}
	}
	const rest = pr.filter((c) => !used.has(c));
	const count = (list: readonly T[], name: string): number =>
		list.reduce((n, c) => n + (c.name === name ? 1 : 0), 0);
	const only_base: T[] = [];
	for (const b of left) {
		const p = rest.find((c) => c.name === b.name);
		if (p && !used.has(p) && count(left, b.name) === 1 && count(rest, b.name) === 1) {
			pairs.push([b, p]);
			used.add(p);
		} else {
			only_base.push(b);
		}
	}
	return { pairs, only_base, only_pr: pr.filter((c) => !used.has(c)) };
}
