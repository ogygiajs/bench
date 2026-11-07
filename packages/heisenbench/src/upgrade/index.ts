import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { case_key } from '../cases.ts';
import { diff_reports } from '../diff/index.ts';
import type { DiffResult, FindingKind, FunctionChange } from '../diff/index.ts';
import type { FileDiff } from '../diff/git.ts';
import { OWN_CODE, package_label, package_of } from '../identity.ts';
import type { LoaderConfig } from '../loader/register.ts';
import type { CaseReport, Report } from '../report.ts';
import { recount } from '../blame/recount.ts';
import { mirror_tree, remove_tree } from '../blame/tree.ts';
import { find_package_dir, package_diffs } from './packages.ts';

/*
 * What a dependency upgrade costs (spec: dependency upgrade diffs). A PR that changes a version in
 * the lockfile or a package.json changes code nobody reviews in the PR: the step table shows the
 * upgraded package's functions next to the project's, mixed with whatever else the PR changed.
 *
 * Here the project's code is held still and only the dependencies change. Two scratch trees of
 * the PR's checkout (blame/tree.ts): one with the PR's install, one with the base's install under
 * the same project files. The cases that count an upgraded package are recounted on both
 * (blame/recount.ts), with the other cases of their bench files as controls, and the two counts
 * are diffed the way `heisenbench diff` diffs a PR (diff/index.ts) with the package's own diff
 * between its two versions (packages.ts) as the line map: a function is the same across versions
 * by its place and its code hash, through files the package moved, and a line inside an upstream
 * hunk is "new code".
 *
 * A step change in a case that counts no upgraded package should not happen: the code it runs is
 * the same on both trees. When it does, the count depends on something else (module state left by
 * the cases before it in the same process, or a package that changed without being counted), and
 * the result lists it apart instead of blaming the upgrade.
 */

export const UPGRADE_SCHEMA = 'heisenbench-upgrade/1';
/** One recount child's limit. */
const CHILD_LIMIT_MS = 10 * 60_000;
const MAX_FUNCTIONS = 12;
const MAX_LINES = 6;
const MAX_ENTRIES = 5;

export interface Bump {
	name: string;
	from: string;
	to: string;
	/** Where each version is installed (null: not found, lines compared as they are). */
	dirs: { from: string | null; to: string | null };
	/** Files the package changed between the two versions (null: the dirs were not found). */
	changed_files: number | null;
}

export interface UpgradeLine {
	line: number;
	kind: FindingKind;
	delta_steps: number;
	/** The line is inside an upstream hunk (the package changed it between the two versions). */
	upstream: boolean;
}

export interface UpgradeFunction {
	/** Module and path in the new tree (the old tree's for a function only it has). */
	module: string;
	function: string;
	/** Its module in the old tree, when it is another (an upgraded package: another version). */
	old_module: string | null;
	line: number;
	end_line: number;
	/** `name@version` of the new side, or `own code`. */
	package: string;
	old_self_steps: number;
	new_self_steps: number;
	delta_self_steps: number;
	calls: { old: number; new: number };
	/** `with`: only the new tree has it; `without`: only the old one. */
	only: 'with' | 'without' | null;
	/** The package changed this function's lines between the versions. */
	upstream: boolean;
	lines: UpgradeLine[];
}

/** A function of an upgraded package that code outside it calls: where a reproduction starts. */
export interface UpgradeEntry {
	module: string;
	function: string;
	old_inclusive: number;
	new_inclusive: number;
	calls: number;
	/** The project's own code calls it (not only another package). */
	from_own: boolean;
}

export interface UpgradeCase {
	case: string;
	file: string;
	old_steps: number;
	new_steps: number;
	delta: number;
	/** The upgraded packages the case counts (on either tree). */
	packages: string[];
	/** Δ self steps by package (`name@version` of the new side, or `own code`), biggest first. */
	by_package: Array<{ package: string; delta: number }>;
	/** The functions whose own steps changed, biggest change first. */
	functions: UpgradeFunction[];
	/** Per upgraded package, its functions called from outside it, the most changed first. */
	entries: Record<string, UpgradeEntry[]>;
}

