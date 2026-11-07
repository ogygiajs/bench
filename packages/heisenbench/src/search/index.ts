import type { BenchCase } from '../bench.ts';
import { code } from '../md.ts';
import { Measurer, load_cases } from '../growth/measure.ts';
import type { LoadOptions } from '../growth/measure.ts';
import { clone, input_size } from '../growth/scale.ts';
import { fit_growth, growth_label, is_superlinear, SUPERLINEAR_POWER } from '../growth/fit.ts';
import type { GrowthClass } from '../growth/fit.ts';
import { build_case_report } from '../report.ts';
import type { CaseReport } from '../report.ts';
import { GrammarPlan, Rng, arms_of, mutate, mutate_arm, mutate_guided } from './mutate.ts';
import { Bandit, density_reward } from './bandit.ts';
import type { ArmStat } from './bandit.ts';
import { RegexModel, RegexRunawayError } from './regex.ts';
import type { RegexRun, RegexUse } from './regex.ts';
import { blame, emptied, growers, shrink } from './shrink.ts';
import type { Blame, GrowWay } from './shrink.ts';
import { StepCapError } from '../runtime/index.ts';
import type { Snapshot } from '../runtime/index.ts';

/*
 * Worst-case input search (spec 9). Starting from the case's own input, the search changes one
 * place at a time and steers toward the most work per unit of input: steps per input unit (chars,
 * elements, keys) past what the case costs on an emptied input, times how much faster than linear
 * the input's work grows when it is made twice as big. Strings are edited by their grammar
 * (grammar.ts, mutate.ts) so they stay valid; regex matches run on a model of V8's matcher
 * (regex.ts), so backtracking counts as work. Inputs that reach a block no input reached before,
 * or a block's count in a new power of two (the runtime's per-block counts), or a new density
 * high, are kept in a corpus: the search climbs from the current input and, after `patience`
 * tries without progress, restarts from the best input or one from the corpus.
 *
 * The winner is then shrunk while it keeps its density (delta debugging, shrink.ts), and the shrunk
 * input is grown 1, 2, 4 and 8 times in each way it can grow (repeated, nested deeper, the case's
 * own `scale`): the fitted exponent says how its work grows, and line blame says where the extra
 * steps go. A finding is an input whose density is at least `flag` times the setup input's, one
 * whose work grows superlinearly, or one the code may never finish on.
 *
 * The input never grows past its starting size (times `size_factor`) during the search. Bounded
 * by evaluations, by total steps counted and by wall time; the first two are deterministic, and
 * when the time budget ends a search the result says so. Each try runs under its own step cap
 * (TRY_CAP_FACTOR times the typical steps): an input on which the code would run forever ends its
 * run there and is reported as exceeding the cap at its size (`runaway`), never as the worst
 * input. A try that would need more than what is left of the budget is not run. Shrinking and
 * growing the winner have as many steps again.
 *
 * Which edit each try makes is a bandit's choice (bandit.ts): every mutation operator is an arm,
 * rewarded by the density gain its edits make, so the tries go to the operators that keep finding
 * denser inputs. `schedule: 'fixed'` is the schedule before it: an operator picked by fixed
 * weights (one try in six a plain edit anywhere).
 *
 * `guided: false` is the plain search: random mutations (mutate.ts), the most steps wins, no
 * corpus, no shrinking or growing.
 */

export const SEARCH_SCHEMA = 'heisenbench-search/2';

/**
 * Each try's step cap: TRY_CAP_FACTOR times the typical steps, at least TRY_CAP_MIN, and for a big
 * case at most TRY_CAP_MAX (a minute or so of counting) unless that is below TRY_CAP_FLOOR times.
 */
