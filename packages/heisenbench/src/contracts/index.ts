import { code } from '../md.ts';
import { GROWTH_RANK, growth_label } from '../growth/fit.ts';
import type { GrowthClass } from '../growth/fit.ts';
import { odds_words, pct } from '../growth/odds.ts';
import type { GrowthOdds } from '../growth/odds.ts';
import { round3 } from '../growth/index.ts';
import type { GrowthReport, LineShare } from '../growth/index.ts';
import { MIN_STEPS } from '../growth/recorded.ts';
import type { RecordedGrowthReport } from '../growth/recorded.ts';
import { contract_rank } from './declare.ts';
import type { Contract, ContractError } from './declare.ts';

/*
 * Complexity contracts, checked. A contract (declare.ts: `@heisenbench linear in items`) is held
 * against what the growth layer measured of its function:
 *
 *   growth     every growth case that ran it keeps its curve: its steps per call at each scale of
 *              the case's input, and the odds of each shape (growth/index.ts `contracts`)
 *   recorded   growth from recorded calls: its steps per call over the named argument's recorded
 *              sizes (or, when those span too little, that argument of the largest call scaled)
 *
 * Each source gives a verdict from the odds of the curve's shape (growth/odds.ts):
 *
 *   holds      the declared class or a cheaper one has at least CONTRACT_ODDS
 *   broken     a steeper class has at least CONTRACT_ODDS (on recorded calls, with MIN_STEPS or
 *              more at the largest size: a few steps that grow say nothing about real sizes)
 *   unsure     neither (the curve could go either way on the sizes measured)
 *
 * The contract is broken when any source says so, holds when one holds and none breaks it, and is
 * unmeasured when nothing measured its function. A check passes only when every contract holds:
 * broken, unsure and unmeasured all fail it, and so does a tag that declares nothing.
 *
 * CONTRACT_ODDS is 0.9, the bar the growth layer already uses twice: a superlinear finding needs
 * 0.9 of quadratic or worse (SUPERLINEAR_ODDS), and odds under 0.9 on the likeliest shape are a
 * close call that gets one more size counted (CLOSE_CALL). A contract that holds is one the
 * growth layer itself calls settled, after that extra size; at most one chance in ten of a
 * steeper shape is left.
 */

export const CONTRACTS_SCHEMA = 'heisenbench-contracts/1';

/** Odds a verdict needs (see above). */
export const CONTRACT_ODDS = 0.9;

export type Verdict = 'holds' | 'broken' | 'unsure' | 'unmeasured';

export interface ContractSource {
	kind: 'growth' | 'recorded';
	/** The growth case, or the recorded function's argument words. */
	from: string;
	/** null: this source does not measure the contract (`why` says so). */
	verdict: Exclude<Verdict, 'unmeasured'> | null;
	why?: string;
	/** The fitted class of the curve and its exponent (the log-log slope between the two largest sizes). */
	class: GrowthClass | null;
	exponent: number;
	power?: number;
	/** Growth case: the scale factors; recorded calls: the argument's sizes. */
	sizes: number[];
	/** Growth case: the size of the case's input at each factor. */
	input_sizes?: number[];
	/** Steps per call at each size. */
	steps: number[];
	odds: GrowthOdds | null;
	/** Odds of the declared class or a cheaper one. */
	within: number;
	/** The lines with the most steps at the largest size. */
	lines: LineShare[];
}

export interface ContractResult extends Contract {
	verdict: Verdict;
	sources: ContractSource[];
}

export interface ContractReport {
	schema: typeof CONTRACTS_SCHEMA;
	/** Odds a verdict needed. */
	bar: number;
	contracts: ContractResult[];
	errors: ContractError[];
	pass: boolean;
}

/** Odds of the declared class or cheaper, and of steeper, from the odds of each shape. */
function split_odds(o: GrowthOdds, rank: number): { within: number; over: number } {
	let within = 0;
	let over = 0;
	for (const x of o.odds) {
		if (GROWTH_RANK[x.shape]! <= rank) within += x.p;
		else over += x.p;
	}
	const total = within + over;
	return total > 0 ? { within: within / total, over: over / total } : { within: 0, over: 0 };
}

