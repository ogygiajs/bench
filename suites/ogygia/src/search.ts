/**
 * The worst-case search on a PR (`abax search`): for the cases whose functions the PR changed and
 * that declare an input (`setup`), which input of the same size costs the most steps, on the PR
 * and on the base. A case is flagged by Abax's own rule (diff_search): its worst input costs at
 * least 4 times its typical one, and at least twice the base's ratio.
 *
 * A strict budget bounds the whole layer: each search gets an even share of what is left, and
 * once the budget is spent the remaining cases are skipped and counted.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'oxc-parser';
import type { DiffResult, Report, SearchCase, SearchReport } from '@bench/abax';
import type { Tree } from './checkout.ts';
import { ABAX_CLI, COUNTED_DEPS, node_options } from './run.ts';
import { spawn_group } from './spawn.ts';

/** The whole layer on a PR, both sides together. */
export const SEARCH_BUDGET_MS = 4 * 60_000;
/** One search never takes longer than this (Abax's own default). */
const MAX_PER_SEARCH_MS = 30_000;
/** Below this, a search is not worth starting. */
const MIN_PER_SEARCH_MS = 3_000;
/** Time a search process takes beyond its budget (loading the bench file) before it is killed. */
const GRACE_MS = 60_000;
/** At most this many cases are searched. */
const MAX_CASES = 8;
/** Abax's flag (search/index.ts diff_search). */
export const FLAG_RATIO = 4;

interface Node {
	type: string;
	[key: string]: unknown;
}

const is_node = (v: unknown): v is Node =>
	typeof v === 'object' && v !== null && typeof (v as Node).type === 'string';

function walk(n: unknown, visit: (n: Node) => void): void {
	if (Array.isArray(n)) {
		for (const x of n) walk(x, visit);
		return;
	}
	if (!is_node(n)) return;
	visit(n);
	for (const [k, v] of Object.entries(n)) {
		if (k !== 'type' && typeof v === 'object' && v !== null) walk(v, visit);
	}
}

/** The text of a string literal or a template literal without expressions. */
function static_string(n: unknown): string | null {
	if (!is_node(n)) return null;
	if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
	if (n.type === 'TemplateLiteral' && (n.expressions as unknown[]).length === 0) {
		const quasis = n.quasis as Array<{ value: { cooked: string | null } }>;
		return quasis[0]?.value.cooked ?? null;
	}
	return null;
}

function key_name(n: unknown): string | null {
	if (!is_node(n)) return null;
	if (n.type === 'Identifier') return n.name as string;
	return static_string(n);
}

/**
 * The cases of a bench file that declare an input: `bench(name, fn, { setup })` with a static
 * name. Options that are not an object literal (a variable, a spread) may hold a setup, so those
 * count too. A case without options, or whose options have no `setup`, has no input to change.
 */
export function cases_with_inputs(file: string, source: string): Set<string> {
	const { program } = parseSync(file, source, { sourceType: 'module' });
	const names = new Set<string>(['bench']);
	walk(program, (n) => {
		if (n.type !== 'ImportSpecifier') return;
		if (key_name(n.imported) === 'bench' && is_node(n.local)) names.add(n.local.name as string);
	});
	const out = new Set<string>();
	walk(program, (n) => {
		if (n.type !== 'CallExpression' || !is_node(n.callee)) return;
		if (n.callee.type !== 'Identifier' || !names.has(n.callee.name as string)) return;
		const args = n.arguments as unknown[];
		const name = static_string(args[0]);
		const options = args[2];
		if (name === null || !is_node(options)) return;
		if (options.type !== 'ObjectExpression') {
			out.add(name);
			return;
		}
		const props = options.properties as Node[];
		const setup = props.some(
			(p) => p.type === 'SpreadElement' || (p.type === 'Property' && key_name(p.key) === 'setup')
		);
		if (setup) out.add(name);
	});
	return out;
}

export interface SearchPick {
	name: string;
	file: string;
}

/**
 * The cases to search: those with a function whose steps changed, biggest change first, that
 * declare an input (`inputs(file)`), at most MAX_CASES.
 */
