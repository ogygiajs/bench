import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { recount } from '../blame/recount.ts';
import type { GrowthClass } from '../growth/fit.ts';
import type { GrowthReport } from '../growth/index.ts';
import type { Shape } from '../growth/odds.ts';
import { own_file } from '../own.ts';
import { ProcessError, run_process } from '../proc.ts';
import { one_line } from '../report.ts';
import type { CaseReport } from '../report.ts';
import { sha256 } from './engine.ts';

/*
 * Counting a receipt's tree (tree.ts), the same for `receipt` and `verify-receipt`.
 *
 * Every case is counted in a process of its own (blame's recount child: `heisenbench run` on the
 * one case, with fresh module state per run), and grown in another (child.ts). A count is then a
 * function of the case and the tree alone: nothing an earlier case left in module scope, a global
 * or a cache can reach it, and the order the cases are listed in does not matter. The receipt
 * records this as `counting.isolation: "process per case"`.
 */

export const ISOLATION = 'process per case';
/** Growth sizes of a receipt (the CI default). */
export const RECEIPT_SIZES = [1, 10, 100];
const CHILD_LIMIT_MS = 10 * 60_000;

export interface ReceiptFunction {
	id: string;
	calls: number;
	self_steps: number;
	inclusive_steps: number;
	allocations: number;
	bytes: number;
}

export interface ReceiptCase {
	name: string;
	/** The bench file, relative to the tree's root. */
	file: string;
	totals: { steps: number; allocations: number; bytes: number; calls: number };
	/** Every function the case ran, as the report lists them. */
	functions: ReceiptFunction[];
	/** sha256 of the case's whole report (blocks, lines, built-ins, edges): what the summary leaves out. */
	report: string;
}

export interface ReceiptGrowth {
	name: string;
	file: string;
	sizes: number[];
	input_sizes: number[];
	steps: number[];
	class: GrowthClass | null;
	exponent: number;
	power?: number;
	/** The likeliest shape and its odds. */
	odds?: { shape: Shape; p: number };
}

export interface TreeCount {
	cases: ReceiptCase[];
	growth: ReceiptGrowth[];
	/** Cases that failed, did not count the same twice, or did not grow: no receipt holds them. */
	failed: Array<{ name: string; file: string; error: string }>;
}

/** The environment every counting child gets: no preloads of the caller's, a fixed NODE_ENV, zone and locale. */
export const RECEIPT_ENV: Readonly<Record<string, string>> = {
	NODE_ENV: 'production',
	TZ: 'UTC',
	LC_ALL: 'C'
};

function child_env(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, ...RECEIPT_ENV };
	delete env.NODE_OPTIONS;
	return env;
}

/** Node flags of a counting child: the bench-API hook (preload.ts), then the receipt's own preloads. */
function node_args(root: string, preload: readonly string[]): string[] {
	return [
		`--import=${pathToFileURL(own_file('receipt/preload')).href}`,
		...preload.map((p) => `--import=${pathToFileURL(join(root, ...p.split('/'))).href}`)
	];
}

async function child(job: object, job_file: string, args: readonly string[]): Promise<void> {
	writeFileSync(job_file, JSON.stringify(job));
	try {
		await run_process(process.execPath, [...args, own_file('receipt/child'), job_file], {
			cwd: (job as { root: string }).root,
			env: child_env(),
			timeout_ms: CHILD_LIMIT_MS
		});
	} catch (e) {
		const tail =
			e instanceof ProcessError
				? (e.stderr || e.stdout).trim().split('\n').slice(-3).join(' ')
				: '';
		throw new Error(`the child ${one_line(e)}${tail ? `: ${tail}` : ''}`);
	}
}

export function case_summary(r: CaseReport): ReceiptCase {
	return {
		name: r.name,
		file: r.file,
		totals: { ...r.totals },
		functions: r.functions.map((f) => ({
			id: f.id,
			calls: f.calls,
			self_steps: f.self_steps,
			inclusive_steps: f.inclusive_steps,
			allocations: f.allocations,
			bytes: f.bytes
		})),
		report: sha256(JSON.stringify(r))
	};
}

async function each<T>(xs: readonly T[], jobs: number, fn: (x: T, i: number) => Promise<void>) {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(jobs, xs.length) }, async () => {
			while (next < xs.length) {
				const i = next++;
				await fn(xs[i], i);
			}
		})
	);
}

