import { parseSync } from 'oxc-parser';

/*
 * Delta debugging (ddmin) over a failing program's lines: drop chunks of lines while the program
 * still parses and still fails the same way, halving the chunk size until no single line can go.
 * Then whole statements: a line that opens a brace is tried away with everything up to the line
 * that closes it.
 */

export type Predicate = (source: string) => Promise<boolean>;

function parses(src: string, lang: 'js' | 'ts'): boolean {
	const r = parseSync(lang === 'ts' ? 'x.ts' : 'x.mjs', src, { sourceType: 'module', lang });
	return r.errors.length === 0;
}

export async function minimize(
	source: string,
	fails: Predicate,
	lang: 'js' | 'ts' = 'js',
	budget = 600
): Promise<string> {
	let lines = source.split('\n');
	let tries = 0;
	const test = async (cand: string[]): Promise<boolean> => {
		if (tries >= budget) return false;
		const src = cand.join('\n');
		if (!parses(src, lang)) return false;
		tries++;
		return fails(src);
	};

	// matching closing line of each opening line, by brace depth
	const blocks = (ls: string[]): Array<[number, number]> => {
		const out: Array<[number, number]> = [];
		const stack: number[] = [];
		for (let i = 0; i < ls.length; i++) {
			const t = ls[i];
			let opens = 0;
			let closes = 0;
			for (const ch of t) {
				if (ch === '{') opens++;
				else if (ch === '}') closes++;
			}
			for (let k = 0; k < closes - opens && stack.length > 0; k++) out.push([stack.pop()!, i]);
			if (opens > closes) stack.push(i);
		}
		return out.sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
	};

	let changed = true;
	while (changed && tries < budget) {
		changed = false;
		for (const [s, e] of blocks(lines)) {
			if (e >= lines.length) continue;
			const cand = [...lines.slice(0, s), ...lines.slice(e + 1)];
			if (await test(cand)) {
				lines = cand;
				changed = true;
				break;
			}
		}
		let n = 2;
		while (lines.length >= 2 && tries < budget) {
			const chunk = Math.ceil(lines.length / n);
			let removed = false;
			for (let i = 0; i < lines.length; i += chunk) {
				const cand = [...lines.slice(0, i), ...lines.slice(i + chunk)];
				if (await test(cand)) {
					lines = cand;
					removed = true;
					changed = true;
					break;
				}
			}
			if (removed) {
				n = Math.max(n - 1, 2);
				continue;
			}
			if (chunk === 1) break;
			n = Math.min(n * 2, lines.length);
		}
	}
	return lines.join('\n');
}
