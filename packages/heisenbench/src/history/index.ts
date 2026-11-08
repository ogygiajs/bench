import { dirname } from 'node:path';
import { case_key } from '../cases.ts';
import { context_path } from '../identity.ts';
import { load_prices } from '../prices.ts';
import { recount_units } from '../recount.ts';
import { report_of } from '../report.ts';
import type { CaseReport, Report } from '../report.ts';
import { normalize, sha256 } from '../cache/normalize.ts';
import { Git } from './git.ts';
import { align_lines } from './align.ts';

/*
 * History blame for speed: for every line of a module, which commit last made it cost more or
 * less, and by how much. `git blame` says who wrote a line; this says who changed what it costs,
 * which is often a commit that never touched it (a caller that stopped calling it per item).
 *
 * The data: one report per commit of a first-parent line (main), each counting the same bench
 * cases (the results branch keeps a full run per main commit; `suites/ogygia/src/history.ts`
 * counts the commits it lacks with one set of bench files, reusing every unchanged case).
 *
 * Following a line back. From the newest run to the oldest, each line is placed at the commit
 * before by, in order:
 *
 *   1. `git blame -M -C <before>..<after>`: a line no commit in between wrote is blamed on the
 *      run before, at its line and path there, through moves inside the file and moves or copies
 *      from another file
 *   2. its function: a function is the same function when its id is (`module > path`), or its
 *      place is (`context_path`, the id without the shape hash an edit changes), or it holds most
 *      of the lines step 1 placed, or it has the same place in another module (a moved file); the
 *      lines of a matched function that step 1 left are paired by their text, in order
 *   3. its hunk: what is left in the file is paired by text inside each `git diff` hunk
 *
 * A line edited in place (2 or 3) keeps its history; one with no partner was new at that commit.
 *
 * A change at one commit is the line's steps after minus before, summed over the cases both runs
 * counted with the same input: a case that only one run has, or whose bench files changed (by
 * their text as counting sees it: comments do not count), is left out and named. Steps are exact,
 * so any change is a change. Two runs counted with other prices are priced again from the units
 * they keep (recount.ts), line by line where a whole report cannot be; a line whose units cannot
 * be priced makes that change unpriced. A change of the counter (another Heisenbench or Node) is
 * marked: steps can move with it, and the newest change that is not marked is the one blamed.
 */

export const HISTORY_SCHEMA = 'heisenbench-history/1';

/** One run of the history: a report of one commit, and what counted it. */
export interface HistoryRun {
	sha: string;
	report: Report;
	/** The Heisenbench commit and the Node that counted (null parts: not recorded). */
	counter: string;
	/** The commit whose bench files counted it (null: its own). */
	bench: string | null;
	/** The file it was read from. */
	source: string;
}

/**
 * A run from a JSON file: a report (`heisenbench run --out`), or a run file that holds one under
 * `head` (the results branch's `result.json`, the history backfill's files) with `meta.sha`,
 * `meta.heisenbench` (the counter) and `meta.bench` (the commit of its bench files).
 */
export function run_of(json: unknown, source: string): HistoryRun | null {
	if (json === null || typeof json !== 'object') return null;
	const o = json as {
		schema?: string;
		head?: Report | null;
		meta?: {
			sha?: string;
			heisenbench?: string | null;
			/** The counter's commit in a run file written under the engine's former name. */
			abax?: string | null;
			bench?: string | null;
			node?: string;
		};
	};
	const whole = report_of(json);
	const report = whole ?? report_of(o.head);
	if (!report || !Array.isArray(report.cases)) return null;
	const sha = o.meta?.sha ?? report.git?.sha;
	if (!sha) return null;
	const engine = whole ? null : (o.meta?.heisenbench ?? o.meta?.abax ?? null);
	return {
		sha,
		report: slim(report),
		counter: `${engine ?? '?'} ${report.node ?? o.meta?.node ?? '?'}`,
		bench: whole ? null : (o.meta?.bench ?? null),
		source
	};
}

/**
 * The report with only what a history reads: per function its place, calls, self steps, units and
 * lines. Blocks, sites, edges and the other layers' sections are dropped, so a long history holds
 * less than the runs' files.
 */
