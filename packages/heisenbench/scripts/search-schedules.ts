/**
 * The worst-case search's two schedules side by side, on the planted cases of the search tests
 * (test/search.test.ts, test/fuzz-regressions.test.ts) and the search answer key (test/search-key).
 *
 *   node scripts/search-schedules.ts [--seeds 10] [--evals 300]
 *
 * For each case and seed, both schedules run with the same budget and seed:
 *   fixed   operators picked by fixed weights (the schedule before the bandit)
 *   bandit  operators picked by Thompson sampling on the density gain they make
 *
 * A planted case's "tries" is the first try whose best input is the planted slow one: the input
 * the code never finishes on (a backtracking regex, a loop that never ends), the input whose
 * doubling grows the steps 2^1.5 times or more (quadratic nesting), or the worst/typical ratio
 * the answer key asks for (5 for insertion sort, 3 for the substring count). "-" is never. The
 * final columns are what each schedule ends with. A linear case has no planted input: it must end
 * with no finding.
 */
import { copyFileSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Measurer, load_cases } from '../src/growth/measure.ts';
import { search_case } from '../src/search/index.ts';
import type { SearchCase, SearchProgress } from '../src/search/index.ts';

function arg(name: string, fallback: number): number {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : Number(process.argv[i + 1]);
}

const seeds = Array.from({ length: arg('seeds', 10) }, (_, i) => i + arg('from', 1));
const evals = arg('evals', 300);

const PLANTED = `
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
}

export function count_down(n: number) {
	let steps = 0;
	while (n !== 0) {
		n--;
		steps++;
	}
	return steps;
}
`;

const here = fileURLToPath(new URL('.', import.meta.url));
const bench_api = join(here, '..', 'src', 'bench.ts');
const BENCHES = `
import { bench } from ${JSON.stringify(bench_api)};
import { plain_words, groups, count_words, count_down } from './planted.ts';
import { order, count, total } from './key.ts';

bench('plain words', ({ doc }) => plain_words(doc), {
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
bench('groups', ({ src }) => groups(src), {
	setup: () => ({ src: '(add 1 2) (mul 3 4) (sub 5 6) (div 7 8) (neg 9) (max 1 2 3)' }),
	grammar: 'js'
});
bench('count down', ({ n }) => count_down(n), { setup: () => ({ n: 5 }) });
bench('count words', ({ text }) => count_words(text), {
	setup: () => ({
		text: 'the quick brown fox jumps over the lazy dog\\nand a cat naps in a sunny spot all day long'
	})
});

const sorted = (): number[] => Array.from({ length: 40 }, (_, i) => i * 7);
bench('order', ({ xs }) => order(xs), { setup: () => ({ xs: sorted() }) });
bench('count', ({ text, pat }) => count(text, pat), {
	setup: () => ({
		text: 'the quick brown fox jumps over the lazy dog and a cat naps in a sunny spot',
		pat: 'aaaaaaab'
	})
});
bench('total', ({ xs }) => total(xs), { setup: () => ({ xs: sorted() }) });
`;

/** When a case's best input is its planted slow one (null: it has none). */
type Hit = ((p: SearchProgress, typical: number) => boolean) | null;
const runaway: Hit = (p) => p.runaway;
const HITS: Record<string, { hit: Hit; what: string; budget?: object }> = {
	'plain words': { hit: runaway, what: 'never finishes (regex backtracks)' },
	groups: {
		hit: (p) => !p.runaway && p.g2 !== null && p.g2 >= Math.pow(2, 1.5),
		what: 'doubling grows steps >= 2^1.5'
	},
	// as in the fuzz regression test
	'count down': { hit: runaway, what: 'never finishes', budget: { evals: 200, steps: 2e5 } },
	order: { hit: (p, t) => p.total / t >= 5, what: 'worst/typical >= 5' },
	count: { hit: (p, t) => p.total / t >= 3, what: 'worst/typical >= 3' },
	'count words': { hit: null, what: 'linear: no finding' },
	total: { hit: null, what: 'linear: no finding' }
};

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'heisenbench-schedules-')));
writeFileSync(join(dir, 'planted.ts'), PLANTED);
copyFileSync(join(here, '..', 'test', 'search-key', 'pr', 'lib.ts.txt'), join(dir, 'key.ts'));
writeFileSync(join(dir, 'planted.bench.ts'), BENCHES);
const list = await load_cases({ files: [join(dir, 'planted.bench.ts')], root: dir });
const m = new Measurer(dir);

interface Run {
	s: SearchCase;
	tries: number | null;
}

async function run(
	name: string,
	seed: number,
	schedule: 'bandit' | 'fixed',
	budget: object
): Promise<Run> {
	const c = list.find((x) => x.name === name)!;
	const events: SearchProgress[] = [];
	const s = await search_case(c, m, { seed, evals, schedule, ...budget }, (p) => events.push(p));
	const hit = HITS[name].hit;
	const first = hit ? events.find((p) => hit(p, s.typical)) : undefined;
	return { s, tries: first ? first.evals : null };
}

/** What the run ended with, in a few words. */
function final(s: SearchCase): string {
	if (s.error) return `error: ${s.error}`;
	if (s.runaway) return 'never finishes';
	const p = s.pattern;
	const grows = p?.exponent != null ? `, exp ${p.exponent}` : '';
	const why = s.finding ? s.finding.reasons.join('+') : 'no finding';
	return `${s.ratio}x steps, ${s.density?.ratio}x density${grows}, ${why}`;
}

