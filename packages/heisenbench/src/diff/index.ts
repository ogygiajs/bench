import { IDENTITY, LineMap } from './git.ts';
import type { FileDiff } from './git.ts';
import { env_mismatch } from '../report.ts';
import { case_key, pair_cases } from '../cases.ts';
import type { CaseReport, FunctionReport, LineReport, Report } from '../report.ts';
import { align_prices } from '../recount.ts';
import { measure_diff } from '../measure/diff.ts';
import type { MeasureDiff } from '../measure/diff.ts';
import { load_prices } from '../prices.ts';
import type { Prices } from '../prices.ts';
import { feel_input, feel_probability, load_feel_model } from '../models/feel.ts';
import type { FeelModel } from '../models/feel.ts';
import { OWN_CODE, context_path, package_of, unversioned_module } from '../identity.ts';
import { odds_disagree } from '../growth/fit.ts';

/*
 * PR vs base (spec 11). Functions are matched by identity (`module > path`), through git file
 * renames, and by body shape when a function itself was renamed. A matched function whose own
 * cost (self steps, allocations, bytes) is unchanged produces nothing, wherever its lines moved.
 * When it changed, the change is placed on lines: unchanged lines are mapped through the git diff
 * and compared one to one; lines inside a changed hunk are compared as a whole (so a reformatted or
 * renamed line costs nothing) and, when the hunk costs more or less, its new lines are "new code".
 */

export interface Stats {
	steps: number;
	allocations: number;
	bytes: number;
}

export type FindingKind =
	| 'changed'
	| 'new code'
	| 'removed code'
	| 'new function'
	| 'removed function';

export interface Finding {
	case: string;
	kind: FindingKind;
	module: string;
	function: string;
	/** PR line (base line for removed functions). */
	line: number;
	base: Stats | null;
	pr: Stats | null;
	delta: Stats;
	/** The allocations it adds are elided by the engine (real bytes did not grow): not a regression. */
	elided?: boolean;
}

export interface FunctionChange {
	case: string;
	module: string;
	function: string;
	renamed_from: string | null;
	line: number;
	base: FunctionReport | null;
	pr: FunctionReport | null;
	delta: {
		self_steps: number;
		inclusive_steps: number;
		allocations: number;
		bytes: number;
		calls: number;
	};
	findings: Finding[];
}

export interface DiffResult {
	changes: FunctionChange[];
	findings: Finding[];
	renames: Array<{ case: string; from: string; to: string }>;
	unstable: string[];
	failed: string[];
	/**
	 * Cases one side has and the other does not: `base` lists the PR's new cases, `pr` the removed
	 * ones. A case of a bench file that did not load on the other side is in `did_not_run`, not here.
	 */
	missing: { base: string[]; pr: string[] };
	/**
	 * Bench files that did not load on one side (its report's `load_errors`), with the cases the
	 * other side has in them: those cases are not compared, and are not new or removed either.
	 * Absent in diffs from before it was kept.
	 */
	did_not_run?: { base: NotRun[]; pr: NotRun[] };
	cases: Array<{ name: string; base_steps: number; pr_steps: number }>;
	/**
	 * The PR's own numbers, heaviest case first: what a comment shows when no function changed.
	 * Absent in diffs from before it was kept.
	 */
	summary?: CaseSummary[];
	/**
	 * Self steps per package per case (`own code` for the project's), for the cases that count a
	 * dependency at all: "68% of this case is in acorn". A package upgraded between the two sides
	 * is one row, under the PR's version.
	 */
	packages: PackageSteps[];
	/** Both sides are counted with the same prices (as they came, or after a recount). */
	prices_match: boolean;
	/** The prices both sides were recounted with when they came with different ones. */
	recounted?: { version: number; hash: string } | null;
	/** Leaks, elided allocations, time-led cases, estimated ns (measure/diff.ts). */
	measure?: MeasureDiff;
	/**
	 * The odds each case's step change shows up on the clock (models/feel.ts), keyed by case
	 * name: words next to the exact numbers, never pass or fail. Absent: no model, the prices did
	 * not match, or a diff from before it was kept.
	 */
	feel?: FeelOdds;
	/** How the two reports' environments differ (Node, V8, platform, weights): empty when alike. */
	env?: string[];
}

export interface FeelOdds {
	/** The dataset the model was fitted on: its version and its timed pairs. */
	dataset: number;
	pairs: number;
	/** Case name -> odds (0..1), for the cases whose steps changed. */
	odds: Record<string, number>;
}

