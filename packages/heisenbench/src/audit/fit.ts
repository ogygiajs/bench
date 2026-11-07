import { nnls } from '../calibrate/nnls.ts';
import { fit_growth } from '../growth/fit.ts';
import type { GrowthClass } from '../growth/fit.ts';
import { BUILTIN_TERMS, price_units } from '../units.ts';
import type { Units } from '../units.ts';
import type { BuiltinModel, Prices, SizeTerm } from '../prices.ts';

/*
 * The price audit: do the prices say what the engine does? Steps are units times prices. When the
 * prices are right, a case's time follows its steps as its input grows; when one is wrong, the
 * steps of that one kind of unit drift away from the time while the rest still follow it.
 *
 * The data: each audited case at every growth size (1x, 10x, 100x): its units (what ran, before
 * pricing), split by kind (an op kind like `call`, a dynamic kind like `dyn.string_char`, a
 * built-in like `bi.Array.prototype.sort` with its size terms), and its time on the plain build
 * in several rounds, each round in a fresh process.
 *
 * Per case and per round, time is fitted over the sizes the way calibration fits it (calibrate/
 * weights.ts: non-negative least squares, rows scaled by 1/ns so every size weighs the same), with
 * competing models:
 *
 *   steps       ns = t * steps                             the prices are right
 *   constant    ns = c + t * steps                         a cost per call steps do not see
 *   engine      ns = t * steps^g, g in ENGINE_GROWTH       the engine gets a little slower per
 *                                                          step as the input grows (caches, GC)
 *   kind k      ns = t * (steps - steps_k) + b * steps_k   kind k costs b/t times its price
 *   term k.n    ns = t * steps + b * units_k.n             built-in k is missing a size term
 *                                                          its price model leaves out
 *
 * A candidate (a kind, or a missing term) is a suspect in a case when, in every round: the steps
 * model misses time (RMS relative error of MISFIT or more); the candidate's model removes most of
 * that miss (EXPLAINED) and clearly more than the constant and engine models do (BEATS); and of
 * all candidates that do, the one that changes the case's steps the least is still far off (its
 * price off by more than FACTOR either way). Every round must agree on its own, like the time
 * layer's no-overlap rule: one noisy round cannot make a finding. A kind whose steps grow like
 * the rest of the case's cannot be told apart from them by growth and is not tested (MIN_DRIFT).
 *
 * Findings group the cases by candidate, with each case's step and time exponents (between the
 * two largest sizes) and the factor the price would need.
 */

export const AUDIT_SCHEMA = 'heisenbench-audit/1';

/** Steps miss time by at least this RMS relative error over the sizes before anything is blamed. */
export const MISFIT = 0.15;
/** The candidate's model leaves at most this fraction of the steps model's squared error. */
export const EXPLAINED = 0.1;
/** ...and at most this fraction of the constant's and the engine's. */
export const BEATS = 0.5;
/** A price is far off when it should be more than FACTOR times, or less than 1/FACTOR of, itself. */
export const FACTOR = 4;
/** Exponents the engine model may take. */
export const ENGINE_GROWTH: [number, number] = [0.9, 1.3];
/**
 * A candidate is tested only when it grows apart from the rest of the case: its ratio to the rest
 * at the largest size is at least this many times (or at most 1/this of) the ratio at the smallest.
 */
export const MIN_DRIFT = 1.25;
/**
 * Another kind whose explanation changes the steps no more than this many times as much as the
 * best one's makes the case ambiguous: no finding, the candidates are listed.
 */
export const AMBIGUOUS = 1.5;

/** Factors are kept below this ("time is this kind alone" is never an explanation). */
const FACTOR_CAP = 1e6;

/** Whether `own` grows apart from `rest` (MIN_DRIFT). */
export function drifts(own: readonly number[], rest: readonly number[]): boolean {
	const n = rest.length;
	if (rest[0] <= 0 || rest[n - 1] <= 0) return false;
	if (own[0] <= 0) return own[n - 1] > 0;
	const d = own[n - 1] / rest[n - 1] / (own[0] / rest[0]);
	return d >= MIN_DRIFT || d <= 1 / MIN_DRIFT;
}

