/**
 * Abax on one tree: every bench file in its own processes (one bad file costs only its own cases),
 * each counted (`abax run`: exact, so once per commit, with the plain-build layers asked for), then
 * engine health (`abax health`) and growth for the cases that declare a scaler (`abax growth
 * --scaled on`). The reports of all files are merged into one report per tree.
 *
 * And the time layer across two trees: `abax time` loads both in one process and times them in
 * turns, judged by the bench repo's same-job noise rule.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORT_SCHEMA, renderTime } from '@bench/abax';
import type { CaseReport, EngineReport, GrowthReport, Report, TimeComparison } from '@bench/abax';
import type { Tree } from './checkout.ts';
import { spawn_group } from './spawn.ts';
import type { GroupResult } from './spawn.ts';

export const ABAX_DIR = fileURLToPath(new URL('../../../packages/abax/', import.meta.url));
const ABAX_CLI = join(ABAX_DIR, 'src', 'cli.ts');

/** A bench file whose step never landed in its report (failed to load, or Abax crashed). */
export interface LoadError {
	file: string;
	command: Command | 'time';
	error: string;
}

export interface TreeRun {
	report: Report | null;
	load_errors: LoadError[];
}

export interface TimeRun {
	comparison: TimeComparison | null;
	/** The comparison's table for the comment (or why there is none). */
	markdown: string;
	error: string | null;
}

type Command = 'run' | 'health' | 'growth';

/** The report key each command writes. */
const WRITES: Record<Command, 'cases' | 'engine' | 'growth'> = {
	run: 'cases',
	health: 'engine',
	growth: 'growth'
};

function node_options(tree: Tree): string {
	const base = process.env.NODE_OPTIONS ?? '';
	// The tree's preload maps the specifiers only Vite and Kit serve to stubs. NODE_OPTIONS (not an
	// argument) so the processes Abax spawns itself (health and measure children) load it too.
	return tree.preload ? `${base} --import=${tree.preload}`.trim() : base;
}

function read_report(path: string): Report | null {
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, 'utf8')) as Report;
}

/**
 * How long one command on one bench file may take. A case whose growth is quadratic at 100x (or
 * that never settles) costs its own part of the report, not the whole run.
 */
const LIMIT_MIN: Record<Command | 'time', number> = { run: 15, health: 15, growth: 5, time: 20 };

function tail_of(r: GroupResult): string {
	const text = (r.stderr || r.stdout || String(r.error ?? '')).trim();
	return text.split('\n').slice(-6).join('\n');
}

/**
 * Why an Abax command's part cannot be trusted, or null when it can. Exit 0 is a clean run and
 * exit 1 is "a case failed" (the report holds that failure). Anything else, a signal or the time
 * limit means the process died: its part of the report may be from a layer that finished before
 * a later one crashed, so it is an error even when the part is there. A clean exit without its
 * part is one too.
 */
export function command_error(
	r: GroupResult,
	wrote_part: boolean,
	what: string,
	limit_min: number
): string | null {
	const tail = tail_of(r);
	const with_tail = (head: string) => (tail ? `${head}\n${tail}` : head);
	if (r.timed_out) return `${what} did not finish within ${limit_min} min`;
	if (r.error && r.status === null && r.signal === null)
		return `${what} did not start: ${r.error.message}`;
	if (r.signal) return with_tail(`${what} was killed by ${r.signal}`);
	if (r.status !== 0 && r.status !== 1) return with_tail(`${what} exited with ${r.status}`);
	if (!wrote_part) return tail || `${what} exited with ${r.status} and wrote nothing`;
	return null;
}

async function spawn_abax(
	tree: Tree,
	args: string[],
	log_file: string,
	limit_min: number
): Promise<GroupResult> {
	const r = await spawn_group(
		process.execPath,
		[ABAX_CLI, ...args],
		{ cwd: tree.dir, env: { ...process.env, NODE_OPTIONS: node_options(tree) } },
		limit_min * 60_000
	);
	const end = r.timed_out
		? `(killed after ${limit_min} min)`
		: `(exit ${r.signal ?? r.status ?? r.error?.message})`;
	appendFileSync(log_file, `$ abax ${args.join(' ')}\n${r.stdout}${r.stderr}\n${end}\n`);
	return r;
}

/** One Abax command on one bench file; the error text when its part never reached the report. */
async function abax(
	tree: Tree,
	command: Command,
	file: string,
	out: string,
	log_file: string,
	measure: string | null
): Promise<string | null> {
	const extra =
		command === 'growth'
			? ['--scaled', 'on']
			: command === 'run' && measure
				? ['--measure', measure]
				: [];
	const r = await spawn_abax(
		tree,
		[command, file, '--root', tree.dir, '--out', out, '--sha', tree.sha, ...extra],
		log_file,
		LIMIT_MIN[command]
	);
	const report = read_report(out);
	const wrote = report !== null && report[WRITES[command]] !== undefined;
	return command_error(r, wrote, `abax ${command}`, LIMIT_MIN[command]);
}