export interface NotRun {
	file: string;
	error: string;
	/** The cases of that file the other side ran. */
	cases: string[];
}

export interface CaseSummary {
	name: string;
	steps: number;
	allocations: number;
	/** The function with the most self steps, and its share of the case's steps (0..1). */
	top_function: { id: string; share: number } | null;
	/** The line with the most steps (`module:line`), and its share. */
	top_line: { where: string; share: number } | null;
	/** The growth class of the case, when the report has a growth section. */
	growth?: {
		class: string;
		exponent: number;
		power?: number;
		/** The shape the odds back (90% or more) when it is not the fitted class. */
		odds?: { shape: string; p: number };
	};
}

/** Each counted case of a report with where its steps are, heaviest first. */
export function summarize_cases(report: Report): CaseSummary[] {
	const growth = new Map((report.growth?.cases ?? []).map((g) => [case_key(g), g]));
	const out: CaseSummary[] = [];
	for (const c of report.cases) {
		if (c.error) continue;
		let fn: FunctionReport | null = null;
		let line: { where: string; steps: number } | null = null;
		for (const f of c.functions) {
			if (!fn || f.self_steps > fn.self_steps) fn = f;
			for (const l of f.lines) {
				if (!line || l.steps > line.steps)
					line = { where: `${f.module}:${l.line}`, steps: l.steps };
			}
		}
		const total = c.totals.steps;
		const share = (n: number): number => (total > 0 ? n / total : 0);
		const g = growth.get(case_key(c));
		const s: CaseSummary = {
			name: c.name,
			steps: total,
			allocations: c.totals.allocations,
			top_function: fn ? { id: fn.id, share: share(fn.self_steps) } : null,
			top_line: line ? { where: line.where, share: share(line.steps) } : null
		};
		if (g && g.class && !g.error) {
			s.growth = { class: g.class, exponent: g.exponent };
			if (g.power !== undefined) s.growth.power = g.power;
			const odds = odds_disagree(g);
			if (odds) s.growth.odds = odds;
		}
		out.push(s);
	}
	return out.sort((a, b) => b.steps - a.steps || (a.name < b.name ? -1 : 1));
}

export interface PackageSteps {
	case: string;
	/** `acorn@8.15.0`, or `own code`. */
	package: string;
	base_steps: number;
	pr_steps: number;
	/** The package's share of the PR case's self steps (0..1). */
	pr_share: number;
}

/** Self steps of one case by package, keyed by the package name without its version. */
function steps_by_package(c: CaseReport): Map<string, { label: string; steps: number }> {
	const out = new Map<string, { label: string; steps: number }>();
	for (const f of c.functions) {
		const p = package_of(f.module);
		const key = p ? p.name : '';
		const row = out.get(key) ?? { label: p ? `${p.name}@${p.version}` : OWN_CODE, steps: 0 };
		row.steps += f.self_steps;
		out.set(key, row);
	}
	return out;
}

function package_rows(name: string, base: CaseReport, pr: CaseReport): PackageSteps[] {
	const b = steps_by_package(base);
	const p = steps_by_package(pr);
	if ([...b.keys(), ...p.keys()].every((k) => k === '')) return [];
	let total = 0;
	for (const r of p.values()) total += r.steps;
	const rows: PackageSteps[] = [];
	for (const key of new Set([...b.keys(), ...p.keys()])) {
		const pr_steps = round(p.get(key)?.steps ?? 0);
		rows.push({
			case: name,
			package: (p.get(key) ?? b.get(key))!.label,
			base_steps: round(b.get(key)?.steps ?? 0),
			pr_steps,
			pr_share: total > 0 ? pr_steps / total : 0
		});
	}
	return rows.sort((x, y) => y.pr_steps - x.pr_steps || (x.package < y.package ? -1 : 1));
}

export interface DiffOptions {
	/** `git diff -M --unified=0 base head` of the two commits; null compares lines as they are. */
	files?: FileDiff[] | null;
	/** Body similarity a renamed function needs to match (0..1, default 0.8). */
	rename_threshold?: number;
	/** Prices a recount uses when the two sides differ (default: the current prices.json). */
	prices?: { prices: Prices; hash: string };
	/** The odds model (default: the committed feel.json); null leaves the odds out. */
	feel?: FeelModel | null;
}

const ZERO: Stats = { steps: 0, allocations: 0, bytes: 0 };
const EPS = 1e-6;