/** -1: a is worse than b, 0: as good, 1: better. */
function compare(name: string, a: SearchCase, b: SearchCase): number {
	// never finishing beats a finding; more reasons beat fewer; then the density
	const rank = (s: SearchCase): number[] => {
		if (s.runaway) return [9, 0];
		const d = s.density?.ratio ?? 0;
		if (HITS[name].hit === null) return [s.finding ? 0 : 1, -d];
		return [s.finding?.reasons.length ?? 0, d];
	};
	const x = rank(a);
	const y = rank(b);
	for (let i = 0; i < x.length; i++) {
		// densities within 1% are the same
		const eps = i === 0 ? 0 : 0.01 * Math.max(Math.abs(x[i]), Math.abs(y[i]));
		if (x[i] > y[i] + eps) return 1;
		if (x[i] < y[i] - eps) return -1;
	}
	return 0;
}

const lines: string[] = [
	`Same budget (${evals} tries) and seed for both schedules; seeds ${seeds[0]}-${seeds[seeds.length - 1]}.`,
	'',
	'| case | planted input | seed | tries, fixed | tries, bandit | final, fixed | final, bandit | final |',
	'| --- | --- | --- | --- | --- | --- | --- | --- |'
];
interface Total {
	fixed: Array<number | null>;
	bandit: Array<number | null>;
	/** Final density ratios (Infinity: never finishes). */
	end_fixed: number[];
	end_bandit: number[];
	better: number;
	worse: number;
	/** The fixed schedule against itself on another seed: how often "worse" is only chance. */
	noise_better: number;
	noise_worse: number;
}
const noise = process.argv.includes('--noise');
const end_of = (s: SearchCase): number => (s.runaway ? Infinity : (s.density?.ratio ?? 0));
const totals: Record<string, Total> = {};
const only = process.argv.indexOf('--case');
for (const name of Object.keys(HITS)) {
	if (only !== -1 && process.argv[only + 1] !== name) continue;
	const t: Total = (totals[name] = {
		fixed: [],
		bandit: [],
		end_fixed: [],
		end_bandit: [],
		better: 0,
		worse: 0,
		noise_better: 0,
		noise_worse: 0
	});
	for (const seed of seeds) {
		const budget = HITS[name].budget ?? {};
		const a = await run(name, seed, 'fixed', budget);
		const b = await run(name, seed, 'bandit', budget);
		t.fixed.push(a.tries);
		t.bandit.push(b.tries);
		t.end_fixed.push(end_of(a.s));
		t.end_bandit.push(end_of(b.s));
		const cmp = compare(name, b.s, a.s);
		if (cmp < 0) t.worse++;
		if (cmp > 0) t.better++;
		if (noise) {
			const other = await run(name, seed + 10_000, 'fixed', budget);
			const n = compare(name, other.s, a.s);
			if (n < 0) t.noise_worse++;
			if (n > 0) t.noise_better++;
		}
		lines.push(
			`| ${name} | ${HITS[name].what} | ${seed} | ${a.tries ?? '-'} | ${b.tries ?? '-'} | ${final(a.s)} | ${final(b.s)} | ${cmp > 0 ? 'bandit better' : cmp < 0 ? 'bandit worse' : 'same'} |`
		);
	}
}

const median = (xs: number[]): string => {
	if (xs.length === 0) return '-';
	const s = [...xs].sort((x, y) => x - y);
	const h = s.length >> 1;
	return String(s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2);
};
// a search that never found it spent its whole budget
const spent = (xs: Array<number | null>, budget: number): number =>
	xs.reduce<number>((n, x) => n + (x ?? budget), 0);
const found = (xs: Array<number | null>): number[] => xs.filter((x): x is number => x !== null);
const summary = [
	'| case | found, fixed | found, bandit | median tries, fixed | median tries, bandit | tries over all seeds, fixed | tries over all seeds, bandit |',
	'| --- | --- | --- | --- | --- | --- | --- |'
];
for (const [name, t] of Object.entries(totals)) {
	if (HITS[name].hit === null) continue;
	const budget = (HITS[name].budget as { evals?: number } | undefined)?.evals ?? evals;
	const f = found(t.fixed);
	const b = found(t.bandit);
	summary.push(
		`| ${name} | ${f.length}/${seeds.length} | ${b.length}/${seeds.length} | ${median(f)} | ${median(b)} | ${spent(t.fixed, budget)} | ${spent(t.bandit, budget)} |`
	);
}
// the final input: its density over the setup input's (never finishing counts as the most)
const shown = (x: number): string => (x === Infinity ? 'never finishes' : `${x}x`);
const ends = [
	'| case | median final, fixed | median final, bandit | lowest final, fixed | lowest final, bandit | per seed: bandit better / worse |' +
		(noise ? ' per seed, fixed against itself on another seed: better / worse |' : ''),
	'| --- | --- | --- | --- | --- | --- |' + (noise ? ' --- |' : '')
];
for (const [name, t] of Object.entries(totals)) {
	const lo = (xs: number[]): number => Math.min(...xs);
	const md = (xs: number[]): number => {
		const s = [...xs].sort((x, y) => x - y);
		const h = s.length >> 1;
		return s.length % 2
			? s[h]
			: s[h - 1] === s[h]
				? s[h]
				: Math.round(((s[h - 1] + s[h]) / 2) * 1000) / 1000;
	};
	ends.push(
		`| ${name} | ${shown(md(t.end_fixed))} | ${shown(md(t.end_bandit))} | ${shown(lo(t.end_fixed))} | ${shown(lo(t.end_bandit))} | ${t.better} / ${t.worse} |` +
			(noise ? ` ${t.noise_better} / ${t.noise_worse} |` : '')
	);
}
const only_summary = process.argv.includes('--summary');
const tables = [...summary, '', ...ends];
console.log((only_summary ? tables : [...lines, '', ...tables]).join('\n'));