export interface UpgradeResult {
	schema: typeof UPGRADE_SCHEMA;
	/** The PR's checkout and the base's (each installed). */
	root: string;
	base_root: string;
	bumps: Bump[];
	/** Packages only one side counts. */
	added: string[];
	removed: string[];
	/** The cases that count an upgraded package. */
	cases: UpgradeCase[];
	/** Cases that count no upgraded package and still changed: not the upgrade's doing. */
	unexplained: Array<{ case: string; file: string; old_steps: number; new_steps: number }>;
	/** Cases whose recount on the PR's install differs from the PR report: the count depends on run order. */
	order_dependent: Array<{ case: string; file: string; report: number; recount: number }>;
	/** Cases one tree could not count. */
	failed: Array<{ case: string; file: string; side: 'old' | 'new'; error: string }>;
	/** Bench files recounted, cases recounted, wall time. */
	spent: { files: number; cases: number; ms: number };
}

export interface UpgradeOptions {
	base: Report;
	pr: Report;
	/** The PR's checkout, installed. Never written to. */
	root: string;
	/** The base's checkout, installed: its dependencies are the old ones. Never written to. */
	base_root: string;
	/** Only these packages (default: every package whose counted version changed). */
	packages?: readonly string[] | null;
	deps?: LoaderConfig['deps'];
	/** Where the two scratch trees go (default: a new temporary directory, removed after). */
	work?: string;
	node_args?: readonly string[];
	env?: NodeJS.ProcessEnv;
	log?: (line: string) => void;
}

function versions(r: Report): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	for (const c of r.cases) {
		for (const f of c.functions) {
			const p = package_of(f.module);
			if (!p) continue;
			const s = out.get(p.name) ?? new Set();
			s.add(p.version);
			out.set(p.name, s);
		}
	}
	return out;
}

/** The packages the two reports count at different versions, and those only one counts. */
export function find_bumps(
	base: Report,
	pr: Report
): {
	bumps: Array<{ name: string; from: string; to: string }>;
	added: string[];
	removed: string[];
} {
	const b = versions(base);
	const p = versions(pr);
	const bumps: Array<{ name: string; from: string; to: string }> = [];
	const added: string[] = [];
	const removed: string[] = [];
	const by_version = (x: string, y: string) => x.localeCompare(y, 'en', { numeric: true });
	for (const name of [...new Set([...b.keys(), ...p.keys()])].sort()) {
		const bv = b.get(name);
		const pv = p.get(name);
		if (!bv) {
			for (const v of [...pv!].sort(by_version)) added.push(`${name}@${v}`);
			continue;
		}
		if (!pv) {
			for (const v of [...bv].sort(by_version)) removed.push(`${name}@${v}`);
			continue;
		}
		const gone = [...bv].filter((v) => !pv.has(v)).sort(by_version);
		const came = [...pv].filter((v) => !bv.has(v)).sort(by_version);
		if (gone.length === 0 && came.length === 0) continue;
		// two copies on one side (a range two dependents resolve differently): newest to newest
		bumps.push({
			name,
			from: (gone.length > 0 ? gone : [...bv].sort(by_version)).at(-1)!,
			to: (came.length > 0 ? came : [...pv].sort(by_version)).at(-1)!
		});
	}
	return { bumps, added, removed };
}

function counts_package(c: CaseReport, names: ReadonlySet<string>): string[] {
	const out = new Set<string>();
	for (const f of c.functions) {
		const p = package_of(f.module);
		if (p && names.has(p.name)) out.add(p.name);
	}
	return [...out];
}