export const TRY_CAP_FACTOR = 256;
export const TRY_CAP_MIN = 1e4;
export const TRY_CAP_MAX = 4e9;
export const TRY_CAP_FLOOR = 16;
/** The step budget is at least this many times the typical steps (so 300 tries fit a big case). */
export const STEPS_PER_TYPICAL = 600;
/** A grown run's cap: this many times the shrunk input's steps times k^3 (past it: steeper than cubic). */
const GROW_CAP_FACTOR = 4;
/** Sizes the shrunk input is grown to. */
export const GROW_SIZES = [1, 2, 4, 8];
/** Corpus entries kept (the lowest scores go first). */
const CORPUS_MAX = 48;
/** The shrunk input keeps at least this share of the winner's density. */
const SHRINK_KEEP = 0.95;
/** A doubled input costing this many times more is worth growing (2^SUPERLINEAR_POWER). */
const GROWTH2_FLAG = Math.pow(2, SUPERLINEAR_POWER);

export interface SearchPattern {
	/** The shrunk input, as JSON (shortened), and its size before and after shrinking. */
	input: string;
	size: number;
	from_size: number;
	/** Inputs tried while shrinking. */
	shrink_evals: number;
	/** How it was grown: repeated, nested deeper, or by the case's own `scale`. */
	way: GrowWay | null;
	/** Input sizes and steps (past the emptied input's) at each grown size. */
	sizes: number[];
	steps: number[];
	class: GrowthClass | null;
	/** log-log slope between the two largest sizes (1 linear, 2 quadratic). */
	exponent: number | null;
	/** The grown size whose run went past its cap (steeper than cubic), if one did. */
	exceeded_at?: number;
	/** Where the extra steps go at the largest size. */
	blame: Blame[];
}

export type FindingReason = 'dense' | 'superlinear' | 'runaway';

export interface SearchCase {
	name: string;
	file: string;
	/** Steps on the case's own input (with the regex model's backtracking). */
	typical: number;
	/** Steps of the worst input found. */
	worst: number;
	/** worst / typical. */
	ratio: number;
	evals: number;
	/** The try that found the worst input. */
	best_at?: number;
	/**
	 * The first try that found an input worth a look (its density `flag` times the setup input's,
	 * doubling it grew the steps 2^1.5 times or more, or it never finished), or null.
	 */
	found_at?: number | null;
	/** The bandit schedule: how often each operator ran, and how often it made the input denser. */
	arms?: ArmStat[];
	/** What ended the search (`runaway`: a try went past its own cap). */
	stopped: 'evals' | 'steps' | 'time' | 'runaway';
	/** The worst input, as JSON (shortened). */
	input: string;
	/** Mutations from the case's input to the worst one. */
	mutations: string[];
	/** A try went past its own step cap: it may never end (`exceeded` says on what). */
	runaway?: boolean;
	/** The input that exceeded the cap, its size, and the cap (and the regex, when one ran away). */
	exceeded?: { size: number; cap: number; input: string; regex?: string };
	/** Input size of the setup input and of the worst one. */
	size?: { setup: number; worst: number };
	/** Steps per input unit past the emptied input's, of the setup input and the worst one. */
	density?: { setup: number; worst: number; ratio: number };
	/** Steps (past the emptied input's) of the worst input made twice as big, over its own. */
	growth2?: number | null;
	/** Inputs kept, and the blocks and block-count powers of two they reached. */
	corpus?: number;
	coverage?: number;
	/** The grammar each string place was edited by (`page.body -> html`). */
	grammars?: Record<string, string>;
	/** Regex backtracking on the worst input, and the patterns the model left to V8. */
	regex?: { extra: number; uses: RegexUse[]; unsupported: string[] };
	pattern?: SearchPattern | null;
	/** Worth a human's attention: why, in one line. */
	finding?: { reasons: FindingReason[]; text: string } | null;
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
	/** Inputs tried while shrinking the winner (default 200; 0 keeps it as found). */
	shrink?: number;
	/** A finding's density, relative to the setup input's (default 4). */
	flag?: number;
	/** Grammar edits, the density objective, the corpus, shrinking and growing (default true). */
	guided?: boolean;
	/** Count regex backtracking with the matcher model (default true). */
	regex?: boolean;
	/**
	 * How a guided try picks its edit: `bandit` (the operators that keep making the input denser
	 * run more) or `fixed` (fixed weights, the schedule before the bandit). Default `bandit`.
	 */
	schedule?: 'bandit' | 'fixed';
}

export interface SearchOptions extends LoadOptions, SearchBudget {
	log?: (line: string) => void;
}