function same(a: Stats, b: Stats): boolean {
	return (
		Math.abs(a.steps - b.steps) < EPS &&
		Math.abs(a.allocations - b.allocations) < EPS &&
		Math.abs(a.bytes - b.bytes) < EPS
	);
}

function sub(a: Stats, b: Stats): Stats {
	return {
		steps: round(a.steps - b.steps),
		allocations: round(a.allocations - b.allocations),
		bytes: round(a.bytes - b.bytes)
	};
}

function add_to(acc: Stats, s: Stats): void {
	acc.steps += s.steps;
	acc.allocations += s.allocations;
	acc.bytes += s.bytes;
}

function round(n: number): number {
	return Math.round(n * 1e6) / 1e6;
}

function stats(l: LineReport): Stats {
	return { steps: l.steps, allocations: l.allocations, bytes: l.bytes };
}

function strip(prefix: string, path: string): string | null {
	if (!prefix) return path;
	return path.startsWith(prefix + '/') ? path.slice(prefix.length + 1) : null;
}

/** Longest common subsequence ratio of two block-price shapes (1 = same body). */
export function shape_similarity(a: number[], b: number[]): number {
	if (a.length === 0 && b.length === 0) return 1;
	const prev = new Float64Array(b.length + 1);
	const cur = new Float64Array(b.length + 1);
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
		}
		for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
	}
	return (2 * prev[b.length]) / (a.length + b.length);
}

class Paths {
	/** base module id -> PR module id */
	module_map = new Map<string, string>();
	/** PR module id -> line map */
	line_maps = new Map<string, LineMap>();

	constructor(base: Report, pr: Report, files: FileDiff[] | null | undefined) {
		// An upgraded dependency is the same code under a new version: `svelte@5.1.0/src/x.js` is
		// `svelte@5.2.0/src/x.js`. Its lines are compared as they are (git sees no diff of it).
		const pr_modules = new Map<string, string>();
		for (const c of pr.cases) for (const f of c.functions) pr_modules.set(f.module, f.module);
		const by_unversioned = new Map<string, string>();
		for (const m of pr_modules.keys()) by_unversioned.set(unversioned_module(m), m);
		for (const c of base.cases) {
			for (const f of c.functions) {
				if (pr_modules.has(f.module) || package_of(f.module) === null) continue;
				const to = by_unversioned.get(unversioned_module(f.module));
				if (to !== undefined) this.module_map.set(f.module, to);
			}
		}
		if (!files) return;
		for (const f of files) {
			const pr_id = f.new_path ? strip(pr.git.prefix, f.new_path) : null;
			const base_id = f.old_path ? strip(base.git.prefix, f.old_path) : null;
			if (base_id && pr_id) this.module_map.set(base_id, pr_id);
			if (pr_id) this.line_maps.set(pr_id, new LineMap(f.hunks));
		}
	}

	pr_module(base_module: string): string {
		return this.module_map.get(base_module) ?? base_module;
	}

	lines(pr_module: string): LineMap {
		return this.line_maps.get(pr_module) ?? IDENTITY;
	}
}

function function_change(
	case_name: string,
	b: FunctionReport | null,
	p: FunctionReport | null,
	renamed_from: string | null
): FunctionChange {
	const fb = b ?? null;
	const fp = p ?? null;
	const num = (
		f: FunctionReport | null,
		k: 'self_steps' | 'inclusive_steps' | 'allocations' | 'bytes' | 'calls'
	) => (f ? f[k] : 0);
	const ref = (fp ?? fb)!;
	return {
		case: case_name,
		module: ref.module,
		function: ref.path,
		renamed_from,
		line: ref.line,
		base: fb,
		pr: fp,
		delta: {
			self_steps: round(num(fp, 'self_steps') - num(fb, 'self_steps')),
			inclusive_steps: round(num(fp, 'inclusive_steps') - num(fb, 'inclusive_steps')),
			allocations: num(fp, 'allocations') - num(fb, 'allocations'),
			bytes: round(num(fp, 'bytes') - num(fb, 'bytes')),
			calls: num(fp, 'calls') - num(fb, 'calls')
		},
		findings: []
	};
}