function judge(
	o: GrowthOdds | null,
	rank: number,
	bar: number,
	enough: boolean
): { verdict: ContractSource['verdict']; within: number } {
	if (!o) return { verdict: null, within: 0 };
	const { within, over } = split_odds(o, rank);
	if (within >= bar) return { verdict: 'holds', within: round3(within) };
	if (over >= bar && enough) return { verdict: 'broken', within: round3(within) };
	return { verdict: 'unsure', within: round3(within) };
}

function slope(xs: readonly number[], ys: readonly number[]): number {
	const n = xs.length;
	if (n < 2 || !(ys[n - 2] > 0 && ys[n - 1] > 0) || xs[n - 1] === xs[n - 2]) return 0;
	return round3(Math.log(ys[n - 1] / ys[n - 2]) / Math.log(xs[n - 1] / xs[n - 2]));
}

/** What the growth cases measured of one contract. */
function growth_sources(c: Contract, g: GrowthReport | undefined, bar: number): ContractSource[] {
	const out: ContractSource[] = [];
	const rank = contract_rank(c.class);
	for (const gc of g?.cases ?? []) {
		const cv = gc.contracts?.find((x) => x.id === c.id);
		if (!cv) continue;
		const src: ContractSource = {
			kind: 'growth',
			from: gc.name,
			verdict: null,
			class: cv.class,
			exponent: cv.exponent,
			sizes: gc.sizes,
			input_sizes: gc.input_sizes,
			steps: cv.steps,
			odds: cv.odds,
			within: 0,
			lines: cv.lines
		};
		if (cv.power !== undefined) src.power = cv.power;
		if (gc.error) src.why = `the case failed: ${gc.error}`;
		else if (cv.calls.some((n) => n === 0)) src.why = 'it did not run at every size of the case';
		else if (!cv.odds) src.why = `no shape to read (${growth_label(cv.class)})`;
		else Object.assign(src, judge(cv.odds, rank, bar, true));
		out.push(src);
	}
	return out;
}

/** What growth from recorded calls measured of one contract. */
function recorded_source(
	c: Contract,
	r: RecordedGrowthReport | undefined,
	bar: number
): ContractSource | null {
	const g = r?.functions.find((x) => x.id === c.id);
	if (!g) return null;
	const rank = contract_rank(c.class);
	const want = c.argument;
	const words = want === null ? 'its input' : `argument ${want} (\`${c.param}\`)`;
	const src: ContractSource = {
		kind: 'recorded',
		from: `recorded calls, ${words}`,
		verdict: null,
		class: null,
		exponent: 0,
		sizes: [],
		steps: [],
		odds: null,
		within: 0,
		lines: g.lines ?? []
	};
	const top = (ys: readonly number[]) => ys[ys.length - 1] ?? 0;
	// the curve over the argument the contract names (or the one growth chose, without a name)
	if (g.confident && (want === null || g.argument === want)) {
		src.class = g.class;
		src.power = g.power;
		src.sizes = g.points.map((p) => p.size);
		src.steps = g.points.map((p) => p.steps);
		src.exponent = g.source === 'recorded' ? g.power : slope(src.sizes, src.steps);
		src.odds = g.odds ?? null;
		const enough = g.source === 'scaled' || top(src.steps) >= MIN_STEPS;
		if (!src.odds) src.why = 'too few points for odds';
		else Object.assign(src, judge(src.odds, rank, bar, enough));
		return src;
	}
	const entry = g.recorded?.find((x) => x.argument === want);
	if (entry && entry.reason === null && entry.odds) {
		src.class = entry.class;
		src.power = entry.power;
		src.exponent = entry.power;
		src.odds = entry.odds;
		Object.assign(src, judge(entry.odds, rank, bar, (entry.top_steps ?? 0) >= MIN_STEPS));
		return src;
	}
	src.why = !g.confident
		? `its recorded calls decide no curve (${g.reason ?? 'undecided'})`
		: entry?.reason
			? `the recorded sizes of ${words} do not decide (${entry.reason})`
			: `growth chose ${g.argument === null ? 'its whole input' : `argument ${g.argument}`}, not ${words}`;
	return src;
}

/**
 * Every contract checked against the growth sections of `reports` (their growth cases and
 * recorded growth together). `errors`: tags that declare no contract (they fail the check).
 */