/** The search's best so far, each time it changes (for comparing schedules). */
export interface SearchProgress {
	/** The try that found it. */
	evals: number;
	total: number;
	density: number;
	g2: number | null;
	/** It went past its cap: the search ends here. */
	runaway: boolean;
}

const DEFAULTS: Required<SearchBudget> = {
	evals: 300,
	steps: 2e8,
	ms: 30_000,
	seed: 1,
	size_factor: 1,
	patience: 40,
	shrink: 200,
	flag: 4,
	guided: true,
	regex: true,
	schedule: 'bandit'
};

/** The input's data, never its getters (shown as `<getter>`), for the JSON preview. */
function data_view(v: unknown, seen = new Set<unknown>()): unknown {
	if (v === null || typeof v !== 'object' || seen.has(v)) return v;
	if (Array.isArray(v)) {
		seen.add(v);
		return v.map((x) => data_view(x, seen));
	}
	const p = Object.getPrototypeOf(v);
	if (p !== Object.prototype && p !== null) return v;
	seen.add(v);
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(v)) {
		const d = Object.getOwnPropertyDescriptor(v, k);
		out[k] = d && 'value' in d ? data_view(d.value, seen) : '<getter>';
	}
	return out;
}

function preview(v: unknown, max = 400): string {
	let s: string;
	try {
		s =
			JSON.stringify(data_view(v), (_k, x: unknown) => {
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

function r3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

/** One counted run: the counter's steps, the regex model's extra work, and the snapshot. */
interface Counted {
	total: number;
	snap: Snapshot;
	regex: RegexRun | null;
}

interface Entry {
	input: unknown;
	total: number;
	size: number;
	density: number;
	/** Steps at 2x over steps at 1x (past the emptied input's), when measured. */
	g2: number | null;
	score: number;
	trail: string[];
}

/** How much a doubled input's growth adds to the score: 1 when linear, more when faster. */
function growth_bonus(g2: number | null): number {
	if (g2 === null) return 1;
	return Math.min(8, Math.max(1, g2 / 2));
}

/** Search one case for the input that costs the most work per unit of input. */
export async function search_case(
	c: BenchCase,
	m: Measurer,
	budget: SearchBudget = {},
	watch?: (p: SearchProgress) => void
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
	const model = o.regex ? new RegexModel(m.rt) : null;
	const counted_case = model ? model.wrap(c) : c;
	const count = async (
		input: unknown,
		mode: 'record' | 'replay',
		cap: number
	): Promise<Counted> => {
		model?.begin();
		let snap: Snapshot;
		let regex: RegexRun | null = null;
		try {
			// the case may change its input: count on a copy, keep the original
			snap = await m.once(counted_case, clone(input), mode, cap);
		} finally {
			if (model) regex = model.end();
		}
		return { total: snap.steps + (regex?.extra ?? 0), snap, regex };
	};
	try {
		const seed_input = c.setup ? await c.setup() : undefined;
		const seed_size = input_size(seed_input);
		const limit = seed_size * o.size_factor;
		const first = await count(seed_input, 'record', Infinity);
		out.typical = first.total;
		let spent = first.total;
		const try_cap = Math.max(
			TRY_CAP_MIN,
			Math.min(TRY_CAP_FACTOR * first.total, Math.max(TRY_CAP_MAX, TRY_CAP_FLOOR * first.total))
		);
		// a big case gets a budget its tries fit in: STEPS_PER_TYPICAL times its own steps
		const budget_steps = Math.max(o.steps, STEPS_PER_TYPICAL * first.total, 2 * try_cap);
		const rng = new Rng(o.seed);
		const plan = new GrammarPlan(c.grammar);

		// What the case costs on next to nothing: density counts the steps past it.
		let floor = 0;
		if (o.guided) {
			try {
				const e = await count(emptied(seed_input), 'replay', try_cap);
				spent += e.total;
				floor = Math.min(e.total, first.total);
			} catch (e) {
				if (e instanceof StepCapError) spent += try_cap;
				// an emptied input the code rejects: no floor
			}
		}
		// an input smaller than half the setup's counts as half its size: a tiny input whose few
		// steps are mostly the case's fixed cost is not dense
		const min_size = Math.max(1, seed_size / 2);
		const density_of = (total: number, size: number): number =>
			Math.max(total - floor, 0) / Math.max(min_size, size);

		const seed_entry: Entry = {
			input: seed_input,
			total: first.total,
			size: seed_size,
			density: density_of(first.total, seed_size),
			g2: null,
			score: 0,
			trail: []
		};
		seed_entry.score = seed_entry.density;
		const setup_snap = first.snap;
		let best_snap = first.snap;
		let best_regex = first.regex;

		// Coverage: every block reached, and the highest power of two of its count.
		const seen = new Map<number, number>();
		const cover = (snap: Snapshot): number => {
			let fresh = 0;
			for (let mi = 0; mi < snap.modules.length; mi++) {
				const blocks = snap.modules[mi].c;
				for (let bi = 0; bi < blocks.length; bi++) {
					const n = blocks[bi];
					if (n === 0) continue;
					const bucket = n >= 1 ? 31 - Math.clz32(Math.min(n, 2 ** 31 - 1)) : 0;
					const key = mi * 2 ** 21 + bi;
					const had = seen.get(key);
					if (had === undefined || bucket > had) {
						seen.set(key, bucket);
						fresh++;
					}
				}
			}
			return fresh;
		};
		cover(first.snap);

		/**
		 * Steps at 2x over steps at 1x (both past the emptied input's), the most over the first two
		 * ways the input grows. `afford(cap)` says whether a run of that cap may start, `charge`
		 * books what it cost.
		 */
		const doubled = async (
			input: unknown,
			total: number,
			afford: (cap: number) => boolean,
			charge: (steps: number) => void
		): Promise<number | null> => {
			let g: number | null = null;
			const base = Math.max(total - floor, 1);
			for (const grower of growers(input, plan, c.scale).slice(0, 2)) {
				// a doubled input under the same cap: past it, it is far past quadratic anyway
				const cap = try_cap;
				if (!afford(cap)) break;
				let ratio: number;
				try {
					const r = await count(grower.make(2), 'replay', cap);
					charge(r.total);
					ratio = Math.max(r.total - floor, 0) / base;
				} catch (err) {
					// a grown input the code rejects tells nothing (and its steps are not known)
					const capped = err instanceof StepCapError;
					charge(capped ? cap : 0);
					if (!capped) continue;
					ratio = cap / base;
				}
				g = g === null ? ratio : Math.max(g, ratio);
			}
			return g;
		};
		const growth2 = (e: Entry): Promise<number | null> =>
			doubled(
				e.input,
				e.total,
				(cap) => budget_steps - spent >= cap && out.evals < o.evals,
				(steps) => {
					out.evals++;
					spent += steps;
				}
			);

		let corpus: Entry[] = [seed_entry];
		let cur = seed_entry;
		let best = seed_entry;
		let best_density = seed_entry.density;
		let runaway: { input: unknown; trail: string[] } | null = null;
		let stale = 0;
		let tries = 0;
		const bandit = o.guided && o.schedule === 'bandit' ? new Bandit() : null;
		// worth a look: what makes a finding (dense, steep when doubled), on any try
		let found_at: number | null = null;
		const worth = (e: Entry): boolean =>
			(seed_entry.density > 0 ? e.density >= o.flag * seed_entry.density : e.density > 0) ||
			(e.g2 !== null && e.g2 >= GROWTH2_FLAG);
		const new_best = (e: Entry, at: number): void => {
			out.best_at = at;
			watch?.({ evals: at, total: e.total, density: e.density, g2: e.g2, runaway: false });
		};
		while (true) {
			if (out.evals >= o.evals) {
				out.stopped = 'evals';
				break;
			}
			if (spent >= budget_steps) {
				out.stopped = 'steps';
				break;
			}
			if (Date.now() - started >= o.ms) {
				out.stopped = 'time';
				break;
			}
			const room = { size: cur.size, min: 0, max: limit };
			let arm: string | null = null;
			let next: { input: unknown; what: string } | null;
			if (!o.guided) next = mutate(cur.input, rng);
			else if (bandit) {
				const arms = arms_of(cur.input, plan);
				arm = arms.length > 0 ? bandit.pick(arms, rng) : null;
				next = arm
					? mutate_arm(
							cur.input,
							arm,
							rng,
							plan,
							room,
							corpus.slice(-16).map((x) => x.input)
						)
					: null;
			} else {
				next = mutate_guided(
					cur.input,
					rng,
					plan,
					room,
					corpus.slice(-16).map((x) => x.input)
				);
			}
			if (next === null || input_size(next.input) > limit) {
				// an edit that does not fit pays nothing
				if (arm) bandit!.miss(arm);
				// only growing mutations left (an empty input): count them, so the search ends
				if (++tries > o.evals * 20) break;
				continue;
			}
			// Every try has its own cap, a multiple of the typical steps. A try that would run past
			// what is left of the budget instead is not run: hitting the leftover is not a finding.
			if (budget_steps - spent < try_cap) {
				out.stopped = 'steps';
				break;
			}
			out.evals++;
			const at = out.evals;
			let r: Counted;
			try {
				r = await count(next.input, 'replay', try_cap);
			} catch (e) {
				if (e instanceof StepCapError) {
					if (arm) bandit!.reward(arm, 1);
					if (o.guided) found_at ??= at;
					watch?.({ evals: at, total: try_cap, density: 0, g2: null, runaway: true });
					// past its own cap: it may never end. Said as such, never the worst input.
					spent += try_cap;
					out.runaway = true;
					out.exceeded = {
						size: input_size(next.input),
						cap: try_cap,
						input: preview(next.input)
					};
					if (e instanceof RegexRunawayError) out.exceeded.regex = e.message;
					runaway = { input: next.input, trail: [...cur.trail, next.what].slice(-20) };
					out.stopped = 'runaway';
					break;
				}
				if (arm) bandit!.reward(arm, 0);
				stale++;
				continue; // an input the code rejects is not a slow input
			}
			spent += r.total;
			const size = input_size(next.input);
			const entry: Entry = {
				input: next.input,
				total: r.total,
				size,
				density: density_of(r.total, size),
				g2: null,
				score: 0,
				trail: [...cur.trail, next.what].slice(-20)
			};
			if (!o.guided) {
				// the plain search: the most steps wins
				entry.score = r.total;
				if (r.total >= cur.total) cur = entry;
				if (r.total > best.total) {
					best = entry;
					best_snap = r.snap;
					best_regex = r.regex;
					new_best(entry, at);
					stale = 0;
				} else if (++stale >= o.patience) {
					cur = best;
					stale = 0;
				}
				continue;
			}
			// the operator's reward: how much denser it made the input it edited
			if (arm) bandit!.reward(arm, density_reward(cur.density, entry.density));
			const fresh = cover(r.snap);
			const high = entry.density > best_density;
			entry.score = entry.density;
			if (high || (fresh > 0 && entry.density >= best_density / 2)) {
				entry.g2 = await growth2(entry);
				entry.score = entry.density * growth_bonus(entry.g2);
			}
			if (found_at === null && worth(entry)) found_at = at;
			if (high) best_density = entry.density;
			if (high || fresh > 0) {
				corpus.push(entry);
				if (corpus.length > CORPUS_MAX) {
					const drop = corpus.reduce(
						(lo, x, i) => (x !== best && x.score < corpus[lo].score ? i : lo),
						corpus[0] === best ? 1 : 0
					);
					corpus = corpus.filter((_, i) => i !== drop);
				}
			}
			if (entry.density >= cur.density) cur = entry;
			if (entry.score > best.score) {
				best = entry;
				best_snap = r.snap;
				best_regex = r.regex;
				new_best(entry, at);
				stale = 0;
			} else if (++stale >= o.patience) {
				cur = rng.int(2) === 0 ? best : rng.pick(corpus);
				stale = 0;
			}
		}
		out.worst = best.total;
		out.ratio = out.typical > 0 ? r3(best.total / out.typical) : 1;
		out.input = preview(best.input);
		out.mutations = best.trail;
		out.best_at ??= 0;
		if (!o.guided) return out;
		out.found_at = found_at;
		if (bandit) out.arms = bandit.stats();

		out.size = { setup: seed_size, worst: best.size };
		const setup_density = seed_entry.density;
		out.density = {
			setup: r3(setup_density),
			worst: r3(best.density),
			ratio: setup_density > 0 ? r3(best.density / setup_density) : best.density > 0 ? 1e9 : 1
		};
		out.growth2 = best.g2 === null ? null : r3(best.g2);
		out.corpus = corpus.length;
		out.coverage = seen.size;
		out.grammars = plan.names();
		if (model) {
			out.regex = {
				extra: r3(best_regex?.extra ?? 0),
				uses: (best_regex?.uses ?? []).filter((u) => u.backtracking > 0).slice(0, 5),
				unsupported: model.stats().unsupported
			};
		}

		// ---- shrink the winner, then grow it
		const deadline = started + o.ms + Math.max(5_000, o.ms / 2);
		let after = budget_steps;
		const info = (snap: Snapshot): CaseReport =>
			build_case_report(m.rt, snap, {
				name: c.name,
				file: c.file,
				stable: true,
				timers: 0,
				runaway: false,
				error: null
			});
		const dense = out.density.ratio >= o.flag;
		const steep = best.g2 !== null && best.g2 >= GROWTH2_FLAG;
		const winner = runaway ? runaway.input : best.input;
		if (!(runaway || dense || steep)) {
			out.pattern = null;
			out.finding = null;
			return out;
		}
		// What the shrunk input must keep: running away; else growing superlinearly when doubled
		// (a quadratic core loses density as it shrinks, never its growth); else the density.
		const target = best.density;
		const accept = async (candidate: unknown): Promise<boolean> => {
			if (Date.now() > deadline || after < try_cap) return false;
			try {
				const r = await count(candidate, 'replay', try_cap);
				after -= r.total;
				if (runaway) return false;
				if (steep) {
					const g = await doubled(
						candidate,
						r.total,
						(cap) => after >= cap && Date.now() <= deadline,
						(steps) => (after -= steps)
					);
					return g !== null && g >= GROWTH2_FLAG;
				}
				return density_of(r.total, input_size(candidate)) >= SHRINK_KEEP * target;
			} catch (e) {
				if (e instanceof StepCapError) {
					after -= try_cap;
					return runaway !== null;
				}
				return false;
			}
		};
		const shrunk = o.shrink > 0 ? await shrink(winner, accept, plan, o.shrink) : null;
		const small = shrunk ? shrunk.input : winner;
		const pattern: SearchPattern = {
			input: preview(small),
			size: input_size(small),
			from_size: input_size(winner),
			shrink_evals: shrunk?.evals ?? 0,
			way: null,
			sizes: [],
			steps: [],
			class: null,
			exponent: null,
			blame: []
		};
		const reasons: FindingReason[] = [];
		if (runaway) reasons.push('runaway');
		else {
			// Grow the shrunk input every way it grows, from about the winner's size (m times the
			// shrunk one) to 8 times that; the steepest way is the pattern's growth.
			const m_times = Math.max(1, Math.round(pattern.from_size / Math.max(1, pattern.size)));
			let base: Counted | null = null;
			try {
				base = await count(small, 'replay', try_cap);
				after -= base.total;
			} catch {
				base = null;
			}
			let picked: {
				way: GrowWay;
				sizes: number[];
				steps: number[];
				snaps: Snapshot[];
				exceeded_at?: number;
				fit: ReturnType<typeof fit_growth> | null;
			} | null = null;
			const rank = (p: NonNullable<typeof picked>): number =>
				p.exceeded_at !== undefined ? 1e6 - p.exceeded_at : (p.fit?.exponent ?? 0);
			for (const grower of base ? growers(small, plan, c.scale) : []) {
				const sizes: number[] = [];
				const steps: number[] = [];
				const snaps: Snapshot[] = [];
				let first = 0;
				let exceeded_at: number | undefined;
				for (const k of GROW_SIZES) {
					// the first size has the try cap; the others k^3 times its steps, times a margin
					const cap =
						k === 1
							? try_cap
							: Math.min(budget_steps, Math.max(try_cap, GROW_CAP_FACTOR * first * k * k * k));
					if (Date.now() > deadline || after < cap) break;
					const input = m_times * k === 1 ? small : grower.make(m_times * k);
					const size = input_size(input);
					if (sizes.length > 0 && size <= sizes[sizes.length - 1]) break; // it does not grow
					try {
						const r = m_times * k === 1 ? base! : await count(input, 'replay', cap);
						if (r !== base) after -= r.total;
						if (k === 1) first = r.total;
						sizes.push(size);
						steps.push(Math.max(r.total - floor, 1));
						snaps.push(r.snap);
					} catch (e) {
						if (!(e instanceof StepCapError)) break;
						after -= cap;
						if (k > 1) exceeded_at = k;
						break;
					}
				}
				if (sizes.length < 2 && exceeded_at === undefined) continue;
				const rel = sizes.map((s) => s / sizes[0]);
				const fit = sizes.length >= 2 ? fit_growth(rel, steps) : null;
				const p = { way: grower.way, sizes, steps, snaps, exceeded_at, fit };
				if (!picked || rank(p) > rank(picked)) picked = p;
			}
			if (picked) {
				pattern.way = picked.way;
				pattern.sizes = picked.sizes;
				pattern.steps = picked.steps.map((s) => Math.round(s));
				pattern.class = picked.fit?.class ?? null;
				pattern.exponent = picked.fit ? r3(picked.fit.exponent) : null;
				if (picked.exceeded_at !== undefined) pattern.exceeded_at = picked.exceeded_at;
				const last = picked.snaps.length - 1;
				if (last > 0) {
					pattern.blame = blame(
						info(picked.snaps[0]),
						info(picked.snaps[last]),
						picked.sizes[last] / picked.sizes[0]
					);
				}
				const superlinear =
					picked.exceeded_at !== undefined ||
					(is_superlinear(pattern.class) && (pattern.exponent ?? 0) >= SUPERLINEAR_POWER);
				if (superlinear) reasons.push('superlinear');
			}
			if (dense) reasons.unshift('dense');
			if (pattern.blame.length === 0 && dense) {
				pattern.blame = blame(
					info(setup_snap),
					info(best_snap),
					best.size / Math.max(1, seed_size)
				);
			}
		}
		out.pattern = pattern;
		out.finding = reasons.length > 0 ? { reasons, text: finding_text(out, reasons) } : null;
	} catch (e) {
		out.error = e instanceof Error ? e.message : String(e);
	}
	return out;
}

function finding_text(s: SearchCase, reasons: FindingReason[]): string {
	const p = s.pattern!;
	const parts: string[] = [];
	if (reasons.includes('runaway')) {
		const why = s.exceeded?.regex
			? `a regex backtracks without end (${s.exceeded.regex.replace(/^heisenbench: /, '')})`
			: `it went past its cap of ${Math.round(s.exceeded?.cap ?? 0)} steps`;
		parts.push(`may never finish: ${why}`);
	}
	if (reasons.includes('dense'))
		parts.push(`${s.density!.ratio}x the setup input's steps per unit of input`);
	if (reasons.includes('superlinear')) {
		const grows =
			p.exceeded_at !== undefined
				? `went past its cap at ${p.exceeded_at}x (steeper than cubic)`
				: `${growth_label(p.class)} (exponent ${p.exponent})`;
		parts.push(
			`grows ${grows} when ${p.way === 'nest' ? 'nested deeper' : p.way === 'case' ? 'scaled' : 'repeated'}`
		);
	}
	const where = p.blame[0] ? `; most extra steps at ${p.blame[0].at}` : '';
	return `${parts.join(', ')}, on ${code(p.input)} (shrunk from ${p.from_size} to ${p.size})${where}`;
}

export async function run_search(opts: SearchOptions): Promise<SearchReport> {
	const log = opts.log ?? (() => {});
	const list = await load_cases(opts);
	const m = new Measurer(opts.root);
	const options = { ...DEFAULTS };
	for (const k of Object.keys(DEFAULTS) as Array<keyof SearchBudget>) {
		if (opts[k] !== undefined) (options as Record<string, unknown>)[k] = opts[k];
	}
	const report: SearchReport = { schema: SEARCH_SCHEMA, options, cases: [] };
	for (const c of list) {
		const s = await search_case(c, m, options);
		report.cases.push(s);
		log(
			s.error
				? `FAILED   ${c.name}: ${s.error}`
				: `${s.finding ? 'FOUND   ' : 'ok      '} ${c.name}  worst ${Math.round(s.worst)} vs typical ${Math.round(s.typical)} steps (${s.ratio}x, ${s.evals} inputs, stopped by ${s.stopped})${s.finding ? `\n           ${s.finding.text}` : ''}`
		);
	}
	return report;
}

export interface SearchFinding {
	case: string;
	text: string;
}

/**
 * A PR case is flagged when its worst input costs at least `flag` times typical and at least twice
 * the base's ratio, when it has an input it may never finish on that the base did not, or when its
 * found pattern grows superlinearly and the base's does not.
 */
export function diff_search(base: SearchReport, pr: SearchReport, flag = 4): SearchFinding[] {
	const out: SearchFinding[] = [];
	const by_name = new Map(base.cases.map((c) => [c.name, c]));
	for (const p of pr.cases) {
		if (p.error) continue;
		const b = by_name.get(p.name);
		const base_ratio = b && !b.error ? b.ratio : 1;
		const steep = (c: SearchCase | undefined) =>
			!!c && !c.error && (c.finding?.reasons.includes('superlinear') ?? false);
		if (p.runaway && !b?.runaway) {
			out.push({
				case: p.name,
				text: `${code(p.name)} has an input it may never finish on: it exceeded the cap of ${Math.round(p.exceeded?.cap ?? 0)} steps at size ${p.exceeded?.size ?? '?'} (${Math.round(p.typical)} typical)`
			});
		} else if (p.ratio >= flag && p.ratio >= 2 * base_ratio) {
			out.push({
				case: p.name,
				text: `${code(p.name)} has a slow input: ${Math.round(p.worst)} steps vs ${Math.round(p.typical)} typical (${p.ratio}x, base ${base_ratio}x)`
			});
		} else if (steep(p) && !steep(b)) {
			out.push({ case: p.name, text: `${code(p.name)} ${p.finding!.text}` });
		}
	}
	return out;
}

/** The markdown of a search: only the findings worth a human's attention. */
export function render_search(r: SearchReport): string {
	const lines = ['#### Worst-case search', ''];
	const failed = r.cases.filter((c) => c.error);
	const found = r.cases.filter((c) => !c.error && c.finding);
	if (found.length === 0) {
		lines.push(
			`No input worth a look in ${r.cases.length - failed.length} cases (seed ${r.options.seed}, ${r.options.evals} inputs each).`
		);
	} else {
		lines.push(
			`${found.length} of ${r.cases.length - failed.length} cases have an input worth a look (seed ${r.options.seed}, ${r.options.evals} inputs each):`,
			''
		);
		for (const c of found) {
			const p = c.pattern;
			lines.push(`- ${code(c.name)} (${c.file}): ${c.finding!.text}`);
			if (p && p.steps.length > 1) {
				const pts = p.sizes.map((s, i) => `${s}: ${p.steps[i]}`).join(', ');
				lines.push(`  - steps by input size: ${pts}`);
			}
			for (const b of p?.blame ?? []) {
				lines.push(
					`  - ${code(b.at)} in ${code(b.fn)}: +${b.extra} steps (${Math.round(b.share * 100)}%)`
				);
			}
			for (const u of c.regex?.uses ?? []) {
				lines.push(
					`  - regex ${code(`/${u.source}/${u.flags}`)} in ${code(u.fn)}: ${u.backtracking} backtracking steps`
				);
			}
		}
	}
	if (failed.length > 0) {
		lines.push('', `**Failed**: ${failed.map((c) => `${code(c.name)} (${c.error})`).join(', ')}`);
	}
	return lines.join('\n') + '\n';
}