/** Put the change of one matched function on lines. */
function localize(
	case_name: string,
	b: FunctionReport,
	p: FunctionReport,
	lmap: LineMap
): Finding[] {
	const out: Finding[] = [];
	const finding = (kind: FindingKind, line: number, base: Stats | null, pr: Stats | null): void => {
		out.push({
			case: case_name,
			kind,
			module: p.module,
			function: p.path,
			line,
			base,
			pr,
			delta: sub(pr ?? ZERO, base ?? ZERO)
		});
	};
	const base_lines = new Map(b.lines.map((l) => [l.line, l]));
	const consumed = new Set<number>();
	const hunk_pr = new Map<number, LineReport[]>();
	const hunk_base = new Map<number, LineReport[]>();

	for (const pl of p.lines) {
		const h = lmap.added_in(pl.line);
		if (h >= 0) {
			const list = hunk_pr.get(h) ?? [];
			list.push(pl);
			hunk_pr.set(h, list);
			continue;
		}
		const ol = lmap.backward(pl.line);
		const bl = ol === null ? undefined : base_lines.get(ol);
		if (ol !== null) consumed.add(ol);
		const bs = bl ? stats(bl) : ZERO;
		if (!same(bs, stats(pl))) finding('changed', pl.line, bl ? bs : null, stats(pl));
	}
	for (const bl of b.lines) {
		if (consumed.has(bl.line)) continue;
		const h = lmap.removed_in(bl.line);
		if (h >= 0) {
			const list = hunk_base.get(h) ?? [];
			list.push(bl);
			hunk_base.set(h, list);
			continue;
		}
		const nl = lmap.forward(bl.line);
		if (nl !== null && (bl.steps !== 0 || bl.allocations !== 0))
			finding('changed', nl, stats(bl), null);
	}
	const hunks = new Set([...hunk_pr.keys(), ...hunk_base.keys()]);
	for (const h of [...hunks].sort((x, y) => x - y)) {
		const added = (hunk_pr.get(h) ?? []).filter(costly);
		const removed = (hunk_base.get(h) ?? []).filter(costly);
		const pr_sum = { ...ZERO };
		for (const l of added) add_to(pr_sum, stats(l));
		const base_sum = { ...ZERO };
		for (const l of removed) add_to(base_sum, stats(l));
		// A reformatted or renamed hunk costs the same as a whole, however its lines split.
		if (same(pr_sum, base_sum)) continue;
		// Lines rewritten at the same cost cancel out (`f(r)` -> `f(copy)`).
		const left = [...removed];
		const fresh: LineReport[] = [];
		for (const a of added) {
			const i = left.findIndex((r) => same(stats(r), stats(a)));
			if (i === -1) fresh.push(a);
			else left.splice(i, 1);
		}
		if (fresh.length === left.length) {
			// one-for-one rewrites: the PR line against the line it replaced
			for (let i = 0; i < fresh.length; i++) {
				finding('changed', fresh[i].line, stats(left[i]), stats(fresh[i]));
			}
			continue;
		}
		for (const a of fresh) finding('new code', a.line, null, stats(a));
		if (left.length > 0) {
			const gone = { ...ZERO };
			for (const r of left) add_to(gone, stats(r));
			finding(
				'removed code',
				fresh.length > 0 ? fresh[0].line : lmap.hunks[h].new_start,
				gone,
				null
			);
		}
	}
	return out;
}

function costly(l: LineReport): boolean {
	return l.steps !== 0 || l.allocations !== 0;
}