function slim(r: Report): Report {
	const out: Report = {
		schema: r.schema,
		prices: r.prices,
		node: r.node,
		git: r.git,
		cases: r.cases.map((c) => ({
			...c,
			measure: undefined,
			edges: [],
			functions: c.functions.map((f) => ({ ...f, blocks: [], sites: [], builtins: [], shape: [] }))
		}))
	};
	if (r.unit_terms) out.unit_terms = r.unit_terms;
	return out;
}

export interface CommitRef {
	sha: string;
	subject: string;
	/** The PR number in the subject (`... (#186)`), when it has one. */
	pr: number | null;
}

export interface HistoryEvent {
	/** The run the change shows at (index into `runs`), and the run before it. */
	run: number;
	/** The first-parent commits between the two runs: one when no commit was skipped. */
	commits: CommitRef[];
	kind: 'changed' | 'new code';
	/** The line was edited at this change (paired by its text, not its origin). */
	edited: boolean;
	/** Steps before and after, over the cases both runs counted alike; null: not priced alike. */
	before: number | null;
	after: number | null;
	delta: number | null;
	/** delta / before (null when before is 0 or unknown). */
	ratio: number | null;
	/** Another Heisenbench or Node counted the two runs: steps can move with the counter. */
	counter_changed: boolean;
	/** The line's units cannot be priced with the current prices in one of the runs. */
	unpriced: boolean;
}

export interface HistoryLine {
	line: number;
	text: string;
	/** The function that counted the line at the newest run (else the innermost that holds it). */
	function: string | null;
	/** Steps today: the newest run, every case. */
	steps: number;
	/** Calls of its function today, and steps per call. */
	calls: number;
	per_call: number | null;
	/** The newest change that is not marked (counter, prices); null: none in the history. */
	last: HistoryEvent | null;
	/** Every change, oldest first. */
	events: HistoryEvent[];
	/** Where the line was at each run (null: not there yet), oldest first. */
	at: Array<{ path: string; line: number } | null>;
}

export interface TimelineRow {
	run: number;
	/** The function's id at that run (it changes with a rename or a move). */
	id: string;
	/** Self steps and calls over the newest run's cases that this run counted. */
	steps: number | null;
	calls: number;
	/** The change from the run before (null at its first run); same rules as a line's. */
	change: HistoryEvent | null;
}

export interface HistoryFunction {
	id: string;
	line: number;
	end_line: number;
	steps: number;
	calls: number;
	last: HistoryEvent | null;
	/** Oldest first: one row per run the function ran in. */
	timeline: TimelineRow[];
	/** Earlier ids, oldest first (renames and moves). */
	was: string[];
}

export interface HistoryRunInfo extends CommitRef {
	counter: string;
	/** `as counted`, `recounted` (every line), `partly recounted` (some lines cannot be priced). */
	prices: 'as counted' | 'recounted' | 'partly recounted';
	/** Lines of the module that could not be priced again. */
	unpriced_lines: number;
	cases: number;
	source: string;
}

export interface HistoryTransition {
	run: number;
	commits: CommitRef[];
	counter_changed: boolean;
	/** Cases left out of this change: bench files changed, or only one run counted them. */
	bench_changed: string[];
	only_before: string[];
	only_after: string[];
}

export interface HistoryResult {
	schema: typeof HISTORY_SCHEMA;
	/** The module at the newest run, and the function asked for. */
	file: string;
	function: string | null;
	/** The runs read, oldest first; the last is "today". */
	runs: HistoryRunInfo[];
	transitions: HistoryTransition[];
	lines: HistoryLine[];
	functions: HistoryFunction[];
	notes: string[];
	ms: number;
}

export interface HistoryOptions {
	repo: string;
	/** The module (relative to the git top level) and, optionally, one function's name. */
	file: string;
	function?: string | null;
	runs: HistoryRun[];
	/** The newest commit to look at (default HEAD): runs off its first-parent line are left out. */
	rev?: string;
	/** Prices every run is priced with (default: the current prices.json). */
	prices?: ReturnType<typeof load_prices>;
}

const EPS = 1e-6;

function round(n: number): number {
	return Math.round(n * 1e6) / 1e6;
}