export interface AuditInput {
	file: string;
	name: string;
	sizes: number[];
	/** Units of the case at each size (growth layer). */
	units: Units[];
	/** ns of the median call (audit/time.ts): one row per round, one column per size. */
	rounds: number[][];
}

export interface AuditSuspect {
	/** The kind whose price is suspect (`dyn.string_char`, `bi.Array.prototype.splice`). */
	kind: string;
	/** null: the kind's price is off by `factor`; a size term (`n`): the price model leaves it out. */
	term: (typeof BUILTIN_TERMS)[number] | null;
	/**
	 * What the kind's steps should be, over what they are, at the largest size (median over the
	 * rounds): 0.01 is a price 100x too high, 50 one 50x too low.
	 */
	factor: number;
	/** The factor's lowest and highest round. */
	factor_range: [number, number];
	/** The built-in's price model, for a missing term. */
	model?: BuiltinModel;
	/** The kind's share of the case's steps at each size. */
	share: number[];
	/** How what the candidate prices grows: its steps, or the term's units, between the two largest sizes. */
	kind_exponent: number;
	kind_class: GrowthClass | null;
}

export interface AuditCase {
	file: string;
	name: string;
	sizes: number[];
	steps: number[];
	/** Median over the rounds, per size. */
	ns: number[];
	rounds: number;
	steps_exponent: number;
	steps_class: GrowthClass | null;
	/** Median over the rounds of the time exponent between the two largest sizes. */
	time_exponent: number;
	time_exponent_range: [number, number];
	time_class: GrowthClass | null;
	/** RMS relative error of the steps model (median over the rounds). */
	misfit: number;
	/**
	 * Why a case that misses time has no suspect: a per-call `constant` or a slower `engine`
	 * explains it, or several kinds' prices would (`ambiguous`, listed in `candidates`).
	 */
	explained_by: 'constant' | 'engine' | 'ambiguous' | null;
	/** The explanations of an ambiguous case, the least change first. */
	candidates?: string[];
	suspect: AuditSuspect | null;
}

export interface AuditFinding {
	kind: string;
	term: AuditSuspect['term'];
	/** `over`: the price charges more than the engine does; `under`: less. */
	direction: 'over' | 'under';
	/** Median factor over the cases. */
	factor: number;
	cases: Array<{
		file: string;
		name: string;
		factor: number;
		kind_exponent: number;
		kind_class: GrowthClass | null;
		steps_exponent: number;
		time_exponent: number;
		time_class: GrowthClass | null;
	}>;
	/** Where the kind's units are, at 1x (`module:line`), when a report gives the lines. */
	lines?: string[];
	text: string;
}

export interface AuditReport {
	schema: typeof AUDIT_SCHEMA;
	sizes: number[];
	/** Timing rounds per case. */
	rounds: number;
	prices: { version: number; hash: string };
	/** The points the analysis ran on: kept so reports of several bench files can be audited together. */
	inputs: AuditInput[];
	cases: AuditCase[];
	findings: AuditFinding[];
	/** Cases that could not be audited, and why. */
	failed: Array<{ file: string; name: string; error: string }>;
}

/** The kind a unit key belongs to: an op kind, a dynamic price, or a built-in (all its terms). */
export function kind_of(key: string): string {
	return key.startsWith('bi.') ? key.slice(0, key.lastIndexOf('.')) : key;
}

/** Steps per kind of a set of units. */
export function kind_steps(u: Units, prices: Prices): Map<string, number> {
	const by_kind = new Map<string, Units>();
	for (const k of Object.keys(u)) {
		const kind = kind_of(k);
		let g = by_kind.get(kind);
		if (!g) by_kind.set(kind, (g = {}));
		g[k] = u[k];
	}
	const out = new Map<string, number>();
	for (const [kind, g] of by_kind) {
		const s = price_units(g, prices);
		if (s > 0) out.set(kind, s);
	}
	return out;
}

/** The size term each built-in price model charges for. */
const PRICED_TERM: Record<BuiltinModel, string | null> = {
	const: null,
	n: 'n',
	n_log_n: 'nlogn',
	n2: 'n2'
};

