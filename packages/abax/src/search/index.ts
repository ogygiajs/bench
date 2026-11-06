import type { BenchCase } from '../bench.ts';
import { Measurer, load_cases } from '../growth/measure.ts';
import type { LoadOptions } from '../growth/measure.ts';
import { clone, input_size } from '../growth/scale.ts';
import { Rng, mutate } from './mutate.ts';

/*
 * Slow-input search (spec 9). Starting from the case's own input, mutate it and keep a mutation
 * when it costs at least as many steps (hill climbing on the step counter, restarting from the
 * worst input found after a stretch without progress). The input never grows past its starting
 * size (times `size_factor`): growth is `abax growth`'s question, this one asks what SHAPE of input
 * of the same size is slowest.
 *
 * Bounded by evaluations, by total steps counted and by wall time. The first two are
 * deterministic; when the time budget ends a search the result says so.
 *
 * Built-ins are priced by input size, so a regular expression that backtracks badly costs no more
 * steps than one that does not: catastrophic regexes are not found by this search.
 */

export const SEARCH_SCHEMA = 'abax-search/1';

export interface SearchCase {
	name: string;
	file: string;
	/** Steps on the case's own input. */
	typical: number;
	/** Most steps found. */
	worst: number;
	/** worst / typical. */
	ratio: number;
	evals: number;
	/** What ended the search. */
	stopped: 'evals' | 'steps' | 'time';
	/** The worst input, as JSON (shortened). */
	input: string;
	/** Mutations from the case's input to the worst one. */
	mutations: string[];
	error: string | null;
}

export interface SearchReport {
	schema: typeof SEARCH_SCHEMA;
	options: Required<SearchBudget>;
	cases: SearchCase[];
}

export interface SearchBudget {
	/** Inputs tried (default 300). */
	evals?: number;
	/** Steps counted over the whole search (default 2e8). */
	steps?: number;
	/** Wall time in ms (default 30000). */
	ms?: number;
	seed?: number;
	/** Largest input size, relative to the starting input (default 1). */
	size_factor?: number;
	/** Evaluations without progress before restarting from the worst input (default 40). */
	patience?: number;
}

export interface SearchOptions extends LoadOptions, SearchBudget {
	log?: (line: string) => void;
}

const DEFAULTS: Required<SearchBudget> = {
	evals: 300,
	steps: 2e8,
	ms: 30_000,
	seed: 1,
	size_factor: 1,
	patience: 40
};

function preview(v: unknown, max = 400): string {
	let s: string;
	try {
		s =
			JSON.stringify(v, (_k, x: unknown) => {
				if (x instanceof Map) return { Map: [...x.entries()] };
				if (x instanceof Set) return { Set: [...x.values()] };
				if (typeof x === 'number' && !Number.isFinite(x)) return String(x);
				if (typeof x === 'bigint') return `${x}n`;
				return x;
			}) ?? String(v);
	} catch {
		s = String(v);
	}
	return s.length > max ? s.slice(0, max) + '...' : s;
}

/** Search one case for the input of its size that costs the most steps. */
export async function search_case(
	c: BenchCase,
	m: Measurer,
	budget: SearchBudget = {}
): Promise<SearchCase> {
	const o = { ...DEFAULTS, ...budget };
	const out: SearchCase = {
		name: c.name,
		file: c.file,
		typical: 0,
		worst: 0,
		ratio: 1,
		evals: 0,
		stopped: 'evals',
		input: '',
		mutations: [],
		error: null
	};
	const started = Date.now();
	try {
		const seed_input = c.setup ? await c.setup() : undefined;
		const limit = input_size(seed_input) * o.size_factor;
		const first = await m.once(c, seed_input, 'record');
		out.typical = first.steps;
		let spent = first.steps;
		const rng = new Rng(o.seed);
		let cur = {
			input: (c.setup ? await c.setup() : undefined) as unknown,
			steps: first.steps,
			trail: [] as string[]
		};
		let best = cur;
		let stale = 0;
		let tries = 0;
		while (true) {
			if (out.evals >= o.evals) {
				out.stopped = 'evals';
				break;
			}
			if (spent >= o.steps) {
				out.stopped = 'steps';
				break;
			}
			if (Date.now() - started >= o.ms) {
				out.stopped = 'time';
				break;
			}
			const next = mutate(cur.input, rng);
			if (input_size(next.input) > limit) {
				// only growing mutations left (an empty input): count them, so the search ends
				if (++tries > o.evals * 20) break;
				continue;
			}
			out.evals++;
			let steps: number;
			try {
				// the case may change its input: count on a copy, keep the original
				steps = (await m.once(c, clone(next.input), 'replay')).steps;
			} catch {
				stale++;
				continue; // an input the code rejects is not a slow input
			}
			spent += steps;
			const trail = [...cur.trail, next.what].slice(-20);
			if (steps >= cur.steps) cur = { input: next.input, steps, trail };
			if (steps > best.steps) {
				best = { input: next.input, steps, trail };
				stale = 0;
			} else if (++stale >= o.patience) {
				cur = best;
				stale = 0;
			}
		}
		out.worst = best.steps;
		out.ratio = out.typical > 0 ? Math.round((best.steps / out.typical) * 1000) / 1000 : 1;
		out.input = preview(best.input);
		out.mutations = best.trail;
	} catch (e) {
		out.error = e instanceof Error ? e.message : String(e);
	}
	return out;
}

export async function run_search(opts: SearchOptions): Promise<SearchReport> {
	const log = opts.log ?? (() => {});
	const list = await load_cases(opts);
	const m = new Measurer(opts.root);
	const options = { ...DEFAULTS };
	for (const k of Object.keys(DEFAULTS) as Array<keyof SearchBudget>) {
		if (opts[k] !== undefined) options[k] = opts[k]!;
	}
	const report: SearchReport = { schema: SEARCH_SCHEMA, options, cases: [] };
	for (const c of list) {
		const s = await search_case(c, m, options);
		report.cases.push(s);
		log(
			s.error
				? `FAILED   ${c.name}: ${s.error}`
				: `ok       ${c.name}  worst ${Math.round(s.worst)} vs typical ${Math.round(s.typical)} steps (${s.ratio}x, ${s.evals} inputs, stopped by ${s.stopped})`
		);
	}
	return report;
}

export interface SearchFinding {
	case: string;
	text: string;
}

/** A worst case at least `flag` times typical in the PR, and at least twice the base's ratio. */
export function diff_search(base: SearchReport, pr: SearchReport, flag = 4): SearchFinding[] {
	const out: SearchFinding[] = [];
	const by_name = new Map(base.cases.map((c) => [c.name, c]));
	for (const p of pr.cases) {
		if (p.error) continue;
		const b = by_name.get(p.name);
		const base_ratio = b && !b.error ? b.ratio : 1;
		if (p.ratio >= flag && p.ratio >= 2 * base_ratio) {
			out.push({
				case: p.name,
				text: `${'`'}${p.name}${'`'} has a slow input: ${Math.round(p.worst)} steps vs ${Math.round(p.typical)} typical (${p.ratio}x, base ${base_ratio}x)`
			});
		}
	}
	return out;
}