export function pick_cases(
	diff: DiffResult,
	head: Report,
	inputs: (file: string) => Set<string>,
	max = MAX_CASES
): { picks: SearchPick[]; no_input: number; over: number } {
	const file_of = new Map(head.cases.filter((c) => !c.error).map((c) => [c.name, c.file]));
	const size = new Map<string, number>();
	for (const c of diff.changes) {
		if (c.findings.length === 0 || !file_of.has(c.case)) continue;
		size.set(c.case, Math.max(size.get(c.case) ?? 0, Math.abs(c.delta.self_steps)));
	}
	const ordered = [...size.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
	const picks: SearchPick[] = [];
	let no_input = 0;
	let over = 0;
	const cache = new Map<string, Set<string>>();
	for (const [name] of ordered) {
		const file = file_of.get(name)!;
		let with_input = cache.get(file);
		if (!with_input) cache.set(file, (with_input = inputs(file)));
		if (!with_input.has(name)) no_input++;
		else if (picks.length < max) picks.push({ name, file });
		else over++;
	}
	return { picks, no_input, over };
}

export interface SearchResult {
	name: string;
	file: string;
	head: SearchCase | null;
	base: SearchCase | null;
	/** The search did not finish on a side (a crash, the time limit). */
	error: string | null;
}

export interface SearchRun {
	budget_ms: number;
	spent_ms: number;
	cases: SearchResult[];
	/** Changed cases with no input to change. */
	no_input: number;
	/** Cases left out because the budget ran out (or past MAX_CASES). */
	skipped: number;
}

/** Abax's rule: worst at least FLAG_RATIO times typical, and at least twice the base's ratio. */
export function flagged(r: SearchResult): boolean {
	const h = r.head;
	if (!h || h.error) return false;
	const base_ratio = r.base && !r.base.error ? r.base.ratio : 1;
	return h.ratio >= FLAG_RATIO && h.ratio >= 2 * base_ratio;
}

function read_case(path: string, name: string): SearchCase | null {
	if (!existsSync(path)) return null;
	const report = JSON.parse(readFileSync(path, 'utf8')) as { search?: SearchReport };
	return report.search?.cases.find((c) => c.name === name) ?? null;
}

/** Run the searches, PR then base for each case, within `budget_ms` in all. */
export async function run_searches(
	head: Tree,
	base: Tree | null,
	pick: { picks: SearchPick[]; no_input: number; over: number },
	out_dir: string,
	log: (line: string) => void,
	budget_ms = SEARCH_BUDGET_MS,
	/** The base's case names: a case the base lacks is searched on the PR only. */
	base_cases?: Set<string>
): Promise<SearchRun> {
	const { picks, no_input, over } = pick;
	const budget = budget_ms;
	const started = Date.now();
	const run: SearchRun = { budget_ms: budget, spent_ms: 0, cases: [], no_input, skipped: over };
	mkdirSync(out_dir, { recursive: true });
	const sides = (p: SearchPick) =>
		base && base.benches.includes(p.file) && (!base_cases || base_cases.has(p.name)) ? 2 : 1;
	let left_runs = picks.reduce((n, p) => n + sides(p), 0);
	const search = async (tree: Tree, p: SearchPick, i: number, side: string) => {
		const left = budget - (Date.now() - started);
		const share = Math.min(MAX_PER_SEARCH_MS, Math.floor(left / Math.max(1, left_runs)));
		left_runs--;
		if (share < MIN_PER_SEARCH_MS) return { found: null, error: null, ran: false };
		const out = join(out_dir, `${side}-${i}.json`);
		rmSync(out, { force: true });
		log(
			`${tree.sha.slice(0, 12)} abax search ${p.file} (${p.name}, ${Math.round(share / 1000)} s)`
		);
		const r = await spawn_group(
			process.execPath,
			[
				ABAX_CLI,
				'search',
				p.file,
				'--root',
				tree.dir,
				'--filter',
				p.name,
				'--out',
				out,
				'--sha',
				tree.sha,
				'--budget-ms',
				String(share),
				'--deps',
				COUNTED_DEPS.join(',')
			],
			{ cwd: tree.dir, env: { ...process.env, NODE_OPTIONS: node_options(tree) } },
			share + GRACE_MS
		);
		const found = read_case(out, p.name);
		const died = r.timed_out || r.signal !== null || (r.status !== 0 && r.status !== 1);
		const error = died
			? `abax search ${r.timed_out ? 'did not finish in time' : `exited with ${r.signal ?? r.status}`}`
			: null;
		return { found: died ? null : found, error, ran: true };
	};
	for (const [i, p] of picks.entries()) {
		const h = await search(head, p, i, 'pr');
		if (!h.ran) {
			run.skipped += picks.length - i;
			break;
		}
		// The base may not have the case (a new one): then it has no ratio to compare with.
		const b = base && sides(p) === 2 ? await search(base, p, i, 'base') : null;
		run.cases.push({
			name: p.name,
			file: p.file,
			head: h.found,
			base: b?.found ?? null,
			error:
				h.error ?? (h.found ? null : 'abax search wrote no result for the case') ?? b?.error ?? null
		});
	}
	run.spent_ms = Date.now() - started;
	return run;
}