interface Fit {
	x: number[];
	/** Sum of squared relative errors. */
	rss: number;
}

/** NNLS of `ns` on the columns (one row per size), rows scaled by 1/ns as in calibration. */
export function fit_relative(cols: number[][], ns: number[]): Fit {
	const k = cols[0].length;
	// Columns scaled to unit size: step counts and a constant 1 differ by orders of magnitude.
	const scale = Array.from({ length: k }, (_, j) =>
		Math.max(...cols.map((r, i) => Math.abs(r[j]) / ns[i]), 1e-300)
	);
	const a = cols.map((r, i) => r.map((v, j) => v / ns[i] / scale[j]));
	const z = nnls(
		a,
		ns.map(() => 1)
	);
	const x = z.map((v, j) => v / scale[j]);
	let rss = 0;
	for (let i = 0; i < ns.length; i++) {
		let p = 0;
		for (let j = 0; j < k; j++) p += cols[i][j] * x[j];
		rss += (1 - p / ns[i]) ** 2;
	}
	return { x, rss };
}

/** ns = t * steps^g with g in ENGINE_GROWTH (least squares on the log scale), as relative error. */
export function fit_engine(steps: number[], ns: number[]): Fit {
	const xs = steps.map(Math.log);
	const ys = ns.map(Math.log);
	const n = xs.length;
	const mx = xs.reduce((s, v) => s + v, 0) / n;
	const my = ys.reduce((s, v) => s + v, 0) / n;
	let sxy = 0;
	let sxx = 0;
	for (let i = 0; i < n; i++) {
		sxy += (xs[i] - mx) * (ys[i] - my);
		sxx += (xs[i] - mx) ** 2;
	}
	const raw = sxx > 0 ? sxy / sxx : 1;
	const g = Math.min(ENGINE_GROWTH[1], Math.max(ENGINE_GROWTH[0], raw));
	const a = my - g * mx;
	let rss = 0;
	for (let i = 0; i < n; i++) rss += (1 - Math.exp(a + g * xs[i]) / ns[i]) ** 2;
	return { x: [Math.exp(a), g], rss };
}

