/**
 * Abax on one tree: every bench file in its own processes (one bad file costs only its own cases),
 * each counted (`abax run`: exact, so once per commit), then engine health (`abax health`) and
 * growth for the cases that declare a scaler (`abax growth --scaled on`). The reports of all files
 * are merged into one report per tree.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORT_SCHEMA } from '@bench/abax';
import type { CaseReport, EngineReport, GrowthReport, Report } from '@bench/abax';
import type { Tree } from './checkout.ts';

export const ABAX_DIR = fileURLToPath(new URL('../../../packages/abax/', import.meta.url));
const ABAX_CLI = join(ABAX_DIR, 'src', 'cli.ts');

/** A bench file whose step that never landed in its report (failed to load, or Abax crashed). */
export interface LoadError {
	file: string;
	command: Command;
	error: string;
}

export interface TreeRun {
	report: Report | null;
	load_errors: LoadError[];
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
	// argument) so the processes Abax spawns itself (the health child) load it too.
	return tree.preload ? `${base} --import=${tree.preload}`.trim() : base;
}

function read_report(path: string): Report | null {
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, 'utf8')) as Report;
}

/** One Abax command on one bench file; the error text when its part never reached the report. */
function abax(
	tree: Tree,
	command: Command,
	file: string,
	out: string,
	log_file: string
): string | null {
	const extra = command === 'growth' ? ['--scaled', 'on'] : [];
	const args = [ABAX_CLI, command, file, '--root', tree.dir, '--out', out, '--sha', tree.sha];
	const r = spawnSync(process.execPath, [...args, ...extra], {
		cwd: tree.dir,
		encoding: 'utf8',
		maxBuffer: 1 << 28,
		env: { ...process.env, NODE_OPTIONS: node_options(tree) }
	});
	appendFileSync(log_file, `$ abax ${command} ${file}\n${r.stdout ?? ''}${r.stderr ?? ''}\n`);
	// Exit 1 is "a case failed": the report holds that failure. A missing part is a crash.
	const report = read_report(out);
	if (report && report[WRITES[command]] !== undefined) return null;
	const text = (r.stderr || r.stdout || String(r.error ?? '')).trim();
	return text.split('\n').slice(-6).join('\n') || `exit ${r.status}`;
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
 * Hook for Abax's time layer (tinybench, spec 6): latency and throughput of the same cases on the
 * plain build, PR and base taking turns in this job (the bench repo's same-job noise rule). Abax on
 * main has no time layer yet; when it lands, run it here for both trees, interleaved, and return
 * its part of the comment. Until then it returns null and the comment says steps are counts.
 */
export function run_time_layer(_head: Tree, _base: Tree | null, _files: string[]): string | null {
	return null;
}

/** Count, check and grow `files` on `tree`; reports and the log go under `out_dir`. */
export function run_tree(
	tree: Tree,
	files: string[],
	out_dir: string,
	log: (line: string) => void
): TreeRun {
	mkdirSync(out_dir, { recursive: true });
	const log_file = join(out_dir, 'abax.log');
	const parts: Report[] = [];
	const load_errors: LoadError[] = [];
	files.forEach((file, i) => {
		const out = join(out_dir, `${i}.json`);
		rmSync(out, { force: true });
		for (const command of ['run', 'health', 'growth'] as const) {
			log(`${tree.sha.slice(0, 12)} abax ${command} ${file}`);
			const error = abax(tree, command, file, out, log_file);
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
