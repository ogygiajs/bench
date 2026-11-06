/**
 * Abax on one tree: every bench file in its own processes (one bad file costs only its own cases),
 * each counted (`abax run`: exact, so once per commit, with the plain-build layers asked for), then
 * engine health (`abax health`) and growth for the cases that declare a scaler (`abax growth
 * --scaled on`). The reports of all files are merged into one report per tree.
 *
 * And the time layer across two trees: `abax time` loads both in one process and times them in
 * turns, judged by the bench repo's same-job noise rule.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORT_SCHEMA, renderTime } from '@bench/abax';
import type { CaseReport, EngineReport, GrowthReport, Report, TimeComparison } from '@bench/abax';
import type { Tree } from './checkout.ts';

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

function tail_of(r: {
	stdout?: string | null;
	stderr?: string | null;
	error?: Error;
	status: number | null;
}): string {
	const text = (r.stderr || r.stdout || String(r.error ?? '')).trim();
	return text.split('\n').slice(-6).join('\n') || `exit ${r.status}`;
}

function spawn_abax(tree: Tree, args: string[], log_file: string, limit_min: number) {
	const r = spawnSync(process.execPath, [ABAX_CLI, ...args], {
		cwd: tree.dir,
		encoding: 'utf8',
		maxBuffer: 1 << 28,
		timeout: limit_min * 60_000,
		killSignal: 'SIGKILL',
		env: { ...process.env, NODE_OPTIONS: node_options(tree) }
	});
	appendFileSync(log_file, `$ abax ${args.join(' ')}\n${r.stdout ?? ''}${r.stderr ?? ''}\n`);
	if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
		return { ...r, stderr: `abax ${args[0]} did not finish within ${limit_min} min`, stdout: '' };
	}
	return r;
}

/** One Abax command on one bench file; the error text when its part never reached the report. */
function abax(
	tree: Tree,
	command: Command,
	file: string,
	out: string,
	log_file: string,
	measure: string | null
): string | null {
	const extra =
		command === 'growth'
			? ['--scaled', 'on']
			: command === 'run' && measure
				? ['--measure', measure]
				: [];
	const r = spawn_abax(
		tree,
		[command, file, '--root', tree.dir, '--out', out, '--sha', tree.sha, ...extra],
		log_file,
		LIMIT_MIN[command]
	);
	// Exit 1 is "a case failed": the report holds that failure. A missing part is a crash.
	const report = read_report(out);
	if (report && report[WRITES[command]] !== undefined) return null;
	return tail_of(r);
}

/** One report from the per-file reports: their cases, engine cases and growth cases together. */
export function merge_reports(parts: Report[], sha: string): Report | null {
	if (parts.length === 0) return null;
	const cases: CaseReport[] = [];
	let engine: EngineReport | undefined;
	let growth: GrowthReport | undefined;
	for (const p of parts) {
		cases.push(...p.cases);
		if (p.engine) {
			if (engine) engine.cases.push(...p.engine.cases);
			else engine = { ...p.engine, cases: [...p.engine.cases] };
		}
		if (p.growth) {
			if (growth) growth.cases.push(...p.growth.cases);
			else growth = { ...p.growth, cases: [...p.growth.cases] };
		}
	}
	const { schema, prices, node } = parts[0];
	const report: Report = { schema, prices, node, git: { sha, prefix: '' }, cases };
	if (engine) report.engine = engine;
	if (growth) report.growth = growth;
	return report;
}

/** A report with no cases, like `like` (the base of the PR that adds the bench files). */
export function empty_report(sha: string, like: Report): Report {
	return {
		schema: REPORT_SCHEMA,
		prices: like.prices,
		node: like.node,
		git: { sha, prefix: '' },
		cases: []
	};
}

/**
 * Count, check and grow `files` on `tree`; reports and the log go under `out_dir`. `measure`: the
 * plain-build layers `abax run` adds (`time,bytes,leaks`, `all`), or null for none.
 */
export function run_tree(
	tree: Tree,
	files: string[],
	out_dir: string,
	log: (line: string) => void,
	measure: string | null = null,
	commands: readonly Command[] = ['run', 'health', 'growth']
): TreeRun {
	mkdirSync(out_dir, { recursive: true });
	const log_file = join(out_dir, 'abax.log');
	const parts: Report[] = [];
	const load_errors: LoadError[] = [];
	files.forEach((file, i) => {
		const out = join(out_dir, `${i}.json`);
		rmSync(out, { force: true });
		for (const command of commands) {
			log(`${tree.sha.slice(0, 12)} abax ${command} ${file}`);
			const error = abax(tree, command, file, out, log_file, measure);
			if (error !== null) {
				load_errors.push({ file, command, error });
				if (command === 'run') break;
			}
		}
		const report = read_report(out);
		if (report) parts.push(report);
	});
	return { report: merge_reports(parts, tree.sha), load_errors };
}

/**
 * The time layer (spec 6): the bench files both trees have, timed on the plain build in one
 * process, PR and base taking turns (`abax time`), judged by the no-overlap noise rule. The PR
 * tree's preload serves both sides (the stubs it maps to are test fixtures, not measured code).
 */
export function run_time(
	head: Tree,
	base: Tree,
	files: string[],
	out_dir: string,
	log: (line: string) => void,
	o: { repeats?: number; time_ms?: number; limit_min?: number } = {}
): TimeRun | null {
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
	const r = spawn_abax(
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
		o.limit_min ?? LIMIT_MIN.time
	);
	if (!existsSync(out)) {
		const error = tail_of(r);
		return { comparison: null, markdown: '', error };
	}
	const comparison = JSON.parse(readFileSync(out, 'utf8')) as TimeComparison;
	return { comparison, markdown: renderTime(comparison), error: null };
}
