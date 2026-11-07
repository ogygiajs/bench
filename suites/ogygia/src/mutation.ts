/**
 * The benchmarks tested by mutants (Heisenbench's `mutate`), on one tree: every function of
 * packages/<pkg>/src gets behavior-preserving slowdowns (twice the steps, one more pass over the
 * collection a loop walks, one more allocation, a defeated memo), each recounted on a scratch copy
 * of the tree with only the cases that ran the function, and judged by the rules a PR comment uses.
 * The result is a score per package and operator, and the missed functions with a case that would
 * catch each one.
 *
 * The nightly run mutates every function a case runs (`--mutate all`); a main push and a PR do not
 * (docs/ci.md has the cost). The functions no case runs miss every mutant without a recount, so
 * the cost is in the ones a case runs: on an M4 Max about 3 s each with 4 copies side by side.
 *
 * It reads the tree's merged head report (which case runs which function), the recorded calls of
 * the same run when there are any (`growth --recorded`'s samples: a quadratic mutant that growth
 * from recorded calls flags is caught too), and main's app weights when given (the missed
 * functions are ranked by them). Writes mutation.json, mutation.md and mutation.log under the out
 * directory.
 */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import type { Report } from '@bench/heisenbench';
import type { Tree } from './checkout.ts';
import { HEISENBENCH_CLI, command_error, node_options } from './run.ts';
import { source_files } from './recorded.ts';
import { spawn_group } from './spawn.ts';

/** The whole layer's wall time on the nightly run (its own budget ends it before the job's limit). */
export const MUTATION_BUDGET_MS = 75 * 60_000;

export interface MutationRun {
	/** The headline, the score table and the top missed functions (Heisenbench's markdown). */
	markdown: string;
	error: string | null;
	/** Per operator: the score over every function, and over the functions a case runs. */
	totals: Record<string, { score: number | null; run_score: number | null; estimated: boolean }>;
	functions: number;
	reached: number;
	evaluated: number;
	missed: Array<{ id: string; operators: string[]; reason: string }>;
	cost: { ms: number; recounts: number; growth: number; reused: number; cached: number } | null;
	seconds: number;
}

interface MutationJson {
	totals: MutationRun['totals'];
	sample: { functions: number; reached: number; evaluated: number };
	missed: Array<{ id: string; operators: string[]; reason: string }>;
	cost: MutationRun['cost'];
}

export async function run_mutation(
	tree: Tree,
	head: Report,
	out_dir: string,
	log: (line: string) => void,
	o: {
		sample: 'all' | number;
		budget_ms?: number;
		weights?: string | null;
		records?: { dir: string; alias: string | null } | null;
		work: string;
	}
): Promise<MutationRun> {
	const t0 = Date.now();
	const budget_ms = o.budget_ms ?? MUTATION_BUDGET_MS;
	mkdirSync(out_dir, { recursive: true });
	const base = join(out_dir, 'base.json');
	writeFileSync(base, JSON.stringify(head));
	const list = join(out_dir, 'files.txt');
	writeFileSync(list, source_files(tree.dir).join('\n') + '\n');
	const out = join(out_dir, 'mutation.json');
	const md = join(out_dir, 'mutation.md');
	rmSync(out, { force: true });
	const args = [
		HEISENBENCH_CLI,
		'mutate',
		...tree.benches,
		'--root',
		tree.dir,
		'--list',
		list,
		'--report',
		base,
		'--sample',
		String(o.sample),
		'--budget-ms',
		String(budget_ms),
		'--work',
		o.work,
		'--out',
		out,
		'--md',
		md
	];
	if (o.weights && existsSync(o.weights)) args.push('--weights', o.weights);
	if (o.records && existsSync(o.records.dir)) {
		args.push('--records', o.records.dir);
		if (o.records.alias && existsSync(o.records.alias)) args.push('--alias', o.records.alias);
	}
	log(
		`${tree.sha.slice(0, 12)} heisenbench mutate (${o.sample === 'all' ? 'every function a case runs' : `a sample of ${o.sample}`})`
	);
	// its own budget ends it; the limit is for a child that hangs past it
	const limit_min = Math.ceil(budget_ms / 60_000) + 15;
	const r = await spawn_group(
		process.execPath,
		args,
		{ cwd: tree.dir, env: { ...process.env, NODE_OPTIONS: node_options(tree) } },
		limit_min * 60_000
	);
	appendFileSync(
		join(out_dir, 'mutation.log'),
		`${r.stdout}${r.stderr}\n(exit ${r.signal ?? r.status})\n`
	);
	const seconds = Math.round((Date.now() - t0) / 1000);
	const wrote = existsSync(out) && existsSync(md);
	const error = command_error(r, wrote, 'heisenbench mutate', limit_min);
	const none: MutationRun = {
		markdown: '',
		error,
		totals: {},
		functions: 0,
		reached: 0,
		evaluated: 0,
		missed: [],
		cost: null,
		seconds
	};
	if (error !== null) return none;
	const j = JSON.parse(readFileSync(out, 'utf8')) as MutationJson;
	return {
		markdown: readFileSync(md, 'utf8'),
		error: null,
		totals: Object.fromEntries(
			Object.entries(j.totals).map(([op, s]) => [
				op,
				{ score: s.score, run_score: s.run_score, estimated: s.estimated }
			])
		),
		functions: j.sample.functions,
		reached: j.sample.reached,
		evaluated: j.sample.evaluated,
		// result.json keeps the top of the ranking; the artifact has every function
		missed: j.missed
			.slice(0, 50)
			.map((m) => ({ id: m.id, operators: m.operators, reason: m.reason })),
		cost: j.cost,
		seconds
	};
}