export function pr_of(subject: string): number | null {
	const m = /\(#(\d+)\)\s*$/.exec(subject);
	return m ? Number(m[1]) : null;
}

/** The innermost function of a line: the smallest span that holds it. */
interface FnSpan {
	id: string;
	path: string;
	place: string;
	module: string;
	line: number;
	end_line: number;
	/** case key -> self steps (null: not priced) and calls */
	by_case: Map<string, { steps: number | null; calls: number }>;
}

interface ModuleIndex {
	/** line -> case key -> steps (null: not priced) */
	lines: Map<number, Map<string, number | null>>;
	/** line -> the function that counted it (the one with the most steps on it) */
	counted_by: Map<number, { fn: FnSpan; steps: number }>;
	functions: FnSpan[];
	unpriced: number;
}

/** One run, read for the history: its cases, priced with the current prices. */
class RunData {
	readonly run: HistoryRun;
	readonly cases = new Map<string, CaseReport>();
	readonly as_counted: boolean;
	#modules = new Map<string, ModuleIndex>();
	#places: Map<string, FnSpan[]> | null = null;
	#owners = new Map<string, Array<FnSpan | undefined>>();
	#prices: NonNullable<HistoryOptions['prices']>;
	unpriced_lines = 0;

	constructor(run: HistoryRun, prices: NonNullable<HistoryOptions['prices']>) {
		this.run = run;
		this.#prices = prices;
		this.as_counted = run.report.prices.hash === prices.hash;
		for (const c of run.report.cases) if (!c.error) this.cases.set(case_key(c), c);
	}

	#price(u: Parameters<typeof recount_units>[0], steps: number): number | null {
		if (this.as_counted) return steps;
		return recount_units(u, this.#prices.prices, this.run.report.unit_terms);
	}

	/** A module id of the report as a path in git (the run root may sit below the top level). */
	git_path(module: string): string {
		const p = this.run.report.git.prefix;
		return p ? `${p}/${module}` : module;
	}

	/** The functions and lines of one file (a path in git). */
	module(path: string): ModuleIndex {
		let m = this.#modules.get(path);
		if (m) return m;
		m = { lines: new Map(), counted_by: new Map(), functions: [], unpriced: 0 };
		const spans = new Map<string, FnSpan>();
		for (const [key, c] of this.cases) {
			for (const f of c.functions) {
				if (this.git_path(f.module) !== path) continue;
				let s = spans.get(f.id);
				if (!s) {
					s = {
						id: f.id,
						path: f.path,
						place: context_path(f.path),
						module: path,
						line: f.line,
						end_line: f.end_line,
						by_case: new Map()
					};
					spans.set(f.id, s);
				}
				s.by_case.set(key, { steps: this.#price(f.units, f.self_steps), calls: f.calls });
				for (const l of f.lines) {
					let cell = m.lines.get(l.line);
					if (!cell) m.lines.set(l.line, (cell = new Map()));
					const v = this.#price(l.units, l.steps);
					if (v === null) m.unpriced++;
					const had = cell.get(key);
					cell.set(key, v === null || had === null ? null : round((had ?? 0) + v));
					const by = m.counted_by.get(l.line);
					if (!by || (by.fn !== s && l.steps > by.steps))
						m.counted_by.set(l.line, { fn: s, steps: l.steps });
				}
			}
		}
		m.functions = [...spans.values()];
		this.unpriced_lines += m.unpriced;
		this.#modules.set(path, m);
		return m;
	}

	/** Functions of every module by their place (`context_path`), for a function that moved files. */
	by_place(place: string): FnSpan[] {
		if (!this.#places) {
			this.#places = new Map();
			const seen = new Set<string>();
			for (const c of this.cases.values()) {
				for (const f of c.functions) {
					if (seen.has(f.id)) continue;
					seen.add(f.id);
					const p = context_path(f.path);
					const list = this.#places.get(p) ?? [];
					list.push({
						id: f.id,
						path: f.path,
						place: p,
						module: this.git_path(f.module),
						line: f.line,
						end_line: f.end_line,
						by_case: new Map()
					});
					this.#places.set(p, list);
				}
			}
		}
		return this.#places.get(place) ?? [];
	}

	/** The innermost function that holds a line, among those that ran. */
	owner(path: string, line: number): FnSpan | null {
		let lines = this.#owners.get(path);
		if (!lines) {
			lines = [];
			// widest first, so each narrower function paints over the one around it
			const fns = [...this.module(path).functions].sort(
				(x, y) => y.end_line - y.line - (x.end_line - x.line)
			);
			for (const f of fns) for (let l = f.line; l <= f.end_line; l++) lines[l] = f;
			this.#owners.set(path, lines);
		}
		return lines[line] ?? null;
	}
}

interface Pos {
	path: string;
	line: number;
}

const pos_key = (p: Pos): string => `${p.path}:${p.line}`;

/** How each placed line at `cur` sits at `prev` (null: it was new), and each function's partner. */
interface Step {
	lines: Map<string, { at: Pos; edited: boolean } | null>;
	functions: Map<string, string | null>;
}

/**
 * Place lines (and functions) of run `cur` at run `prev`: blame origins first, then functions,
 * then hunks (see the comment at the top).
 */
function step_back(
	git: Git,
	prev: RunData,
	cur: RunData,
	wanted: Pos[],
	wanted_fns: FnSpan[]
): Step {
	const a = prev.run.sha;
	const b = cur.run.sha;
	const out: Step = { lines: new Map(), functions: new Map() };
	const taken = new Set<string>();
	const place = (p: Pos, at: Pos, edited: boolean): void => {
		out.lines.set(pos_key(p), { at, edited });
		taken.add(pos_key(at));
	};
	const renames = git.renames(a, b);
	const old_path = (path: string): string => renames.get(path) ?? path;

	// 1. blame: a line that no commit after `prev` wrote is blamed on `prev`, at its place there
	const files = new Set(wanted.map((p) => p.path));
	for (const path of files) {
		const blame = git.blame_since(a, b, path);
		if (!blame) continue;
		for (const p of wanted) {
			if (p.path !== path) continue;
			const o = blame[p.line - 1];
			if (!o || o.commit !== a) continue;
			const at = { path: o.path, line: o.line };
			if (!taken.has(pos_key(at))) place(p, at, false);
		}
	}

	// 2. functions: by id, by place, by the lines blame placed, by place in another module, and
	// last by a function inside it (`A > #x > walk` is `A > #y > walk`: `#x` is `#y`, renamed)
	const partner = new Map<string, FnSpan>();
	const matched_prev = new Set<string>();
	const accept = (f: FnSpan, g: FnSpan | null): void => {
		if (!g || matched_prev.has(g.id)) return;
		partner.set(f.id, g);
		matched_prev.add(g.id);
	};
	for (const f of wanted_fns) {
		const module = old_path(f.module);
		const there = prev.module(module).functions;
		let g = there.find((x) => x.path === f.path) ?? null;
		if (!g) {
			const same = there.filter((x) => x.place === f.place);
			if (same.length === 1) g = same[0];
		}
		if (!g) {
			// the function at `prev` that holds most of the lines blame placed
			const votes = new Map<string, { fn: FnSpan; n: number }>();
			for (const p of wanted) {
				if (p.path !== f.module || p.line < f.line || p.line > f.end_line) continue;
				if (cur.owner(p.path, p.line)?.id !== f.id) continue;
				const at = out.lines.get(pos_key(p))?.at;
				const o = at ? prev.owner(at.path, at.line) : null;
				if (!o) continue;
				const v = votes.get(o.id) ?? { fn: o, n: 0 };
				v.n++;
				votes.set(o.id, v);
			}
			let best: { fn: FnSpan; n: number } | null = null;
			for (const v of votes.values()) if (!best || v.n > best.n) best = v;
			if (best) g = best.fn;
		}
		if (!g) {
			const moved = prev.by_place(f.place).filter((x) => x.module !== module);
			if (moved.length === 1)
				g = prev.module(moved[0].module).functions.find((x) => x.id === moved[0].id) ?? null;
		}
		accept(f, g);
	}
	const parent_path = (path: string): string | null => {
		const at = path.lastIndexOf(' > ');
		return at === -1 ? null : path.slice(0, at);
	};
	for (const f of wanted_fns) {
		if (partner.has(f.id)) continue;
		for (const c of wanted_fns) {
			const g = partner.get(c.id);
			if (!g || c.module !== f.module || parent_path(c.path) !== f.path) continue;
			const up = parent_path(g.path);
			const there = up === null ? null : prev.module(g.module).functions.find((x) => x.path === up);
			if (there) {
				accept(f, there);
				break;
			}
		}
	}
	for (const f of wanted_fns) {
		const g = partner.get(f.id) ?? null;
		out.functions.set(f.id, g ? g.id : null);
		if (!g) continue;
		// the lines of f that blame did not place, against the free lines of g, by their text
		const left: number[] = [];
		for (const p of wanted) {
			if (p.path !== f.module || p.line < f.line || p.line > f.end_line) continue;
			if (!out.lines.has(pos_key(p)) && cur.owner(p.path, p.line)?.id === f.id) left.push(p.line);
		}
		const free: number[] = [];
		for (let l = g.line; l <= g.end_line; l++) {
			if (!taken.has(pos_key({ path: g.module, line: l })) && prev.owner(g.module, l)?.id === g.id)
				free.push(l);
		}
		pair_by_text(git, a, b, g.module, f.module, free, left, (from, to) =>
			place({ path: f.module, line: to }, { path: g.module, line: from }, true)
		);
	}

	// 3. hunks
	const asked = new Set(wanted.map(pos_key));
	for (const path of files) {
		const old = old_path(path);
		if (!git.lines(a, old)) continue;
		const d = git.hunks(a, b, old, path);
		if (!d) continue;
		for (const h of d.hunks) {
			const left: number[] = [];
			for (let l = h.new_start; l < h.new_start + h.new_count; l++) {
				const k = pos_key({ path, line: l });
				if (!out.lines.has(k) && asked.has(k)) left.push(l);
			}
			const free: number[] = [];
			for (let l = h.old_start; l < h.old_start + h.old_count; l++) {
				if (!taken.has(pos_key({ path: old, line: l }))) free.push(l);
			}
			pair_by_text(git, a, b, old, path, free, left, (from, to) =>
				place({ path, line: to }, { path: old, line: from }, true)
			);
		}
	}
	for (const p of wanted) if (!out.lines.has(pos_key(p))) out.lines.set(pos_key(p), null);
	return out;
}

function pair_by_text(
	git: Git,
	a: string,
	b: string,
	old_path: string,
	new_path: string,
	old_lines: number[],
	new_lines: number[],
	place: (from: number, to: number) => void
): void {
	if (old_lines.length === 0 || new_lines.length === 0) return;
	const ta = git.lines(a, old_path) ?? [];
	const tb = git.lines(b, new_path) ?? [];
	const pairs = align_lines(
		old_lines.map((l) => ta[l - 1] ?? ''),
		new_lines.map((l) => tb[l - 1] ?? '')
	);
	for (const [i, j] of pairs) place(old_lines[i], new_lines[j]);
}

/**
 * What builds a case's input: its bench file and the helpers and fixtures beside it (every file of
 * its directory that is not another bench file), by their text as counting sees it (comments and
 * layout left out, cache/normalize.ts).
 */
class BenchInputs {
	#git: Git;
	#hash = new Map<string, string | null>();

	constructor(git: Git) {
		this.#git = git;
	}

	/** A hash of what builds the case's input at `rev` (null: its bench file is not there). */
	of(rev: string, file: string): string | null {
		const key = `${rev}:${file}`;
		if (this.#hash.has(key)) return this.#hash.get(key)!;
		let h: string | null = null;
		if (this.#git.object(rev, file) !== null) {
			const dir = dirname(file);
			const names = this.#git.files(rev, dir).filter((n) => n === file || !n.endsWith('.bench.ts'));
			const parts: string[] = [];
			for (const n of names) {
				const text = (this.#git.lines(rev, n) ?? []).join('\n');
				const norm = /\.[mc]?[jt]sx?$/.test(n) ? normalize(text, n) : null;
				parts.push(n, norm ? norm.hash : sha256(text));
			}
			h = sha256(parts.join('\0'));
		}
		this.#hash.set(key, h);
		return h;
	}
}

/**
 * The cases two runs counted alike: in both, no error, and the same bench files. The rest are
 * named, so a change is never put on code when the input moved.
 */
function common_cases(
	inputs: BenchInputs,
	prev: RunData,
	cur: RunData
): { keys: string[]; bench_changed: string[]; only_before: string[]; only_after: string[] } {
	const keys: string[] = [];
	const bench_changed: string[] = [];
	const only_before: string[] = [];
	const only_after: string[] = [];
	const rev = (r: RunData) => r.run.bench ?? r.run.sha;
	for (const [k, c] of cur.cases) {
		if (!prev.cases.has(k)) {
			only_after.push(k);
			continue;
		}
		if (rev(prev) !== rev(cur) && inputs.of(rev(prev), c.file) !== inputs.of(rev(cur), c.file))
			bench_changed.push(k);
		else keys.push(k);
	}
	for (const k of prev.cases.keys()) if (!cur.cases.has(k)) only_before.push(k);
	return { keys, bench_changed, only_before, only_after };
}

function sum_cells(cells: Map<string, number | null> | undefined, keys: string[]): number | null {
	let s = 0;
	for (const k of keys) {
		const v = cells?.get(k);
		if (v === null) return null;
		s += v ?? 0;
	}
	return round(s);
}

function sum_fn(
	fn: FnSpan | null,
	keys: Iterable<string>
): { steps: number | null; calls: number } {
	let steps: number | null = 0;
	let calls = 0;
	for (const k of keys) {
		const v = fn?.by_case.get(k);
		if (!v) continue;
		calls += v.calls;
		if (v.steps === null || steps === null) steps = null;
		else steps += v.steps;
	}
	return { steps: steps === null ? null : round(steps), calls };
}

function event_of(
	run: number,
	t: HistoryTransition,
	before: number | null,
	after: number | null,
	kind: HistoryEvent['kind'],
	edited: boolean
): HistoryEvent | null {
	const unpriced = before === null || after === null;
	const delta = unpriced ? null : round(after - before);
	if (delta !== null && Math.abs(delta) < EPS) return null;
	if (unpriced && kind === 'new code') return null;
	return {
		run,
		commits: t.commits,
		kind,
		edited,
		before,
		after,
		delta,
		ratio: delta !== null && before !== null && before > 0 ? delta / before : null,
		counter_changed: t.counter_changed,
		unpriced
	};
}

/** The newest change that is not marked, else the newest one. */
function last_of(events: HistoryEvent[]): HistoryEvent | null {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (!e.counter_changed && !e.unpriced) return e;
	}
	return events.at(-1) ?? null;
}

/** One run per commit: the one counted like the newest (same counter), else with today's prices. */
function pick_runs(runs: HistoryRun[], order: string[], prices_hash: string): HistoryRun[] {
	const at = new Map(order.map((s, i) => [s, i]));
	const by_sha = new Map<string, HistoryRun[]>();
	for (const r of runs) {
		if (!at.has(r.sha)) continue;
		const list = by_sha.get(r.sha) ?? [];
		list.push(r);
		by_sha.set(r.sha, list);
	}
	const shas = [...by_sha.keys()].sort((x, y) => at.get(x)! - at.get(y)!);
	if (shas.length === 0) return [];
	const newest = by_sha.get(shas.at(-1)!)!;
	const today = newest.find((r) => r.report.prices.hash === prices_hash) ?? newest[0];
	const rank = (r: HistoryRun): number =>
		(r.counter === today.counter ? 0 : 2) + (r.report.prices.hash === prices_hash ? 0 : 1);
	return shas.map((s) => [...by_sha.get(s)!].sort((x, y) => rank(x) - rank(y))[0]);
}

/** Which functions of the module a name asks for: the path, its place, its last part, or an old name. */
function wanted_functions(name: string, fns: HistoryFunction[]): HistoryFunction[] {
	const last = (id: string) => {
		const path = id.slice(id.indexOf(' > ') + 3);
		return [
			path,
			context_path(path),
			path.split(' > ').at(-1)!,
			context_path(path).split(' > ').at(-1)!
		];
	};
	const now = fns.filter((f) => last(f.id).includes(name));
	if (now.length > 0) return now;
	return fns.filter((f) => f.was.some((w) => last(w).includes(name)));
}

export function build_history(o: HistoryOptions): HistoryResult {
	const t0 = performance.now();
	const git = new Git(o.repo);
	const prices = o.prices ?? load_prices();
	const order = git.first_parents(o.rev ?? 'HEAD');
	const index = new Map(order.map((s, i) => [s, i]));
	const picked = pick_runs(o.runs, order, prices.hash);
	const notes: string[] = [];
	const off_line = new Set(o.runs.map((r) => r.sha).filter((s) => !index.has(s))).size;
	if (off_line > 0)
		notes.push(`${off_line} commit(s) of the runs given are not on the first-parent line`);
	if (picked.length === 0)
		throw new Error(
			`heisenbench: no run of a commit on the first-parent line of ${o.rev ?? 'HEAD'}`
		);
	const data = picked.map((r) => new RunData(r, prices));
	const n = data.length;
	const today = data[n - 1];
	const file = o.file;
	const text = git.lines(today.run.sha, file);
	if (!text) throw new Error(`heisenbench: ${file} is not in ${today.run.sha.slice(0, 12)}`);
	const ref = (sha: string): CommitRef => {
		const subject = git.subject(sha);
		return { sha, subject, pr: pr_of(subject) };
	};
	const inputs = new BenchInputs(git);

	// transitions
	const transitions: HistoryTransition[] = [];
	const commons: string[][] = [[]];
	for (let i = 1; i < n; i++) {
		const from = index.get(data[i - 1].run.sha)!;
		const to = index.get(data[i].run.sha)!;
		const c = common_cases(inputs, data[i - 1], data[i]);
		commons.push(c.keys);
		transitions.push({
			run: i,
			commits: order.slice(from + 1, to + 1).map(ref),
			counter_changed: data[i - 1].run.counter !== data[i].run.counter,
			bench_changed: c.bench_changed,
			only_before: c.only_before,
			only_after: c.only_after
		});
	}

	// follow every line and every function of the file back, run by run
	const at: Array<Array<Pos | null>> = text.map((_, i) => {
		const a: Array<Pos | null> = Array.from({ length: n }, () => null);
		a[n - 1] = { path: file, line: i + 1 };
		return a;
	});
	const edited: boolean[][] = text.map(() => Array.from({ length: n }, () => false));
	const fn_ids: Array<Array<string | null>> = today.module(file).functions.map((f) => {
		const a: Array<string | null> = Array.from({ length: n }, () => null);
		a[n - 1] = f.id;
		return a;
	});
	const today_fns = today.module(file).functions;
	const span_of = (run: RunData, id: string): FnSpan | null => {
		const module = run.git_path(id.slice(0, id.indexOf(' > ')));
		return run.module(module).functions.find((f) => f.id === id) ?? null;
	};
	for (let i = n - 1; i >= 1; i--) {
		const wanted: Pos[] = [];
		for (const a of at) if (a[i]) wanted.push(a[i]!);
		const wanted_fns: FnSpan[] = [];
		for (const ids of fn_ids) {
			const s = ids[i] ? span_of(data[i], ids[i]!) : null;
			if (s) wanted_fns.push(s);
		}
		if (wanted.length === 0 && wanted_fns.length === 0) break;
		const step = step_back(git, data[i - 1], data[i], wanted, wanted_fns);
		for (let k = 0; k < at.length; k++) {
			const p = at[k][i];
			if (!p) continue;
			const s = step.lines.get(pos_key(p));
			if (s) {
				at[k][i - 1] = s.at;
				edited[k][i] = s.edited;
			}
		}
		for (const ids of fn_ids) if (ids[i]) ids[i - 1] = step.functions.get(ids[i]!) ?? null;
	}

	// every case of today, and what each line and function cost at each change
	const all_today = [...today.cases.keys()];
	const lines: HistoryLine[] = text.map((t, k) => {
		const line = k + 1;
		const cells = today.module(file).lines.get(line);
		const steps = sum_cells(cells, all_today) ?? 0;
		// per call of the function that counted the line (`const walk = ...` is its parent's)
		const owner = today.module(file).counted_by.get(line)?.fn ?? today.owner(file, line);
		const calls = owner ? sum_fn(owner, all_today).calls : 0;
		const events: HistoryEvent[] = [];
		for (let i = 1; i < n; i++) {
			const p = at[k][i];
			if (!p) continue;
			const keys = commons[i];
			const after = sum_cells(data[i].module(p.path).lines.get(p.line), keys);
			const q = at[k][i - 1];
			const before = q ? sum_cells(data[i - 1].module(q.path).lines.get(q.line), keys) : 0;
			const e = event_of(
				i,
				transitions[i - 1],
				before,
				after,
				q ? 'changed' : 'new code',
				edited[k][i]
			);
			if (e) events.push(e);
		}
		return {
			line,
			text: t,
			function: owner?.id ?? null,
			steps,
			calls,
			per_call: calls > 0 ? round(steps / calls) : null,
			last: last_of(events),
			events,
			at: at[k].map((p) => (p ? { path: p.path, line: p.line } : null))
		};
	});

	const functions: HistoryFunction[] = today_fns.map((f, j) => {
		const ids = fn_ids[j];
		const timeline: TimelineRow[] = [];
		const events: HistoryEvent[] = [];
		for (let i = 0; i < n; i++) {
			const id = ids[i];
			if (!id) continue;
			const span = span_of(data[i], id);
			const counted = all_today.filter((k) => data[i].cases.has(k));
			const now = sum_fn(span, counted);
			let change: HistoryEvent | null = null;
			if (i > 0) {
				const keys = commons[i];
				const after = sum_fn(span, keys).steps;
				const prev_id = ids[i - 1];
				const before = prev_id ? sum_fn(span_of(data[i - 1], prev_id), keys).steps : 0;
				change = event_of(
					i,
					transitions[i - 1],
					before,
					after,
					prev_id ? 'changed' : 'new code',
					false
				);
				if (change) events.push(change);
			}
			timeline.push({ run: i, id, steps: now.steps, calls: now.calls, change });
		}
		const was: string[] = [];
		for (const id of ids) if (id && id !== f.id && !was.includes(id)) was.push(id);
		const t = sum_fn(f, all_today);
		return {
			id: f.id,
			line: f.line,
			end_line: f.end_line,
			steps: t.steps ?? 0,
			calls: t.calls,
			last: last_of(events),
			timeline,
			was
		};
	});
	functions.sort((x, y) => x.line - y.line || (x.id < y.id ? -1 : 1));

	let shown_lines = lines;
	let shown_fns = functions;
	if (o.function) {
		const asked = wanted_functions(o.function, functions);
		if (asked.length === 0)
			throw new Error(
				`heisenbench: no function ${JSON.stringify(o.function)} ran in ${file} at ${today.run.sha.slice(0, 12)}`
			);
		// with the functions inside them (`#referenced_names > walk`)
		shown_fns = functions.filter((f) =>
			asked.some((a) => f.id === a.id || f.id.startsWith(`${a.id} > `))
		);
		shown_lines = lines.filter((l) =>
			shown_fns.some((f) => l.line >= f.line && l.line <= f.end_line)
		);
	}

	const runs: HistoryRunInfo[] = data.map((d) => ({
		...ref(d.run.sha),
		counter: d.run.counter,
		prices: d.as_counted ? 'as counted' : d.unpriced_lines > 0 ? 'partly recounted' : 'recounted',
		unpriced_lines: d.unpriced_lines,
		cases: d.cases.size,
		source: d.run.source
	}));
	const skipped = transitions.filter((t) => t.commits.length > 1).length;
	if (skipped > 0)
		notes.push(`${skipped} change(s) span more than one commit: no run of the commits between`);
	const counters = transitions.filter((t) => t.counter_changed).length;
	if (counters > 0)
		notes.push(
			`the counter changed at ${counters} of ${transitions.length} change(s): steps can move with it, and those changes are marked`
		);
	return {
		schema: HISTORY_SCHEMA,
		file,
		function: o.function ?? null,
		runs,
		transitions,
		lines: shown_lines,
		functions: shown_fns,
		notes,
		ms: Math.round(performance.now() - t0)
	};
}
