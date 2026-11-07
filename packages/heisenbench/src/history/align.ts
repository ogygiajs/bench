/*
 * Pairing edited lines by their text: an edit that keeps a line recognisable (`line_at(src, i)` ->
 * `line_at(newlines, i)`) keeps its history. Lines are compared by the character pairs they share
 * (the Dice coefficient of their bigrams, whitespace collapsed), and paired in order: the pairs
 * that score most in total, each at least `min`, never crossing.
 */

/** Pairs of lines that are this alike or more are one line, edited. */
export const MIN_LIKENESS = 0.5;

/** Longer lists than this are not aligned (the table is their product). */
const MAX_CELLS = 250_000;

function squash(s: string): string {
	return s.trim().replace(/\s+/g, ' ');
}

function bigrams(s: string): Map<string, number> {
	const m = new Map<string, number>();
	for (let i = 0; i + 1 < s.length; i++) {
		const g = s.slice(i, i + 2);
		m.set(g, (m.get(g) ?? 0) + 1);
	}
	return m;
}

/** How alike two lines are, 0..1 (1: the same text, whitespace aside). */
export function likeness(a: string, b: string): number {
	const x = squash(a);
	const y = squash(b);
	if (x === y) return x === '' ? 0 : 1;
	if (x.length < 2 || y.length < 2) return 0;
	const gx = bigrams(x);
	const gy = bigrams(y);
	let both = 0;
	for (const [g, n] of gx) both += Math.min(n, gy.get(g) ?? 0);
	return (2 * both) / (x.length - 1 + (y.length - 1));
}

/** Index pairs [old, new], in order, of the lines that are one line edited. */
export function align_lines(
	old_lines: string[],
	new_lines: string[],
	min = MIN_LIKENESS
): Array<[number, number]> {
	const n = old_lines.length;
	const m = new_lines.length;
	if (n === 0 || m === 0 || n * m > MAX_CELLS) return [];
	const score = new Float64Array((n + 1) * (m + 1));
	const at = (i: number, j: number) => i * (m + 1) + j;
	const like = new Float64Array(n * m);
	for (let i = 0; i < n; i++)
		for (let j = 0; j < m; j++) like[i * m + j] = likeness(old_lines[i], new_lines[j]);
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			const l = like[(i - 1) * m + (j - 1)];
			const take = l >= min ? score[at(i - 1, j - 1)] + l : -1;
			score[at(i, j)] = Math.max(score[at(i - 1, j)], score[at(i, j - 1)], take);
		}
	}
	const pairs: Array<[number, number]> = [];
	for (let i = n, j = m; i > 0 && j > 0;) {
		const l = like[(i - 1) * m + (j - 1)];
		if (l >= min && score[at(i, j)] === score[at(i - 1, j - 1)] + l) {
			pairs.push([i - 1, j - 1]);
			i--;
			j--;
		} else if (score[at(i, j)] === score[at(i - 1, j)]) i--;
		else j--;
	}
	return pairs.reverse();
}
