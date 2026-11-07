/**
 * Which change made a PR slower (`blameRegressions`): for the cases whose steps grew past
 * Heisenbench's threshold (1% and 1,000 steps), the PR's hunks are undone in sets on scratch
 * copies of the head tree, and only those cases are recounted, until the smallest set of hunks
 * that carries the extra steps is found. The hunks searched are those of the files the regressed
 * cases' bench files reach (the selection's import graphs); every file the PR changed when the
 * selection ran them all.
 *
 * It runs after the time layer (it uses the cores; timing needs them free) within its own budget,
 * a number of recounts and a wall time. What a recount costs is one `heisenbench run` of the
 * regressed cases alone (2 s for the compiler's transformHost cases on an M4 Max), side by side
 * on half the cores: a PR whose regression is one hunk among ten needs about 10 recounts. Past
 * the budget the answer is "narrowed to these hunks".
 *
 * With the weights the ranking uses (main's app weights and, when the owner uploaded them, real
 * traffic), the blamed change is priced by the same cost function as every other finding: CPU
 * time per day on the imported traffic, with its range, in all and per hunk.
 */
import { join } from 'node:path';
import { BLAME_MAX_RECOUNTS, blameRegressions, regressedCases } from '@bench/heisenbench';
import type { BlameResult, DiffResult, Report } from '@bench/heisenbench';
import type { AppWeights } from '@bench/heisenbench/weight';
import type { Tree } from './checkout.ts';
import { node_options } from './run.ts';
import type { Selection } from './select.ts';

/** The whole layer on a PR. */
export const BLAME_BUDGET_MS = 5 * 60_000;

export interface BlameRun {
	result: BlameResult | null;
	error: string | null;
}

/** The files the regressed cases' bench files reach; null: every changed file. */
export function blame_paths(sel: Selection, files: string[]): string[] | null {
	if (sel.mode === 'all') return null;
	const out = new Set<string>();
	for (const f of files) for (const p of sel.reach[f] ?? []) out.add(p);
	return [...out].sort();
}

export async function run_blame(
	repo: string,
	head: Tree,
	merge_base: string,
	diff: DiffResult,
	report: Report,
	sel: Selection,
	work: string,
	log: (line: string) => void,
	budget_ms: number,
	cost: { weights?: AppWeights | null; requests_per_day?: number } = {}
): Promise<BlameRun | null> {
	const cases = regressedCases(diff, report);
	if (cases.length === 0) return null;
	log(`blame ${cases.length} regressed case(s)`);
	try {
		const result = await blameRegressions({
			repo,
			root: head.dir,
			base: merge_base,
			head: head.sha,
			cases,
			paths: blame_paths(
				sel,
				cases.map((c) => c.file)
			),
			max_recounts: BLAME_MAX_RECOUNTS,
			budget_ms,
			work: join(work, 'blame'),
			node_args: [],
			env: { ...process.env, NODE_OPTIONS: node_options(head) },
			log,
			weights: cost.weights ?? null,
			requests_per_day: cost.requests_per_day
		});
		return { result, error: null };
	} catch (e) {
		return { result: null, error: e instanceof Error ? e.message : String(e) };
	}
}
