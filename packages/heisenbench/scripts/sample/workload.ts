// A small mixed workload for measuring the instrumentation slowdown: a char-level tokenizer, map
// counting, sorting, object building and HTML string building.

export interface Token {
	kind: 'word' | 'num' | 'punct';
	text: string;
}

function is_digit(c: number): boolean {
	return c >= 48 && c <= 57;
}

function is_alpha(c: number): boolean {
	return (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
}

export function tokenize(src: string): Token[] {
	const out: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src.charCodeAt(i);
		if (is_alpha(c)) {
			let j = i + 1;
			while (j < src.length && is_alpha(src.charCodeAt(j))) j++;
			out.push({ kind: 'word', text: src.slice(i, j) });
			i = j;
		} else if (is_digit(c)) {
			let j = i + 1;
			while (j < src.length && is_digit(src.charCodeAt(j))) j++;
			out.push({ kind: 'num', text: src.slice(i, j) });
			i = j;
		} else {
			if (c !== 32 && c !== 10) out.push({ kind: 'punct', text: src[i] });
			i++;
		}
	}
	return out;
}

export function summarize(tokens: Token[]): string {
	const counts = new Map<string, number>();
	for (const t of tokens) {
		if (t.kind !== 'word') continue;
		const k = t.text.toLowerCase();
		counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
		.slice(0, 10)
		.map(([k, v]) => `${k}:${v}`)
		.join(',');
}

interface Row {
	id: number;
	title: string;
	done: boolean;
}

export function rows_of(tokens: Token[]): Row[] {
	const rows: Row[] = [];
	for (let i = 0; i < tokens.length; i += 7) {
		rows.push({ id: i, title: tokens[i].text, done: i % 3 === 0 });
	}
	return rows;
}

export function render(rows: Row[]): string {
	let html = '<ul>';
	for (const r of rows) {
		html += `<li id="r${r.id}" class="${r.done ? 'done' : 'todo'}">${r.title}</li>`;
	}
	return html + '</ul>';
}

export function run(input: string): number {
	const tokens = tokenize(input);
	const summary = summarize(tokens);
	const html = render(rows_of(tokens));
	return summary.length + html.length;
}

export function make_input(words: number): string {
	const vocab = ['alpha', 'beta', 'gamma', 'delta', 'route', 'island', 'region', 'hydrate'];
	let s = '';
	for (let i = 0; i < words; i++) {
		s += vocab[(i * 7) % vocab.length] + (i % 5 === 0 ? ` ${i}, ` : ' ');
		if (i % 12 === 0) s += '.\n';
	}
	return s;
}