function diff_case(
	name: string,
	base: CaseReport,
	pr: CaseReport,
	paths: Paths,
	threshold: number,
	inclusive = true
): {
	changes: FunctionChange[];
	renames: Array<{ case: string; from: string; to: string }>;
} {
	const changes: FunctionChange[] = [];
	const renames: Array<{ case: string; from: string; to: string }> = [];
	const pr_by_id = new Map(pr.functions.map((f) => [f.id, f]));
	const matched_pr = new Set<string>();
	const pairs: Array<[FunctionReport, FunctionReport, string | null]> = [];
	const unmatched_base: FunctionReport[] = [];

	for (const b of base.functions) {
		const target = `${paths.pr_module(b.module)} > ${b.path}`;
		const p = pr_by_id.get(target);
		if (p) {
			pairs.push([b, p, null]);
			matched_pr.add(p.id);
		} else {
			unmatched_base.push(b);
		}
	}
	const unmatched_pr = pr.functions.filter((f) => !matched_pr.has(f.id));

	// Renamed functions: same module, same (or nearly the same) body shape. A function inside a
	// renamed one is the same function under the new name (`a > map:0` is `b > map:0` once `a` is
	// `b`), so outer functions are matched first and their insides follow by path. At each depth the
	// best-scoring pair goes first: one base function taking a sibling's better match leaves that
	// sibling to a worse one.
	//
	// A function whose own code changed keeps its place (identity.ts `context_path`): the same path
	// without shape hashes, under the PR path its enclosing function was matched to. A callback
	// edited past the shape threshold is still the callback in that slot, and is not a rename.
	const matched_base = new Set<string>();
	const pr_path_of = new Map<string, string>();
	for (const [b, p] of pairs) pr_path_of.set(b.id, p.path);
	const place = (b: FunctionReport): string => {
		const at = b.path.lastIndexOf(' > ');
		const outer = at === -1 ? undefined : pr_path_of.get(`${b.module} > ${b.path.slice(0, at)}`);
		return outer === undefined
			? context_path(b.path)
			: context_path(outer) + context_path(b.path.slice(at));
	};
	const accept = (b: FunctionReport, p: FunctionReport): void => {
		const moved = context_path(b.path) !== context_path(p.path);
		pairs.push([b, p, moved ? b.path : null]);
		matched_base.add(b.id);
		matched_pr.add(p.id);
		pr_path_of.set(b.id, p.path);
		if (moved) renames.push({ case: name, from: b.id, to: p.id });
		const inside = `${b.path} > `;
		for (const c of unmatched_base) {
			if (matched_base.has(c.id) || !c.path.startsWith(inside)) continue;
			const q = pr_by_id.get(`${p.module} > ${p.path} > ${c.path.slice(inside.length)}`);
			if (q && !matched_pr.has(q.id) && q.kind === c.kind) accept(c, q);
		}
	};
	const depth = (f: FunctionReport): number => f.path.split(' > ').length;
	const depths = [...new Set(unmatched_base.map(depth))].sort((x, y) => x - y);
	for (const d of depths) {
		const candidates: Array<{ b: FunctionReport; p: FunctionReport; score: number }> = [];
		for (const b of unmatched_base) {
			if (matched_base.has(b.id) || depth(b) !== d) continue;
			const module = paths.pr_module(b.module);
			const mapped = paths.lines(module).forward(b.line);
			const at = place(b);
			for (const p of unmatched_pr) {
				if (matched_pr.has(p.id) || p.module !== module || p.kind !== b.kind) continue;
				let score = shape_similarity(b.shape, p.shape);
				if (mapped === p.line) score += 0.01;
				// same place first, whatever its shape; the most alike first among several
				if (context_path(p.path) === at) score += 1;
				if (score >= threshold) candidates.push({ b, p, score });
			}
		}
		// stable: equal scores keep base order, then PR order
		candidates.sort((x, y) => y.score - x.score);
		for (const c of candidates) {
			if (!matched_base.has(c.b.id) && !matched_pr.has(c.p.id)) accept(c.b, c.p);
		}
	}
	const still_base = unmatched_base.filter((b) => !matched_base.has(b.id));

	for (const [b, p, renamed_from] of pairs) {
		const change = function_change(name, b, p, renamed_from);
		// After a recount inclusive steps still carry the old prices (recount.ts): not compared.
		if (!inclusive) change.delta.inclusive_steps = 0;
		const own_same =
			Math.abs(change.delta.self_steps) < EPS &&
			change.delta.allocations === 0 &&
			Math.abs(change.delta.bytes) < EPS;
		if (own_same) {
			if (Math.abs(change.delta.inclusive_steps) >= EPS || change.delta.calls !== 0) {
				changes.push(change); // context only: callers of a changed function
			}
			continue;
		}
		change.findings = localize(name, b, p, paths.lines(p.module));
		if (change.findings.length === 0) {
			change.findings.push({
				case: name,
				kind: 'changed',
				module: p.module,
				function: p.path,
				line: p.line,
				base: { steps: b.self_steps, allocations: b.allocations, bytes: b.bytes },
				pr: { steps: p.self_steps, allocations: p.allocations, bytes: p.bytes },
				delta: {
					steps: change.delta.self_steps,
					allocations: change.delta.allocations,
					bytes: change.delta.bytes
				}
			});
		}
		changes.push(change);
	}
	for (const p of unmatched_pr) {
		if (matched_pr.has(p.id)) continue;
		const change = function_change(name, null, p, null);
		if (p.self_steps !== 0 || p.allocations !== 0) {
			const s = { steps: p.self_steps, allocations: p.allocations, bytes: p.bytes };
			change.findings.push({
				case: name,
				kind: 'new function',
				module: p.module,
				function: p.path,
				line: p.line,
				base: null,
				pr: s,
				delta: s
			});
		}
		changes.push(change);
	}
	for (const b of still_base) {
		const change = function_change(name, b, null, null);
		const s = { steps: b.self_steps, allocations: b.allocations, bytes: b.bytes };
		change.findings.push({
			case: name,
			kind: 'removed function',
			module: b.module,
			function: b.path,
			line: b.line,
			base: s,
			pr: null,
			delta: sub(ZERO, s)
		});
		changes.push(change);
	}
	return { changes, renames };
}