export interface CountOptions {
	root: string;
	/** Bench files, relative to the root. */
	files: readonly string[];
	/**
	 * Files of the tree every counting process imports first (`--import`): resolve hooks for
	 * specifiers only a bundler serves (`virtual:*`), relative to the root.
	 */
	preload?: readonly string[];
	/** Scratch files (job files, reports): outside the root. */
	work: string;
	sizes?: number[];
	jobs?: number;
	log?: (line: string) => void;
}

/** Count and grow every case of the tree's bench files, each in a process of its own. */
export async function count_tree(o: CountOptions): Promise<TreeCount> {
	const log = o.log ?? (() => {});
	const jobs = Math.max(1, o.jobs ?? Math.min(4, Math.floor(availableParallelism() / 2)));
	const sizes = o.sizes ?? RECEIPT_SIZES;
	const args = node_args(o.root, o.preload ?? []);
	const list_out = join(o.work, 'list.json');
	await child(
		{ kind: 'list', root: o.root, files: o.files, out: list_out },
		join(o.work, 'list.job.json'),
		args
	);
	const listed = JSON.parse(readFileSync(list_out, 'utf8')) as {
		cases: Array<{ name: string; file: string; scaled: boolean }>;
		errors: Array<{ file: string; error: string }>;
	};
	if (listed.errors.length > 0)
		throw new Error(
			`heisenbench: ${listed.errors[0].file} does not load: ${listed.errors[0].error}`
		);
	if (listed.cases.length === 0) throw new Error('heisenbench: the bench files define no cases');

	const counted: Array<ReceiptCase | null> = listed.cases.map(() => null);
	const grown: Array<ReceiptGrowth | null> = listed.cases.map(() => null);
	const failed: TreeCount['failed'] = [];
	await each(listed.cases, jobs, async (c, i) => {
		const got = await recount({
			lane: o.root,
			given_root: o.root,
			root: o.root,
			files: [c.file],
			cases: [c.name],
			prefix: '',
			deps: true,
			out: join(o.work, `count-${i}.json`),
			job_file: join(o.work, `count-${i}.job.json`),
			node_args: args,
			env: child_env(),
			timeout_ms: CHILD_LIMIT_MS
		});
		const r = got.report?.cases.find((x) => x.name === c.name && x.file === c.file);
		const error =
			got.error ??
			(r === undefined
				? 'not counted'
				: r.error !== null
					? r.error
					: r.stable
						? null
						: 'unstable: two runs counted differently');
		if (error !== null || r === undefined) {
			failed.push({ name: c.name, file: c.file, error: error ?? 'not counted' });
			log(`FAILED   ${c.name}: ${error}`);
			return;
		}
		counted[i] = case_summary(r);
		log(`counted  ${c.name}  ${Math.round(r.totals.steps)} steps`);
		if (!c.scaled) return;
		const out = join(o.work, `growth-${i}.json`);
		try {
			await child(
				{ kind: 'growth', root: o.root, files: [c.file], cases: [c.name], sizes, out },
				join(o.work, `growth-${i}.job.json`),
				args
			);
			const g = (JSON.parse(readFileSync(out, 'utf8')) as GrowthReport).cases.find(
				(x) => x.name === c.name && x.file === c.file
			);
			const gerr =
				g === undefined
					? 'not grown'
					: g.error !== null
						? g.error
						: g.stable
							? null
							: 'unstable growth';
			if (gerr !== null || g === undefined) throw new Error(gerr ?? 'not grown');
			const top = g.odds?.odds[0];
			grown[i] = {
				name: g.name,
				file: g.file,
				sizes: g.sizes,
				input_sizes: g.input_sizes,
				steps: g.steps,
				class: g.class,
				exponent: g.exponent,
				...(g.power !== undefined ? { power: g.power } : {}),
				...(top ? { odds: { shape: top.shape, p: top.p } } : {})
			};
			log(`grown    ${c.name}  ${g.class ?? 'no class'} (exponent ${g.exponent})`);
		} catch (e) {
			failed.push({ name: c.name, file: c.file, error: `growth: ${one_line(e)}` });
			log(`FAILED   ${c.name} (growth): ${one_line(e)}`);
		}
	});
	return {
		cases: counted.filter((c): c is ReceiptCase => c !== null),
		growth: grown.filter((g): g is ReceiptGrowth => g !== null),
		failed
	};
}
