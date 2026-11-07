/*
 * A unified diff of two texts (`git apply` reads it), with three lines of context. The texts are
 * a module and its candidate, which differ in a few declarations: the common head and tail are
 * cut first, and the middle is diffed by longest common subsequence.
 */

const CONTEXT = 3;

type Op = { kind: ' ' | '-' | '+'; text: string; a: number; b: number };

function lcs_ops(a: string[], b: string[], a0: number, b0: number): Op[] {
	const n = a.length;
	const m = b.length;
	// lengths of the common subsequence of a[i..] and b[j..]
	const table = new Uint32Array((n + 1) * (m + 1));
	const at = (i: number, j: number) => i * (m + 1) + j;
	for (let i = n - 1; i >= 0; i--)
		for (let j = m - 1; j >= 0; j--)
			table[at(i, j)] =
				a[i] === b[j]
					? table[at(i + 1, j + 1)] + 1
					: Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && a[i] === b[j]) {
			ops.push({ kind: ' ', text: a[i], a: a0 + i, b: b0 + j });
			i++;
			j++;
		} else if (j < m && (i === n || table[at(i, j + 1)] >= table[at(i + 1, j)])) {
			ops.push({ kind: '+', text: b[j], a: a0 + i, b: b0 + j });
			j++;
		} else {
			ops.push({ kind: '-', text: a[i], a: a0 + i, b: b0 + j });
			i++;
		}
	}
	return ops;
}

/** `--- a/<file>` / `+++ b/<file>` and the hunks turning `before` into `after`; '' when they are equal. */
export function unified_diff(file: string, before: string, after: string): string {
	if (before === after) return '';
	const a = before.split('\n');
	const b = after.split('\n');
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (
		tail < a.length - head &&
		tail < b.length - head &&
		a[a.length - 1 - tail] === b[b.length - 1 - tail]
	)
		tail++;
	const ops: Op[] = [];
	for (let i = 0; i < head; i++) ops.push({ kind: ' ', text: a[i], a: i, b: i });
	ops.push(...lcs_ops(a.slice(head, a.length - tail), b.slice(head, b.length - tail), head, head));
	for (let k = tail; k > 0; k--)
		ops.push({ kind: ' ', text: a[a.length - k], a: a.length - k, b: b.length - k });
	const out = [`--- a/${file}`, `+++ b/${file}`];
	let k = 0;
	while (k < ops.length) {
		if (ops[k].kind === ' ') {
			k++;
			continue;
		}
		// a hunk: from CONTEXT lines before this change to CONTEXT lines after the last change within reach
		const start = Math.max(0, k - CONTEXT);
		let end = k;
		for (let x = k; x < ops.length; x++) {
			if (ops[x].kind !== ' ') end = x;
			else if (x - end > 2 * CONTEXT) break;
		}
		const stop = Math.min(ops.length, end + CONTEXT + 1);
		const slice = ops.slice(start, stop);
		const a_lines = slice.filter((o) => o.kind !== '+').length;
		const b_lines = slice.filter((o) => o.kind !== '-').length;
		const a_start = slice[0].a + (a_lines > 0 ? 1 : 0);
		const b_start = slice[0].b + (b_lines > 0 ? 1 : 0);
		out.push(`@@ -${a_start},${a_lines} +${b_start},${b_lines} @@`);
		for (const o of slice) out.push(o.kind + o.text);
		k = stop;
	}
	return out.join('\n') + '\n';
}
