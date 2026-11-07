/**
 * Complexity contracts on an ogygia tree: every `@heisenbench <class> in <param>` tag in
 * packages/<pkg>/src, held against what the run measured (Heisenbench's `contracts`): the tree's
 * growth cases and, on the head, growth from recorded calls. A PR's comment shows the contracts it
 * adds, changes or removes, and every one that does not hold on its side; a full run lists them all.
 *
 * Only the files that hold a tag are read: a file without one declares nothing, so nothing is lost.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffContracts } from '@bench/heisenbench';
import type { ContractReport, ContractsDiff, Report } from '@bench/heisenbench';
import type { Tree } from './checkout.ts';
import { source_files } from './recorded.ts';
import { HEISENBENCH_CLI, command_error } from './run.ts';
import { spawn_group } from './spawn.ts';

const LIMIT_MIN = 5;
const TAG = '@heisenbench';

export interface ContractsRun {
	head: ContractReport | null;
	base: ContractReport | null;
	/** A PR: what it changed about the contracts (null on a full run). */
	diff: ContractsDiff | null;
	error: string | null;
}

/** The source files of `dir` that hold a contract tag. */
export function tagged_files(dir: string): string[] {
	return source_files(dir).filter((f) => readFileSync(join(dir, f), 'utf8').includes(TAG));
}

type Measured = Pick<Report, 'growth' | 'recorded_growth'>;

/** Check one tree's contracts against `reports` (the measured sections); null when it has none. */
async function check_tree(
	tree: Tree,
	reports: Array<Measured | null>,
	out_dir: string,
	log: (line: string) => void
): Promise<{ report: ContractReport | null; error: string | null }> {
	const files = tagged_files(tree.dir);
	if (files.length === 0) return { report: null, error: null };
	mkdirSync(out_dir, { recursive: true });
	const paths = reports
		.filter((r): r is Measured => r !== null)
		.map((r, i) => {
			const p = join(out_dir, `measured-${i}.json`);
			writeFileSync(
				p,
				JSON.stringify({ growth: r.growth, recorded_growth: r.recorded_growth }) + '\n'
			);
			return p;
		});
	// a tree nothing was measured on still checks: every contract is then unmeasured
	if (paths.length === 0) {
		const p = join(out_dir, 'measured-none.json');
		writeFileSync(p, '{}\n');
		paths.push(p);
	}
	const list = join(out_dir, 'files.txt');
	writeFileSync(list, files.join('\n') + '\n');
	const out = join(out_dir, 'contracts.json');
	log(`${tree.sha.slice(0, 12)} heisenbench contracts (${files.length} files with a tag)`);
	const r = await spawn_group(
		process.execPath,
		[
			HEISENBENCH_CLI,
			'contracts',
			'--list',
			list,
			'--root',
			tree.dir,
			'--reports',
			paths.join(','),
			'--out',
			out,
			'--sha',
			tree.sha
		],
		{ cwd: tree.dir, env: process.env },
		LIMIT_MIN * 60_000
	);
	writeFileSync(join(out_dir, 'contracts.log'), `${r.stdout}${r.stderr}`);
	const wrote = existsSync(out);
	const error = command_error(r, wrote, 'heisenbench contracts', LIMIT_MIN);
	if (error !== null) return { report: null, error };
	return {
		report: (JSON.parse(readFileSync(out, 'utf8')) as Report).contracts ?? null,
		error: null
	};
}

/**
 * The contracts of the head (and, for a PR, of the base), each against its own tree's
 * measurements. `recorded`: the head's growth from recorded calls, when it ran. `pr`: a PR; with
 * no base tree its diff holds only the head's contracts that do not hold.
 */
export async function run_contracts(
	head: { tree: Tree; report: Measured | null; recorded: Measured | null },
	base: { tree: Tree; report: Measured | null } | null,
	out_dir: string,
	log: (line: string) => void,
	pr: boolean
): Promise<ContractsRun | null> {
	const h = await check_tree(head.tree, [head.report, head.recorded], join(out_dir, 'head'), log);
	const b = base ? await check_tree(base.tree, [base.report], join(out_dir, 'base'), log) : null;
	if (!h.report && !h.error && !b?.report && !b?.error) return null;
	const error = h.error ?? b?.error ?? null;
	// a PR that removes every contract still shows them removed
	const none: ContractReport = {
		schema: 'heisenbench-contracts/1',
		bar: b?.report?.bar ?? 0.9,
		contracts: [],
		errors: [],
		pass: true
	};
	const now = h.report ?? none;
	return {
		head: h.report,
		base: b?.report ?? null,
		diff: !pr || error ? null : diffContracts(base ? (b?.report ?? undefined) : now, now),
		error
	};
}