/** Hunks of the new side's files: module id -> [start, end] line ranges. */
function upstream_ranges(files: readonly FileDiff[]): Map<string, Array<[number, number]>> {
	const out = new Map<string, Array<[number, number]>>();
	for (const f of files) {
		if (f.new_path === null) continue;
		const list: Array<[number, number]> = [];
		for (const h of f.hunks)
			if (h.new_count > 0) list.push([h.new_start, h.new_start + h.new_count - 1]);
		// a file new in this version is all upstream
		if (f.old_path === null) list.push([1, Number.MAX_SAFE_INTEGER]);
		out.set(f.new_path, list);
	}
	return out;
}

function in_ranges(ranges: Array<[number, number]> | undefined, a: number, b: number): boolean {
	return !!ranges?.some(([x, y]) => a <= y && b >= x);
}

function round(n: number): number {
	return Math.round(n * 1e6) / 1e6;
}

/** The changed functions of one case, as the upgrade reports them. */
function functions_of(
	changes: readonly FunctionChange[],
	ranges: Map<string, Array<[number, number]>>
): UpgradeFunction[] {
	const moved = changes.filter((c) => c.findings.length > 0 && Math.abs(c.delta.self_steps) > 1e-6);
	return [...moved]
		.sort(
			(a, b) =>
				Math.abs(b.delta.self_steps) - Math.abs(a.delta.self_steps) ||
				(a.module + a.function < b.module + b.function ? -1 : 1)
		)
		.slice(0, MAX_FUNCTIONS)
		.map((c) => {
			const f = (c.pr ?? c.base)!;
			const r = ranges.get(c.module);
			const only =
				c.base === null ? ('with' as const) : c.pr === null ? ('without' as const) : null;
			return {
				module: c.module,
				function: c.function,
				old_module: c.base && c.base.module !== c.module ? c.base.module : null,
				line: f.line,
				end_line: f.end_line,
				package: package_label(c.module) ?? OWN_CODE,
				old_self_steps: c.base?.self_steps ?? 0,
				new_self_steps: c.pr?.self_steps ?? 0,
				delta_self_steps: c.delta.self_steps,
				calls: { old: c.base?.calls ?? 0, new: c.pr?.calls ?? 0 },
				only,
				upstream: only === 'with' || (c.pr !== null && in_ranges(r, f.line, f.end_line)),
				lines: [...c.findings]
					.filter((x) => Math.abs(x.delta.steps) > 1e-6)
					.sort((x, y) => Math.abs(y.delta.steps) - Math.abs(x.delta.steps) || x.line - y.line)
					.slice(0, MAX_LINES)
					.map((x) => ({
						line: x.line,
						kind: x.kind,
						delta_steps: x.delta.steps,
						upstream: c.pr !== null && in_ranges(r, x.line, x.line)
					}))
			};
		});
}

/** Functions of `name` that code outside it calls, by the change of their inclusive steps. */
function entries_of(
	name: string,
	old_case: CaseReport,
	new_case: CaseReport,
	diff: DiffResult,
	case_name: string
): UpgradeEntry[] {
	const in_pkg = (id: string) => package_of(id)?.name === name;
	const called = new Map<string, number>();
	// called by the project's own code: the package's public surface (another package calling
	// in may be calling back into a hook it was handed)
	const by_own = new Set<string>();
	for (const e of new_case.edges) {
		if (!in_pkg(e.to) || in_pkg(e.from)) continue;
		called.set(e.to, (called.get(e.to) ?? 0) + e.count);
		if (!package_of(e.from)) by_own.add(e.to);
	}
	const by_id = new Map(new_case.functions.map((f) => [f.id, f]));
	// the old tree's function for each new one, as the diff paired them
	const old_of = new Map<string, number>();
	for (const c of diff.changes) {
		if (c.case !== case_name || !c.pr || !c.base) continue;
		old_of.set(c.pr.id, c.base.inclusive_steps);
	}
	const old_by_id = new Map(old_case.functions.map((f) => [f.id, f.inclusive_steps]));
	const out: UpgradeEntry[] = [];
	for (const [id, calls] of called) {
		const f = by_id.get(id);
		if (!f) continue;
		out.push({
			module: f.module,
			function: f.path,
			old_inclusive: old_of.get(id) ?? old_by_id.get(id) ?? f.inclusive_steps,
			new_inclusive: f.inclusive_steps,
			calls,
			from_own: by_own.has(id)
		});
	}
	return out
		.sort(
			(a, b) =>
				Number(b.from_own) - Number(a.from_own) ||
				Math.abs(b.new_inclusive - b.old_inclusive) - Math.abs(a.new_inclusive - a.old_inclusive) ||
				b.new_inclusive - a.new_inclusive
		)
		.slice(0, MAX_ENTRIES);
}