export function diff_reports(
	base_report: Report,
	pr_report: Report,
	opts: DiffOptions = {}
): DiffResult {
	// A price change recounts both sides with one price file (recount.ts).
	const aligned = align_prices(base_report, pr_report, opts.prices);
	const { base, pr } = aligned;
	const paths = new Paths(base, pr, opts.files);
	const threshold = opts.rename_threshold ?? 0.8;
	const result: DiffResult = {
		changes: [],
		findings: [],
		renames: [],
		unstable: [],
		failed: [],
		missing: { base: [], pr: [] },
		cases: [],
		packages: [],
		prices_match: aligned.comparable,
		recounted: aligned.recounted,
		env: env_mismatch(base_report, pr_report)
	};
	const paired = pair_cases(base.cases, pr.cases);
	// A file that did not load on one side has no cases there: its cases on the other side are
	// not new or removed, they did not run.
	const not_run = (errors: Report['load_errors'], other: CaseReport[]): NotRun[] =>
		(errors ?? []).map((e) => ({
			file: e.file,
			error: e.error,
			cases: other.filter((c) => c.file === e.file).map((c) => c.name)
		}));
	const did_not_run = {
		base: not_run(base_report.load_errors, paired.only_pr),
		pr: not_run(pr_report.load_errors, paired.only_base)
	};
	if (did_not_run.base.length > 0 || did_not_run.pr.length > 0) result.did_not_run = did_not_run;
	const failed_on = (list: NotRun[]) => new Set(list.map((n) => n.file));
	const base_failed = failed_on(did_not_run.base);
	const pr_failed = failed_on(did_not_run.pr);
	for (const bc of paired.only_base) if (!pr_failed.has(bc.file)) result.missing.pr.push(bc.name);
	for (const pc of paired.only_pr) if (!base_failed.has(pc.file)) result.missing.base.push(pc.name);
	result.summary = summarize_cases(pr_report);
	for (const [bc, pc] of paired.pairs) {
		// A case that failed on either side has no counts to compare: listed, not diffed.
		if (bc.error || pc.error) {
			result.failed.push(bc.name);
			continue;
		}
		if (!bc.stable || !pc.stable) result.unstable.push(bc.name);
		result.cases.push({ name: bc.name, base_steps: bc.totals.steps, pr_steps: pc.totals.steps });
		result.packages.push(...package_rows(bc.name, bc, pc));
		const d = diff_case(bc.name, bc, pc, paths, threshold, aligned.recounted === null);
		result.changes.push(...d.changes);
		result.renames.push(...d.renames);
	}
	for (const c of result.changes) result.findings.push(...c.findings);
	result.measure = measure_diff(result, base, pr);
	const feel = case_odds(paired.pairs, result, opts);
	if (feel) result.feel = feel;
	return result;
}

/** The odds model's guess for each compared case whose steps changed (null: no model, no prices). */
function case_odds(
	pairs: Array<[CaseReport, CaseReport]>,
	result: DiffResult,
	opts: DiffOptions
): FeelOdds | null {
	let model: FeelModel | null;
	try {
		model = opts.feel === undefined ? load_feel_model() : opts.feel;
	} catch {
		// the odds are extra words: a model file that does not load leaves them out, never the diff
		model = null;
	}
	if (!model || !result.prices_match) return null;
	const prices = (opts.prices ?? load_prices()).prices;
	const odds: Record<string, number> = {};
	for (const [bc, pc] of pairs) {
		if (bc.error || pc.error || bc.totals.steps === pc.totals.steps) continue;
		const input = feel_input(bc, pc, prices);
		const p = input ? feel_probability(model, input) : null;
		if (p !== null) odds[bc.name] = Math.round(p * 1000) / 1000;
	}
	return { dataset: model.dataset.version, pairs: model.dataset.pairs, odds };
}
