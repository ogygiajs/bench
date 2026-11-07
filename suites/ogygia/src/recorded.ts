/**
 * Growth from recorded calls on one ogygia tree: functions nobody wrote a growth case for, grown
 * on the inputs ogygia's own tests pass them (Heisenbench's `growth --recorded`).
 *
 *   1. build the packages (the node tests import their dist/)
 *   2. list the functions of packages/<pkg>/src (`heisenbench inventory`): every one is a target,
 *      or only those of the changed modules (a PR)
 *   3. run each package's node tests with the input recorder on (the tree's
 *      internal/heisenbench/src/record.ts, switched on by HEISENBENCH_RECORD and
 *      HEISENBENCH_RECORD_OUT), which keeps samples of each function's inputs over the sizes it saw
 *   4. `heisenbench growth --recorded`: every sample replayed on the counting build, steps fitted over
 *      each argument's size; too narrow a range of sizes is grown by scaling the largest input
 *
 * Writes recorded.json (a report with the `recorded_growth` section), recorded.md (the superlinear
 * findings) and the logs under the out directory. A tree without the recorder (no record.ts) is
 * skipped, said in one line.
 */
import { execFileSync } from 'node:child_process';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import type { RecordedGrowthReport, Report } from '@bench/heisenbench';
import type { Tree } from './checkout.ts';
import type { RecordedSummary } from './section.ts';
import { HEISENBENCH_CLI, command_error, node_options } from './run.ts';
import { spawn_group } from './spawn.ts';

const SOURCE_EXT = ['.ts', '.js', '.mts', '.mjs'];

/** Minutes each step may take. */
const LIMIT_MIN = { build: 10, tests: 15, grow: 30 };

export interface RecordedRun {
	report: RecordedGrowthReport | null;
	/** The superlinear findings (Heisenbench's markdown), or why there are none. */
	markdown: string;
	error: string | null;
	/** Seconds each step took. */
	seconds: { build: number; record: number; grow: number };
}

/** What result.json keeps of a run: the findings, the counts and the markdown. */
export function summarize(run: RecordedRun, scope: RecordedSummary['scope']): RecordedSummary {
	const fns = run.report?.functions ?? [];
	return {
		scope,
		markdown: run.markdown,
		error: run.error,
		grown: fns.length,
		decided: fns.filter((g) => g.confident).length,
		findings: fns.filter((g) => g.grows),
		seconds: run.seconds
	};
}

/** Source files of the packages (packages/<pkg>/src), relative to the tree. */
export function source_files(dir: string): string[] {
	return execFileSync('git', ['ls-files', '--', 'packages'], {
		cwd: dir,
		encoding: 'utf8',
		maxBuffer: 1 << 28
	})
		.split('\n')
		.filter(
			(f) =>
				/^packages\/[^/]+\/src\//.test(f) &&
				SOURCE_EXT.some((e) => f.endsWith(e)) &&
				!f.endsWith('.d.ts')
		)
		.sort();
}

/** `packages/p/src/a/b.ts` -> `packages/p/dist/a/b.js` (the unbundled build's twin of a source file). */
export function dist_twin(module: string): string | null {
	const m = /^(packages\/[^/]+)\/src\/(.+)\.(ts|mts|js|mjs)$/.exec(module);
	if (!m) return null;
	const ext = m[3] === 'mts' || m[3] === 'mjs' ? 'mjs' : 'js';
	return `${m[1]}/dist/${m[2]}.${ext}`;
}

/**
 * Adds every source module's dist twin that exists to the targets file (the same function paths),
 * and returns `twin -> source`, the aliases the growth step records them under.
 */
function built_twins(dir: string, targets_file: string): Record<string, string> {
	const targets = JSON.parse(readFileSync(targets_file, 'utf8')) as Record<string, string[]>;
	const aliases: Record<string, string> = {};
	for (const [module, paths] of Object.entries(targets)) {
		const twin = dist_twin(module);
		if (twin === null || !existsSync(join(dir, twin))) continue;
		targets[twin] = paths;
		aliases[twin] = module;
	}
	writeFileSync(targets_file, JSON.stringify(targets, null, '\t') + '\n');
	return aliases;
}

async function step(
	cmd: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	log_file: string,
	limit_min: number
) {
	const r = await spawn_group(cmd, args, { cwd, env }, limit_min * 60_000);
	appendFileSync(
		log_file,
		`$ ${cmd} ${args.join(' ')}\n${r.stdout}${r.stderr}\n(exit ${r.signal ?? r.status})\n`
	);
	return r;
}

/**
 * Record the tree's node tests and grow every recorded function. `modules`: only functions of
 * these module ids (a PR's changed source files), recorded and grown.
 */