export function check_contracts(
	contracts: readonly Contract[],
	errors: readonly ContractError[],
	reports: ReadonlyArray<{ growth?: GrowthReport; recorded_growth?: RecordedGrowthReport }>,
	o: { bar?: number } = {}
): ContractReport {
	const bar = o.bar ?? CONTRACT_ODDS;
	const results: ContractResult[] = contracts.map((c) => {
		const sources: ContractSource[] = [];
		for (const r of reports) {
			sources.push(...growth_sources(c, r.growth, bar));
			const rec = recorded_source(c, r.recorded_growth, bar);
			if (rec) sources.push(rec);
		}
		const said = sources.map((s) => s.verdict);
		const verdict: Verdict = said.includes('broken')
			? 'broken'
			: said.includes('holds')
				? 'holds'
				: said.includes('unsure')
					? 'unsure'
					: 'unmeasured';
		return { ...c, verdict, sources };
	});
	return {
		schema: CONTRACTS_SCHEMA,
		bar,
		contracts: results,
		errors: [...errors],
		pass: errors.length === 0 && results.every((r) => r.verdict === 'holds')
	};
}

/* ---------------------------------------------------------------- words */

const n = (x: number): string => Math.round(x).toLocaleString('en-US');

function class_words(s: ContractSource): string {
	return s.class === null ? 'unknown' : growth_label(s.class, s.power);
}

/** The deciding source of a result: the first that breaks it, else that holds it, else any. */
function deciding(r: ContractResult): ContractSource | undefined {
	return (
		r.sources.find((s) => s.verdict === r.verdict) ??
		r.sources.find((s) => s.verdict !== null) ??
		r.sources[0]
	);
}

/** `measured quadratic (exponent 1.99), odds quadratic >99%; 1x / 10x / 100x: 40 / 3,100 / 300,000 steps per call` */
export function evidence_words(s: ContractSource, md = false): string {
	const c = md ? code : (x: string) => x;
	const odds = s.odds ? `, odds ${odds_words(s.odds)}` : '';
	const input = s.input_sizes ? ` (input sizes ${s.input_sizes.map(n).join(' / ')})` : '';
	const at =
		s.sizes.length > 0
			? `; ${s.kind === 'growth' ? `${s.sizes.map((k) => `${k}x`).join(' / ')}${input}` : `sizes ${n(s.sizes[0])}..${n(s.sizes[s.sizes.length - 1])}`}: ${s.kind === 'growth' ? s.steps.map(n).join(' / ') : `${n(s.steps[0])}..${n(s.steps[s.steps.length - 1])}`} steps per call`
			: '';
	const top = s.lines.filter((l) => l.share >= 0.01).slice(0, 3);
	const lines =
		top.length > 0
			? `; at the largest size most steps on ${top
					.map((l) => `${c(l.at)} (${Math.round(l.share * 100)}%)`)
					.join(', ')}`
			: '';
	return `measured ${class_words(s)} (exponent ${s.exponent})${odds}${at}${lines}`;
}

/** One result in words: the verdict, the contract and the deciding evidence. */
export function contract_text(r: ContractResult, bar: number, md = false): string {
	const c = md ? code : (x: string) => x;
	const head = `${c(r.id)} \`@heisenbench ${r.text}\``;
	const s = deciding(r);
	if (r.verdict === 'unmeasured') {
		const why = r.sources
			.map((x) => x.why)
			.filter(Boolean)
			.join('; ');
		return `${head}: nothing measures its growth${why ? ` (${why})` : ''}; add a growth case that runs it or a test whose calls replay`;
	}
	const from = s ? ` in ${s.kind === 'growth' ? `growth case ${c(s.from)}` : s.from}` : '';
	const tail = s ? `: ${evidence_words(s, md)}` : '';
	const within = pct(s?.within ?? 0);
	if (r.verdict === 'holds') return `${head} holds${from} (${within} ${r.class} or cheaper)${tail}`;
	if (r.verdict === 'broken')
		return `${head} is broken${from}${tail}; odds of ${r.class} or cheaper ${within}`;
	return `${head} is not shown to hold${from} (${within} ${r.class} or cheaper, under ${pct(bar)})${tail}`;
}

/** The terminal lines of a check. */
export function contract_lines(r: ContractReport): string[] {
	const out: string[] = [];
	const tag: Record<Verdict, string> = {
		holds: 'holds   ',
		broken: 'BROKEN  ',
		unsure: 'UNSURE  ',
		unmeasured: 'UNMEASURED'
	};
	for (const c of r.contracts) {
		out.push(`${tag[c.verdict]} ${contract_text(c, r.bar)}`);
		for (const s of c.sources)
			if (s.verdict === null && s.why) out.push(`           ${s.from}: ${s.why}`);
	}
	for (const e of r.errors)
		out.push(`ERROR    ${e.module}:${e.line} @heisenbench ${e.text}: ${e.error}`);
	return out;
}