function median(xs: readonly number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const h = s.length >> 1;
	return s.length === 0 ? NaN : s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/** Exponent between the two largest sizes. */
function top_exponent(sizes: number[], ys: number[]): number {
	const n = sizes.length;
	if (n < 2 || !(ys[n - 1] > 0) || !(ys[n - 2] > 0)) return 0;
	return Math.log(ys[n - 1] / ys[n - 2]) / Math.log(sizes[n - 1] / sizes[n - 2]);
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const round_factor = (v: number): number =>
	v >= FACTOR_CAP ? FACTOR_CAP : v >= 1 ? Math.round(v * 100) / 100 : Number(v.toPrecision(3));

/** What a model may blame: a kind's price, or a size term a built-in's price leaves out. */
interface Candidate {
	/** `dyn.string_char`, or `bi.Array.prototype.splice.n` for a term. */
	id: string;
	kind: string;
	term: AuditSuspect['term'];
	model?: BuiltinModel;
	/** The kind's steps at each size. */
	own: number[];
	/** A term's units at each size (null for a kind). */
	units: number[] | null;
}

interface Judged {
	rss: number;
	/** The kind's steps should be `factor` times what they are (at the largest size). */
	factor: number;
	/** How much of the case's steps the factor changes (averaged over the sizes). */
	change: number;
}

interface RoundVerdict {
	misfit: number;
	candidates: Map<string, Judged>;
	rss0: number;
	rss_constant: number;
	rss_engine: number;
}

function judge(c: Candidate, steps: number[], ns: number[]): Judged {
	const m = steps.length;
	const last = m - 1;
	if (c.units === null) {
		const f = fit_relative(
			steps.map((s, i) => [s - c.own[i], c.own[i]]),
			ns
		);
		const [t, b] = f.x;
		const factor = t > 0 ? Math.min(b / t, FACTOR_CAP) : b > 0 ? FACTOR_CAP : 1;
		let change = 0;
		for (let i = 0; i < m; i++) change += (Math.abs(factor - 1) * c.own[i]) / steps[i] / m;
		return { rss: f.rss, factor, change };
	}
	const u = c.units;
	const f = fit_relative(
		steps.map((s, i) => [s, u[i]]),
		ns
	);
	const [t, b] = f.x;
	if (!(t > 0)) return { rss: f.rss, factor: FACTOR_CAP, change: Infinity };
	const per_unit = b / t;
	const own = c.own[last];
	const factor =
		own > 0 ? Math.min((own + per_unit * u[last]) / own, FACTOR_CAP) : b > 0 ? FACTOR_CAP : 1;
	let change = 0;
	for (let i = 0; i < m; i++) change += (per_unit * u[i]) / steps[i] / m;
	return { rss: f.rss, factor, change };
}

function judge_round(steps: number[], candidates: Candidate[], ns: number[]): RoundVerdict {
	const f0 = fit_relative(
		steps.map((s) => [s]),
		ns
	);
	const fc = fit_relative(
		steps.map((s) => [1, s]),
		ns
	);
	const fe = fit_engine(steps, ns);
	const judged = new Map<string, Judged>();
	for (const c of candidates) judged.set(c.id, judge(c, steps, ns));
	return {
		misfit: Math.sqrt(f0.rss / steps.length),
		candidates: judged,
		rss0: f0.rss,
		rss_constant: fc.rss,
		rss_engine: fe.rss
	};
}

/**
 * The candidates whose model explains a round, the least change first. When the rest of a case
 * grows like time, any one kind of the rest also explains time on its own at an "infinite" factor
 * (every other kind free): never an explanation. Of those left, the one that changes the case's
 * steps the least is the explanation (a price of 0 on a kind that holds 90% of the steps changes
 * 90% of them; a factor of 1000 on a kind that holds 0.1% changes 100x them).
 */
function explanations(v: RoundVerdict): string[] {
	if (v.misfit < MISFIT) return [];
	const out: string[] = [];
	for (const [id, k] of v.candidates) {
		if (k.factor >= FACTOR_CAP || !Number.isFinite(k.change)) continue;
		if (k.rss > EXPLAINED * v.rss0) continue;
		if (k.rss > BEATS * v.rss_constant || k.rss > BEATS * v.rss_engine) continue;
		out.push(id);
	}
	return out.sort((a, b) => v.candidates.get(a)!.change - v.candidates.get(b)!.change);
}

/**
 * A round no model explains: the steps miss its time, and so do every candidate, a cost per call
 * and a slower engine. That is a round a burst of other work bent (one size timed slow on a shared
 * machine), not a price: it neither blames nor clears, and the other rounds decide.
 */
function unexplained(v: RoundVerdict): boolean {
	if (v.misfit < MISFIT) return false;
	if (v.rss_constant <= EXPLAINED * v.rss0 || v.rss_engine <= EXPLAINED * v.rss0) return false;
	for (const k of v.candidates.values()) if (k.rss <= EXPLAINED * v.rss0) return false;
	return true;
}

/** What a round blames: the least-change explanation, when even it is far off (FACTOR). */
function blamed(v: RoundVerdict): string | null {
	const best = explanations(v)[0];
	if (best === undefined) return null;
	const f = v.candidates.get(best)!.factor;
	return f < FACTOR && f > 1 / FACTOR ? null : best;
}

/** Every kind, and every unpriced size term of a built-in, that grows apart from the rest. */
function candidates_of(
	units: Units[],
	per_size: Array<Map<string, number>>,
	steps: number[],
	prices: Prices
): Candidate[] {
	const out: Candidate[] = [];
	const kinds = new Set<string>();
	for (const m of per_size) for (const k of m.keys()) kinds.add(k);
	const terms = new Set<string>();
	for (const u of units) for (const k of Object.keys(u)) if (k.startsWith('bi.')) terms.add(k);
	for (const kind of kinds) {
		const own = per_size.map((m) => m.get(kind) ?? 0);
		const rest = steps.map((s, i) => s - own[i]);
		if (drifts(own, rest)) out.push({ id: kind, kind, term: null, own, units: null });
	}
	for (const key of terms) {
		const dot = key.lastIndexOf('.');
		const kind = key.slice(0, dot);
		const term = key.slice(dot + 1) as (typeof BUILTIN_TERMS)[number];
		const price = prices.builtins[kind.slice(3)];
		if (!price || term === 'calls' || PRICED_TERM[price.model] === term) continue;
		if (price.terms?.[term as SizeTerm] !== undefined) continue;
		const u = units.map((x) => x[key] ?? 0);
		if (!drifts(u, steps)) continue;
		const own = per_size.map((m) => m.get(kind) ?? 0);
		out.push({ id: key, kind, term, model: price.model, own, units: u });
	}
	return out;
}

/** Audit one case: the verdict of every round, and the suspect when every round agrees. */
export function audit_case(input: AuditInput, prices: Prices): AuditCase {
	const { sizes } = input;
	const per_size = input.units.map((u) => kind_steps(u, prices));
	const steps = per_size.map((m) => [...m.values()].reduce((s, v) => s + v, 0));
	const candidates = candidates_of(input.units, per_size, steps, prices);
	const rounds = input.rounds.filter((r) => r.length === sizes.length && r.every((v) => v > 0));
	const verdicts = rounds.map((ns) => judge_round(steps, candidates, ns));
	const time_exponents = rounds.map((ns) => top_exponent(sizes, ns));
	const ns = sizes.map((_, i) => median(rounds.map((r) => r[i])));
	// Every round that has a say must blame the same kind, and they must be most of the rounds (at
	// least two): a bent round (unexplained) abstains, a round that blames another kind or nothing
	// still clears the case.
	const voting = verdicts.filter((v) => !unexplained(v));
	const blames = voting.map(blamed);
	const first = blames[0] ?? null;
	const agreed =
		voting.length >= 2 &&
		voting.length * 2 > verdicts.length &&
		first !== null &&
		blames.every((b) => b === first);
	let suspect: AuditSuspect | null = null;
	const c = agreed ? candidates.find((x) => x.id === first) : undefined;
	// A finding names one price: when another kind explains a round about as well (it changes the
	// steps no more than AMBIGUOUS times as much), growth cannot tell which price is wrong. Any
	// round is enough, as any round is enough to clear a case: a finding must hold in all of them.
	const rivals = c
		? candidates
				.filter(
					(x) =>
						x.kind !== c.kind &&
						verdicts.some(
							(v) =>
								explanations(v).includes(x.id) &&
								v.candidates.get(x.id)!.change <= AMBIGUOUS * v.candidates.get(c.id)!.change
						)
				)
				.map((x) => x.id)
		: [];
	if (c && rivals.length === 0) {
		const factors = voting.map((v) => v.candidates.get(c.id)!.factor);
		const grows = c.units ?? c.own;
		suspect = {
			kind: c.kind,
			term: c.term,
			factor: round_factor(median(factors)),
			factor_range: [round_factor(Math.min(...factors)), round_factor(Math.max(...factors))],
			...(c.model ? { model: c.model } : {}),
			share: c.own.map((v, i) => round3(steps[i] > 0 ? v / steps[i] : 0)),
			kind_exponent: round3(top_exponent(sizes, grows)),
			kind_class: sizes.length >= 2 ? fit_growth(sizes, grows).class : null
		};
	}
	const misfit = median(verdicts.map((v) => v.misfit));
	let explained_by: AuditCase['explained_by'] = null;
	if (c && rivals.length > 0) {
		explained_by = 'ambiguous';
	} else if (!suspect && rounds.length > 0 && misfit >= MISFIT) {
		const c = median(verdicts.map((v) => v.rss_constant / v.rss0));
		const e = median(verdicts.map((v) => v.rss_engine / v.rss0));
		if (Math.min(c, e) <= EXPLAINED) explained_by = c <= e ? 'constant' : 'engine';
	}
	return {
		file: input.file,
		name: input.name,
		sizes,
		steps,
		ns: ns.map((v) => Math.round(v * 10) / 10),
		rounds: rounds.length,
		steps_exponent: round3(top_exponent(sizes, steps)),
		steps_class: sizes.length >= 2 ? fit_growth(sizes, steps).class : null,
		time_exponent: round3(median(time_exponents)),
		time_exponent_range: [round3(Math.min(...time_exponents)), round3(Math.max(...time_exponents))],
		time_class: sizes.length >= 2 && rounds.length > 0 ? fit_growth(sizes, ns).class : null,
		misfit: round3(misfit),
		explained_by,
		...(rivals.length > 0 && c ? { candidates: [c.id, ...rivals] } : {}),
		suspect
	};
}

export function fmt_factor(f: number): string {
	if (f >= FACTOR_CAP) return `over ${FACTOR_CAP.toExponential(0)}x`;
	return `${f >= 1 ? f.toFixed(1) : f.toPrecision(2)}x`;
}

const MODEL_WORDS: Record<BuiltinModel, string> = {
	const: 'a constant',
	n: 'linear in n',
	n_log_n: 'n log n',
	n2: 'n²'
};

/** The finding's sentence. */
function finding_text(f: Omit<AuditFinding, 'text'>, s: AuditSuspect): string {
	const worst = f.cases[0];
	const more = f.cases.length > 1 ? ` (and ${f.cases.length - 1} more case(s))` : '';
	const what =
		f.term === null
			? `steps grow ${s.kind_class ?? '?'} in ${worst.name} (exponent ${s.kind_exponent.toFixed(2)})`
			: `priced as ${MODEL_WORDS[s.model ?? 'const']}, but in ${worst.name} its ${f.term} grows ${s.kind_class ?? '?'} (exponent ${s.kind_exponent.toFixed(2)})`;
	const why =
		f.direction === 'over'
			? 'the price likely charges work the engine does not do'
			: 'the price likely misses work the engine does';
	return (
		`price suspect: ${f.kind}: ${what}, time grows ${worst.time_class ?? '?'} ` +
		`(${worst.time_exponent.toFixed(2)})${more}; ${why} (time matches at ${fmt_factor(f.factor)} its steps)`
	);
}

/** One finding per suspect candidate, its cases ordered by how far off they are. */
export function findings_of(cases: AuditCase[]): AuditFinding[] {
	const by_id = new Map<string, AuditCase[]>();
	const id = (s: AuditSuspect): string => (s.term ? `${s.kind}.${s.term}` : s.kind);
	for (const c of cases) {
		if (!c.suspect) continue;
		by_id.set(id(c.suspect), [...(by_id.get(id(c.suspect)) ?? []), c]);
	}
	const off = (c: AuditCase): number => Math.abs(Math.log(Math.max(c.suspect!.factor, 1e-12)));
	const out: AuditFinding[] = [];
	for (const list of by_id.values()) {
		const sorted = [...list].sort((a, b) => off(b) - off(a));
		const s = sorted[0].suspect!;
		const logs = list.map((c) => Math.log(Math.max(c.suspect!.factor, 1e-12)));
		const factor = round_factor(Math.exp(median(logs)));
		const f: Omit<AuditFinding, 'text'> = {
			kind: s.kind,
			term: s.term,
			direction: factor < 1 ? 'over' : 'under',
			factor,
			cases: sorted.map((c) => ({
				file: c.file,
				name: c.name,
				factor: c.suspect!.factor,
				kind_exponent: c.suspect!.kind_exponent,
				kind_class: c.suspect!.kind_class,
				steps_exponent: c.steps_exponent,
				time_exponent: c.time_exponent,
				time_class: c.time_class
			}))
		};
		out.push({ ...f, text: finding_text(f, s) });
	}
	return out.sort((a, b) => b.cases.length - a.cases.length || a.kind.localeCompare(b.kind));
}

/** Audit every case of the inputs together. */
export function analyze_audit(
	inputs: AuditInput[],
	o: {
		sizes: number[];
		rounds: number;
		prices: { prices: Prices; hash: string };
		failed?: AuditReport['failed'];
	}
): AuditReport {
	const cases = inputs.map((i) => audit_case(i, o.prices.prices));
	return {
		schema: AUDIT_SCHEMA,
		sizes: o.sizes,
		rounds: o.rounds,
		prices: { version: o.prices.prices.version, hash: o.prices.hash },
		inputs,
		cases,
		findings: findings_of(cases),
		failed: o.failed ?? []
	};
}