export async function run_recorded(
	tree: Tree,
	out_dir: string,
	log: (line: string) => void,
	modules: readonly string[] | null = null
): Promise<RecordedRun> {
	const seconds = { build: 0, record: 0, grow: 0 };
	const none = (markdown: string, error: string | null = null): RecordedRun => ({
		report: null,
		markdown,
		error,
		seconds
	});
	if (!existsSync(join(tree.dir, 'internal', 'heisenbench', 'src', 'record.ts')))
		return none('This commit has no input recorder (internal/heisenbench/src/record.ts).');
	mkdirSync(out_dir, { recursive: true });
	const log_file = join(out_dir, 'recorded.log');
	const env = { ...process.env, NODE_OPTIONS: node_options(tree) };
	const plain_env = { ...process.env };

	let t = Date.now();
	log(`${tree.sha.slice(0, 12)} build the packages for their tests`);
	const built = await step('pnpm', ['build:lib'], tree.dir, plain_env, log_file, LIMIT_MIN.build);
	seconds.build = Math.round((Date.now() - t) / 1000);
	if (built.status !== 0) return none('', `the packages did not build (see recorded.log)`);

	const list = join(out_dir, 'files.txt');
	const wanted = modules ? new Set(modules) : null;
	const files = source_files(tree.dir).filter((f) => !wanted || wanted.has(f));
	if (files.length === 0) return none('No changed source file has functions to record.');
	writeFileSync(list, files.join('\n') + '\n');
	const targets = join(out_dir, 'targets.json');
	const inv = await step(
		process.execPath,
		[
			HEISENBENCH_CLI,
			'inventory',
			'--list',
			list,
			'--root',
			tree.dir,
			'--out',
			join(out_dir, 'inventory.json'),
			'--targets',
			targets
		],
		tree.dir,
		plain_env,
		log_file,
		LIMIT_MIN.build
	);
	if (inv.status !== 0 || !existsSync(targets))
		return none('', 'heisenbench inventory failed (see recorded.log)');
	// Most node tests import the built dist/, which mirrors src/ file by file with the functions'
	// names kept: each dist twin is recorded too, and its calls count as its source's.
	const aliases = built_twins(tree.dir, targets);
	const alias_file = join(out_dir, 'aliases.json');
	writeFileSync(alias_file, JSON.stringify(aliases, null, '\t') + '\n');

	t = Date.now();
	const records = join(out_dir, 'records');
	rmSync(records, { recursive: true, force: true });
	mkdirSync(records, { recursive: true });
	for (const pkg of readdirSync(join(tree.dir, 'packages')).sort()) {
		const dir = join(tree.dir, 'packages', pkg);
		const config = join(dir, 'vitest.config.ts');
		const vitest = join(dir, 'node_modules', '.bin', 'vitest');
		if (!existsSync(config) || !existsSync(vitest)) continue;
		// node tests only: the browser project's inputs are DOM nodes, not replayable values
		const project = readFileSync(config, 'utf8').includes("name: 'node'")
			? ['--project', 'node']
			: [];
		log(`${tree.sha.slice(0, 12)} tests of ${pkg}, recording`);
		const r = await step(
			vitest,
			['run', ...project, '--reporter', 'dot'],
			dir,
			{ ...plain_env, HEISENBENCH_RECORD: targets, HEISENBENCH_RECORD_OUT: records },
			log_file,
			LIMIT_MIN.tests
		);
		// a failing test still recorded what it ran
		if (r.status !== 0) log(`  tests of ${pkg} exited ${r.signal ?? r.status} (recorded what ran)`);
	}
	// the bench cases call the same functions, often at sizes no test reaches
	if (tree.benches.length > 0) {
		log(`${tree.sha.slice(0, 12)} bench cases, recording`);
		const r = await step(
			process.execPath,
			[
				HEISENBENCH_CLI,
				'record',
				...tree.benches,
				'--targets',
				targets,
				'--root',
				tree.dir,
				'--out',
				join(records, 'bench-cases.bin')
			],
			tree.dir,
			env,
			log_file,
			LIMIT_MIN.tests
		);
		if (r.status !== 0) log(`  bench recording exited ${r.signal ?? r.status} (kept what ran)`);
	}
	seconds.record = Math.round((Date.now() - t) / 1000);

	t = Date.now();
	const out = join(out_dir, 'recorded.json');
	const md = join(out_dir, 'recorded.md');
	rmSync(out, { force: true });
	log(`${tree.sha.slice(0, 12)} heisenbench growth --recorded`);
	const g = await step(
		process.execPath,
		[
			HEISENBENCH_CLI,
			'growth',
			'--recorded',
			records,
			'--root',
			tree.dir,
			'--out',
			out,
			'--md',
			md,
			'--sha',
			tree.sha,
			'--alias',
			alias_file,
			...(modules ? ['--modules', files.join(',')] : [])
		],
		tree.dir,
		env,
		log_file,
		LIMIT_MIN.grow
	);
	seconds.grow = Math.round((Date.now() - t) / 1000);
	const wrote = existsSync(out) && existsSync(md);
	const error = command_error(g, wrote, 'heisenbench growth --recorded', LIMIT_MIN.grow);
	if (error !== null) return none('', error);
	const report = (JSON.parse(readFileSync(out, 'utf8')) as Report).recorded_growth ?? null;
	return { report, markdown: readFileSync(md, 'utf8'), error: null, seconds };
}