/** The markdown of a check (for `--md`). */
export function render_contracts(r: ContractReport): string {
	const lines = ['#### Complexity contracts', ''];
	const bad = r.contracts.filter((c) => c.verdict !== 'holds');
	const held = r.contracts.length - bad.length;
	lines.push(
		r.contracts.length === 0 && r.errors.length === 0
			? 'No function declares a complexity contract.'
			: `${held} of ${r.contracts.length} contract${r.contracts.length === 1 ? '' : 's'} hold (a verdict needs ${pct(r.bar)} odds).`,
		''
	);
	for (const c of bad) lines.push(`- **${c.verdict}**: ${contract_text(c, r.bar, true)}`);
	for (const e of r.errors)
		lines.push(
			`- **error**: ${code(`${e.module}:${e.line}`)} \`@heisenbench ${e.text}\`: ${e.error}`
		);
	if (bad.length > 0 || r.errors.length > 0) lines.push('');
	const ok = r.contracts.filter((c) => c.verdict === 'holds');
	if (ok.length > 0) {
		lines.push('<details><summary>Contracts that hold</summary>', '');
		for (const c of ok) lines.push(`- ${contract_text(c, r.bar, true)}`);
		lines.push('', '</details>', '');
	}
	return lines.join('\n');
}

/* ---------------------------------------------------------------- PR against base */

export interface ContractsDiff {
	/** Contracts the PR declares that the base did not. */
	added: ContractResult[];
	/** Contracts the base declared that the PR does not. */
	removed: Contract[];
	/** Same function, other words. */
	changed: Array<{ base: Contract; pr: ContractResult }>;
	/** Contracts that do not hold on the PR side. */
	failing: ContractResult[];
	/** Contracts that did not hold on the base and hold on the PR side. */
	fixed: ContractResult[];
	errors: ContractError[];
	bar: number;
}

/** What a PR changes about the contracts: shown in the comment only when something did. */
export function diff_contracts(
	base: ContractReport | undefined,
	pr: ContractReport
): ContractsDiff {
	const before = new Map((base?.contracts ?? []).map((c) => [c.id, c]));
	const now = new Set(pr.contracts.map((c) => c.id));
	const out: ContractsDiff = {
		added: [],
		removed: (base?.contracts ?? []).filter((c) => !now.has(c.id)),
		changed: [],
		failing: pr.contracts.filter((c) => c.verdict !== 'holds'),
		fixed: [],
		errors: [...pr.errors],
		bar: pr.bar
	};
	for (const c of pr.contracts) {
		const b = before.get(c.id);
		if (!b) out.added.push(c);
		else if (b.text !== c.text) out.changed.push({ base: b, pr: c });
		else if (b.verdict !== 'holds' && c.verdict === 'holds') out.fixed.push(c);
	}
	return out;
}

/** The "Complexity contracts" part of the comment, or '' when no contract changed or fails. */
export function render_contracts_diff(d: ContractsDiff): string {
	const any =
		d.added.length + d.removed.length + d.changed.length + d.failing.length + d.fixed.length;
	if (any + d.errors.length === 0) return '';
	const lines = ['#### Complexity contracts', ''];
	for (const c of d.failing) lines.push(`- **${c.verdict}**: ${contract_text(c, d.bar, true)}`);
	for (const e of d.errors)
		lines.push(
			`- **error**: ${code(`${e.module}:${e.line}`)} \`@heisenbench ${e.text}\`: ${e.error}`
		);
	const failing = new Set(d.failing.map((c) => c.id));
	for (const c of d.added)
		if (!failing.has(c.id)) lines.push(`- new: ${contract_text(c, d.bar, true)}`);
	for (const { base, pr } of d.changed)
		if (!failing.has(pr.id))
			lines.push(`- changed from \`@heisenbench ${base.text}\`: ${contract_text(pr, d.bar, true)}`);
	for (const c of d.fixed) lines.push(`- holds now: ${contract_text(c, d.bar, true)}`);
	for (const c of d.removed) lines.push(`- removed: ${code(c.id)} \`@heisenbench ${c.text}\``);
	lines.push('');
	return lines.join('\n');
}