export async function upgrade_diff(o: UpgradeOptions): Promise<UpgradeResult> {
	const started = Date.now();
	const log = o.log ?? (() => {});
	const given_root = resolve(o.root);
	const root = realpathSync(given_root);
	const base_root = realpathSync(resolve(o.base_root));
	const found = find_bumps(o.base, o.pr);
	const wanted = o.packages ? new Set(o.packages) : null;
	const bumps_found = found.bumps.filter((b) => !wanted || wanted.has(b.name));
	const result: UpgradeResult = {
		schema: UPGRADE_SCHEMA,
		root,
		base_root,
		bumps: [],
		added: found.added,
		removed: found.removed,
		cases: [],
		unexplained: [],
		order_dependent: [],
		failed: [],
		spent: { files: 0, cases: 0, ms: 0 }
	};

	// where each version is installed, and the package's diff between them
	const starts = [
		...new Set(
			o.pr.cases.flatMap((c) => c.functions.map((f) => f.module)).filter((m) => !package_of(m))
		)
	];
	const files: FileDiff[] = [];
	for (const b of bumps_found) {
		const from = find_package_dir(base_root, b.name, b.from, starts);
		const to = find_package_dir(root, b.name, b.to, starts);
		let changed: number | null = null;
		if (from && to) {
			const d = package_diffs(from, to, `${b.name}@${b.from}`, `${b.name}@${b.to}`);
			files.push(...d);
			changed = d.length;
		}
		result.bumps.push({ ...b, dirs: { from, to }, changed_files: changed });
		log(
			`upgrade: ${b.name} ${b.from} → ${b.to}${changed === null ? ' (installed files not found: lines compared as they are)' : `, ${changed} file(s) changed`}`
		);
	}
	const names = new Set(result.bumps.map((b) => b.name));
	if (names.size === 0) {
		result.spent.ms = Date.now() - started;
		return result;
	}

	// The cases that count an upgraded package, with every other case of their bench files: the
	// files run as `heisenbench run` ran them, and the others are the controls.
	const touched = new Set<string>();
	for (const c of [...o.base.cases, ...o.pr.cases])
		if (c.error === null && counts_package(c, names).length > 0) touched.add(case_key(c));
	const pr_cases = o.pr.cases.filter((c) => c.error === null);
	const bench_files = [
		...new Set(pr_cases.filter((c) => touched.has(case_key(c))).map((c) => c.file))
	].sort();
	const counted = pr_cases.filter((c) => bench_files.includes(c.file));
	const case_names = [...new Set(counted.map((c) => c.name))].sort();
	result.spent.files = bench_files.length;
	result.spent.cases = counted.length;
	log(
		`upgrade: ${touched.size} case(s) count ${[...names].join(', ')}; recounting ${counted.length} case(s) of ${bench_files.length} bench file(s) on both installs`
	);
	if (counted.length === 0) {
		result.spent.ms = Date.now() - started;
		return result;
	}

	const own_work = o.work === undefined;
	const made = own_work ? mkdtempSync(join(tmpdir(), 'heisenbench-upgrade-')) : resolve(o.work!);
	mkdirSync(made, { recursive: true });
	const work = realpathSync(made);
	const old_tree = join(work, 'old');
	const new_tree = join(work, 'new');
	let reports: {
		old: Report | null;
		new: Report | null;
		old_error: string | null;
		new_error: string | null;
	};
	try {
		remove_tree(old_tree);
		remove_tree(new_tree);
		mirror_tree(root, old_tree, { modules_from: base_root });
		mirror_tree(root, new_tree);
		const count = (lane: string, side: string) =>
			recount({
				lane,
				given_root,
				root,
				files: bench_files,
				cases: case_names,
				prefix: '',
				deps: o.deps ?? true,
				out: join(work, `${side}.json`),
				job_file: join(work, `${side}.job.json`),
				node_args: o.node_args ?? process.execArgv,
				env: o.env ?? process.env,
				timeout_ms: CHILD_LIMIT_MS
			});
		const [a, b] = await Promise.all([count(old_tree, 'old'), count(new_tree, 'new')]);
		reports = { old: a.report, new: b.report, old_error: a.error, new_error: b.error };
	} finally {
		remove_tree(old_tree);
		remove_tree(new_tree);
		if (own_work) remove_tree(work);
	}
	log(`upgrade: counted both installs, ${Math.round((Date.now() - started) / 1000)} s`);

	const pick = (r: Report | null, c: CaseReport) =>
		r?.cases.find((x) => x.file === c.file && x.name === c.name) ?? null;
	const load_error = (r: Report | null, file: string) =>
		r?.load_errors?.find((l) => l.file === file)?.error ?? null;
	const ok_old: CaseReport[] = [];
	const ok_new: CaseReport[] = [];
	for (const c of counted) {
		const a = pick(reports.old, c);
		const b = pick(reports.new, c);
		const bad = (
			side: 'old' | 'new',
			x: CaseReport | null,
			r: Report | null,
			err: string | null
		) => {
			if (x && x.error === null) return false;
			result.failed.push({
				case: c.name,
				file: c.file,
				side,
				error: err ?? x?.error ?? load_error(r, c.file) ?? 'the case is not in this tree'
			});
			return true;
		};
		const bad_old = bad('old', a, reports.old, reports.old_error);
		const bad_new = bad('new', b, reports.new, reports.new_error);
		if (b && !bad_new && Math.abs(b.totals.steps - c.totals.steps) > 1e-6)
			result.order_dependent.push({
				case: c.name,
				file: c.file,
				report: c.totals.steps,
				recount: b.totals.steps
			});
		if (bad_old || bad_new) continue;
		ok_old.push(a!);
		ok_new.push(b!);
	}

	const as_report = (r: Report, cases: CaseReport[]): Report => ({
		...r,
		git: { sha: null, prefix: '' },
		cases
	});
	const diff = diff_reports(as_report(reports.old!, ok_old), as_report(reports.new!, ok_new), {
		files
	});
	const ranges = upstream_ranges(files);
	for (let i = 0; i < ok_new.length; i++) {
		const a = ok_old[i];
		const b = ok_new[i];
		const pkgs = [...new Set([...counts_package(a, names), ...counts_package(b, names)])].sort();
		const delta = round(b.totals.steps - a.totals.steps);
		if (pkgs.length === 0) {
			if (Math.abs(delta) > 1e-6)
				result.unexplained.push({
					case: b.name,
					file: b.file,
					old_steps: a.totals.steps,
					new_steps: b.totals.steps
				});
			continue;
		}
		const changes = diff.changes.filter((c) => c.case === b.name);
		const by_package = diff.packages
			.filter((p) => p.case === b.name)
			.map((p) => ({ package: p.package, delta: round(p.pr_steps - p.base_steps) }))
			.filter((p) => Math.abs(p.delta) > 1e-6)
			.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || (x.package < y.package ? -1 : 1));
		const entries: Record<string, UpgradeEntry[]> = {};
		for (const p of pkgs) entries[p] = entries_of(p, a, b, diff, b.name);
		result.cases.push({
			case: b.name,
			file: b.file,
			old_steps: a.totals.steps,
			new_steps: b.totals.steps,
			delta,
			packages: pkgs,
			by_package,
			functions: functions_of(changes, ranges),
			entries
		});
	}
	result.cases.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || (x.case < y.case ? -1 : 1));
	result.spent.ms = Date.now() - started;
	return result;
}