/**
 * One report from the per-file reports: their cases, engine cases, growth cases and the bench
 * files that did not load, together; the environment of the first (one job counts them all).
 */
export function merge_reports(parts: Report[], sha: string): Report | null {
	if (parts.length === 0) return null;
	const cases: CaseReport[] = [];
	const load_errors: NonNullable<Report['load_errors']> = [];
	let engine: EngineReport | undefined;
	let growth: GrowthReport | undefined;
	for (const p of parts) {
		cases.push(...p.cases);
		if (p.load_errors) load_errors.push(...p.load_errors);
		if (p.engine) {
			if (engine) engine.cases.push(...p.engine.cases);
			else engine = { ...p.engine, cases: [...p.engine.cases] };
		}
		if (p.growth) {
			if (growth) growth.cases.push(...p.growth.cases);
			else growth = { ...p.growth, cases: [...p.growth.cases] };
		}
	}
	const { schema, prices, node, env } = parts[0];
	const report: Report = { schema, prices, node, git: { sha, prefix: '' }, cases };
	if (env) report.env = env;
	if (load_errors.length > 0) report.load_errors = load_errors;
	if (engine) report.engine = engine;
	if (growth) report.growth = growth;
	return report;
}

/** A report with no cases, like `like` (the base of the PR that adds the bench files). */
export function empty_report(sha: string, like: Report): Report {
	const report: Report = {
		schema: REPORT_SCHEMA,
		prices: like.prices,
		node: like.node,
		git: { sha, prefix: '' },
		cases: []
	};
	if (like.env) report.env = like.env;
	return report;
}

/**
 * Count, check and grow `files` on `tree`; reports and the log go under `out_dir`. `measure`: the
 * plain-build layers `abax run` adds (`time,bytes,leaks`, `all`), or null for none.
 */
export async function run_tree(
	tree: Tree,
	files: string[],
	out_dir: string,
	log: (line: string) => void,
	measure: string | null = null,
	commands: readonly Command[] = ['run', 'health', 'growth']
): Promise<TreeRun> {
	mkdirSync(out_dir, { recursive: true });
	const log_file = join(out_dir, 'abax.log');
	const parts: Report[] = [];
	const load_errors: LoadError[] = [];
	for (const [i, file] of files.entries()) {
		const out = join(out_dir, `${i}.json`);
		rmSync(out, { force: true });
		for (const command of commands) {
			log(`${tree.sha.slice(0, 12)} abax ${command} ${file}`);
			const error = await abax(tree, command, file, out, log_file, measure);
			if (error !== null) {
				load_errors.push({ file, command, error });
				if (command === 'run') break;
			}
		}
		// What a process that died wrote is kept (its counts are whole: a report is written once
		// every case ran); the error above says the file's layers are not all there.
		const report = read_report(out);
		if (report) parts.push(report);
	}
	return { report: merge_reports(parts, tree.sha), load_errors };
}

/**
 * The time layer (spec 6): the bench files both trees have, timed on the plain build in one
 * process, PR and base taking turns (`abax time`), judged by the no-overlap noise rule. The PR
 * tree's preload serves both sides (the stubs it maps to are test fixtures, not measured code).
 */
export async function run_time(
	head: Tree,
	base: Tree,
	files: string[],
	out_dir: string,
	log: (line: string) => void,
	o: { repeats?: number; time_ms?: number; limit_min?: number } = {}
): Promise<TimeRun | null> {
	if (files.length === 0) return null;
	mkdirSync(out_dir, { recursive: true });
	const out = join(out_dir, 'time.json');
	rmSync(out, { force: true });
	log(
		`time ${files.length} bench file(s): ${base.sha.slice(0, 12)} and ${head.sha.slice(0, 12)} in turns`
	);
	const extra = [
		...(o.repeats !== undefined ? ['--repeats', String(o.repeats)] : []),
		...(o.time_ms !== undefined ? ['--time-ms', String(o.time_ms)] : [])
	];
	const limit_min = o.limit_min ?? LIMIT_MIN.time;
	const r = await spawn_abax(
		head,
		[
			'time',
			...files,
			'--base',
			base.dir,
			'--pr',
			head.dir,
			'--out',
			out,
			'--md',
			join(out_dir, 'time.md'),
			...extra
		],
		join(out_dir, 'abax.log'),
		limit_min
	);
	const error = command_error(r, existsSync(out), 'abax time', limit_min);
	if (error !== null) return { comparison: null, markdown: '', error };
	const comparison = JSON.parse(readFileSync(out, 'utf8')) as TimeComparison;
	return { comparison, markdown: renderTime(comparison), error: null };
}
