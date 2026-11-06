import { IDENTITY, LineMap } from './git.ts';
import type { FileDiff } from './git.ts';
import type { CaseReport, FunctionReport, LineReport, Report } from '../report.ts';

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
	missing: { base: string[]; pr: string[] };
	cases: Array<{ name: string; base_steps: number; pr_steps: number }>;
	prices_match: boolean;
}

export interface DiffOptions {
	/** `git diff -M --unified=0 base head` of the two commits; null compares lines as they are. */
	files?: FileDiff[] | null;
	/** Body similarity a renamed function needs to match (0..1, default 0.8). */
	rename_threshold?: number;
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
	threshold: number
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

	// Renamed functions: same module, same (or nearly the same) body shape.
	const still_base: FunctionReport[] = [];
	for (const b of unmatched_base) {
		const module = paths.pr_module(b.module);
		let best: FunctionReport | null = null;
		let best_score = threshold;
		for (const p of unmatched_pr) {
			if (matched_pr.has(p.id) || p.module !== module || p.kind !== b.kind) continue;
			let score = shape_similarity(b.shape, p.shape);
			const mapped = paths.lines(module).forward(b.line);
			if (mapped === p.line) score += 0.01;
			if (score >= best_score) {
				best = p;
				best_score = score;
			}
		}
		if (best) {
			pairs.push([b, best, b.path]);
			matched_pr.add(best.id);
			renames.push({ case: name, from: b.id, to: best.id });
		} else {
			still_base.push(b);
		}
	}

	for (const [b, p, renamed_from] of pairs) {
		const change = function_change(name, b, p, renamed_from);
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

export function diff_reports(base: Report, pr: Report, opts: DiffOptions = {}): DiffResult {
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
		prices_match: base.prices.hash === pr.prices.hash
	};
	const pr_cases = new Map(pr.cases.map((c) => [c.name, c]));
	const base_names = new Set(base.cases.map((c) => c.name));
	for (const bc of base.cases) {
		const pc = pr_cases.get(bc.name);
		if (!pc) {
			result.missing.pr.push(bc.name);
			continue;
		}
		if (bc.error || pc.error) result.failed.push(bc.name);
		if (!bc.stable || !pc.stable) result.unstable.push(bc.name);
		result.cases.push({ name: bc.name, base_steps: bc.totals.steps, pr_steps: pc.totals.steps });
		const d = diff_case(bc.name, bc, pc, paths, threshold);
		result.changes.push(...d.changes);
		result.renames.push(...d.renames);
	}
	for (const pc of pr.cases) if (!base_names.has(pc.name)) result.missing.base.push(pc.name);
	for (const c of result.changes) result.findings.push(...c.findings);
	return result;
}
