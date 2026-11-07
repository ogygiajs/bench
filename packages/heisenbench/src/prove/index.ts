import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import type { FunctionRecord, Sample } from '../coverage/recorder.ts';
import { load_records } from '../coverage/recorder.ts';
import { merge_records, read_record_dir } from '../coverage/replay-run.ts';
import { GROWTH_RANK } from '../growth/fit.ts';
import { DEFAULT_SIZES, GROWTH_CAP } from '../growth/index.ts';
import { OWN_DIR, PACKAGE_DIR, own_file } from '../own.ts';
import { run_process } from '../proc.ts';
import type { ProcessError } from '../proc.ts';
import { unified_diff } from './diff.ts';
import { unsafe_reason } from './safety.ts';
import { SpliceError, splice } from './splice.ts';
import type { Cost, InputKind, InputRow, ProveChildResult, ProveJob, RecordJob } from './types.ts';

/*
 * `heisenbench prove`: a faster version of a function is accepted only when it is proven the same
 * and cheaper (docs/layers.md#proving-a-faster-version).
 *
 * 1. Same behavior. The original and the candidate run on every recorded input of the function
 *    (test recordings, `heisenbench record`, the bench cases at their own scales), on those inputs
 *    grown (the generic scaler at 1x / 10x / 100x), and on seeded edge cases of their shapes
 *    (variants.ts). Results, errors and the arguments after the call must be the same (equal.ts).
 *    One difference rejects the candidate, with the smallest input it differs on.
 * 2. Fewer steps. Both are counted on the same inputs. No recorded or grown input may cost more
 *    than the original's steps plus a tolerance (5% + 256 steps), and the total, or the growth
 *    curve, must improve. A candidate that grows more slowly (a lower class, or an exponent 0.25
 *    lower) and is cheaper at every size of the steepest grown curve may cost up to the setup
 *    tolerance more (3x by default) on smaller inputs: the Map it builds once costs more than the
 *    loop it replaces on a short list. Those inputs are named in the report and its headline.
 *    Edge cases decide behavior only: their steps are shown, never a regression.
 *
 * The candidate's code runs only in a child process (child.ts) under Node's permission model: it
 * reads the project and Heisenbench, writes its one result file, and has no network, no child
 * processes and no workers. Its source passes safety.ts first, and each call has a step cap.
 */

export const PROVE_SCHEMA = 'heisenbench-prove/1';

export interface ProveOptions {
	root: string;
	/** The module the function is in (a path, absolute or from the working directory). */
	module: string;
	/** The function: its name in the module, or its full id (`src/a.ts > f`). */
	fn: string;
	/** Directories of recorded sample files (coverage recordings, `heisenbench record`). */
	records?: string[];
	/** Bench files to record the function's inputs from, at their own scales too. */
	bench?: string[];
	deps?: boolean | string[];
	sizes?: number[];
	cap?: number;
	variants?: number;
	/** `shapes` (default): edge cases keep every value's type and every key; `all`: keys deleted and undefined too. */
	edge?: 'shapes' | 'all';
	seed?: number;
	shrink?: number;
	/** A recorded or grown input may cost this share more than the original... */
	tolerance?: number;
	/** ...plus this many steps, before it is a regression. */
	tolerance_steps?: number;
	/** The share the total must fall by, when the growth curve does not improve. */
	min_gain?: number;
	/**
	 * When the candidate grows more slowly and is cheaper at every grown size, a recorded input
	 * may cost up to this share more than the original (the setup that the grown sizes pay back).
	 */
	setup_tolerance?: number;
	timeout_ms?: number;
	log?: (line: string) => void;
}

export const DEFAULTS = {
	sizes: DEFAULT_SIZES,
	cap: GROWTH_CAP,
	variants: 160,
	seed: 1,
	shrink: 400,
	tolerance: 0.05,
	tolerance_steps: 256,
	min_gain: 0.01,
	setup_tolerance: 2,
	timeout_ms: 30 * 60_000,
	/** Growth exponents this far apart are a different curve. */
	exponent_gain: 0.25
};

/** Where a function is: its module's id and file, and its path in the module. */
export interface Target {
	id: string;
	module: string;
	file: string;
	path: string;
}

export function target_of(root: string, module: string, fn: string): Target {
	const file = resolve(module);
	if (!existsSync(file)) throw new Error(`heisenbench prove: no such module ${module}`);
	const id = relative(resolve(root), file).split(sep).join('/');
	if (id.startsWith('..'))
		throw new Error(`heisenbench prove: ${module} is not under --root ${root}`);
	const path = fn.includes(' > ') ? fn.slice(fn.indexOf(' > ') + 3) : fn;
	if (fn.includes(' > ') && fn.slice(0, fn.indexOf(' > ')) !== id)
		throw new Error(`heisenbench prove: ${fn} is not in ${id}`);
	if (path.includes(' > '))
		throw new Error(
			`heisenbench prove: ${fn} is nested; prove the top-level function that holds it (${path.split(' > ')[0]}) with a candidate for it`
		);
	return { id: `${id} > ${path}`, module: id, file, path };
}

export interface Verdict {
	proven: boolean;
	/** One line: what decided it. */
	reason: string;
	inputs: {
		total: number;
		by_kind: Record<InputKind, number>;
		same: number;
		differing: number;
		undecided: number;
	};
	minimal: ProveChildResult['minimal'];
	steps: {
		/** Over the recorded and grown inputs both sides counted. */
		original: Cost;
		candidate: Cost;
		/** Inputs whose candidate cost more than the tolerance allows (worst first, at most 5). */
		regressions: Array<{ label: string; size: number; original: number; candidate: number | null }>;
		regressed: number;
		/**
		 * Recorded inputs the candidate costs more on, within the setup tolerance, accepted because
		 * its growth is better and it is cheaper at every grown size: the price of setting up (a Map
		 * built once) that the grown sizes pay back. Null when there are none.
		 */
		setup: {
			inputs: number;
			worst: { label: string; size: number; original: number; candidate: number };
			/** The largest input size among them. */
			below: number;
			/** The smallest grown size, where the candidate is cheaper. */
			cheaper_from: number;
		} | null;
		improved: number;
		/** Edge-case inputs whose candidate costs more (shown, not a regression: edge cases test behavior). */
		edge_regressions: number;
	};
	growth: ProveChildResult['growth'];
}

export interface ProveReport {
	schema: typeof PROVE_SCHEMA;
	function: string;
	candidate: string;
	verdict: Verdict;
	headline: string;
	/** The patch that turns the original module into the candidate one. */
	diff: string;
	replaced: string[];
	added: string[];
	child: ProveChildResult;
}

function sum_cost(rows: readonly Cost[]): Cost {
	const out = { steps: 0, allocations: 0, bytes: 0 };
	for (const r of rows) {
		out.steps += r.steps;
		out.allocations += r.allocations;
		out.bytes += r.bytes;
	}
	return out;
}

/** Whether `c` costs more than `o` allows: `o * (1 + tolerance) + tolerance_steps`. */
function regresses(
	o: number,
	c: number,
	opts: Required<Pick<ProveOptions, 'tolerance' | 'tolerance_steps'>>
): boolean {
	return c > o * (1 + opts.tolerance) + opts.tolerance_steps;
}

export function judge(
	child: ProveChildResult,
	o: ProveOptions = { root: '', module: '', fn: '' }
): Verdict {
	const t = {
		tolerance: o.tolerance ?? DEFAULTS.tolerance,
		tolerance_steps: o.tolerance_steps ?? DEFAULTS.tolerance_steps
	};
	const min_gain = o.min_gain ?? DEFAULTS.min_gain;
	const rows = child.inputs;
	const by_kind: Record<InputKind, number> = { recorded: 0, grown: 0, edge: 0 };
	for (const r of rows) by_kind[r.kind]++;
	// a side past its cap is not compared: the input decides nothing about behavior
	const undecided = rows.filter(
		(r) => r.difference === null && (r.original.capped || r.candidate?.capped === true)
	).length;
	const differing = rows.filter((r) => r.difference !== null).length;
	const same = rows.length - differing - undecided;
	const gated = (r: InputRow) => r.kind !== 'edge';
	const counted = rows.filter((r) => gated(r) && r.original.cost && r.candidate?.cost);
	const regressions: Verdict['steps']['regressions'] = [];
	const setup: Array<{ label: string; size: number; original: number; candidate: number }> = [];
	let improved = 0;
	let edge_regressions = 0;
	const g = child.growth;
	const class_better =
		g?.candidate?.class != null &&
		g.original.class !== null &&
		(GROWTH_RANK[g.candidate.class] ?? Infinity) < (GROWTH_RANK[g.original.class] ?? -Infinity);
	const exponent_better =
		g?.candidate != null &&
		g.candidate.class !== null &&
		g.original.exponent - g.candidate.exponent >= DEFAULTS.exponent_gain;
	const orig_capped_only =
		g?.original.capped_at != null && g.candidate?.capped_at == null && g.candidate?.class != null;
	const growth_better = class_better || exponent_better || orig_capped_only;
	// the candidate is cheaper at every grown size: what it costs more on small inputs, it pays back
	const grown = (g?.rows ?? []).filter((x) => x.k > 1);
	const wins_grown =
		grown.length > 0 &&
		grown.every(
			(x) => x.candidate !== null && (x.original === null || x.candidate.steps < x.original.steps)
		);
	const setup_tolerance = o.setup_tolerance ?? DEFAULTS.setup_tolerance;
	for (const r of rows) {
		const oc = r.original.cost;
		const cc = r.candidate?.cost ?? null;
		if (!oc) continue;
		const went_past = r.candidate?.capped === true;
		if (cc && cc.steps < oc.steps) improved++;
		if (!(went_past || (cc && regresses(oc.steps, cc.steps, t)))) continue;
		if (!gated(r)) edge_regressions++;
		else if (
			cc &&
			growth_better &&
			wins_grown &&
			cc.steps <= oc.steps * (1 + setup_tolerance) + t.tolerance_steps
		)
			setup.push({ label: r.label, size: r.size, original: oc.steps, candidate: cc.steps });
		else
			regressions.push({
				label: r.label,
				size: r.size,
				original: oc.steps,
				candidate: cc?.steps ?? null
			});
	}
	const worst_first = (a: { original: number; candidate: number | null }, b: typeof a) =>
		(b.candidate ?? Infinity) / b.original - (a.candidate ?? Infinity) / a.original;
	regressions.sort(worst_first);
	setup.sort(worst_first);
	const original = sum_cost(counted.map((r) => r.original.cost!));
	const candidate = sum_cost(counted.map((r) => r.candidate!.cost!));
	const total_better = candidate.steps < original.steps * (1 - min_gain);
	const verdict: Verdict = {
		proven: false,
		reason: '',
		inputs: { total: rows.length, by_kind, same, differing, undecided },
		minimal: child.minimal,
		steps: {
			original,
			candidate,
			regressions: regressions.slice(0, 5),
			regressed: regressions.length,
			setup:
				setup.length === 0
					? null
					: {
							inputs: setup.length,
							worst: setup[0],
							below: Math.max(...setup.map((s) => s.size)),
							cheaper_from: Math.min(...(g?.rows ?? []).filter((x) => x.k > 1).map((x) => x.size))
						},
			improved,
			edge_regressions
		},
		growth: g
	};
	if (child.errors.length > 0) verdict.reason = `not proven: ${child.errors[0]}`;
	else if (rows.length === 0)
		verdict.reason = 'not proven: no recorded input of the function (give --records or --bench)';
	else if (differing > 0)
		verdict.reason = `rejected: behaves differently on ${differing} of ${rows.length} inputs`;
	else if (regressions.length > 0)
		verdict.reason = `rejected: costs more steps on ${regressions.length} input(s) (more than ${Math.round(t.tolerance * 100)}% + ${t.tolerance_steps} steps)`;
	else if (counted.length === 0) verdict.reason = 'not proven: no input both sides counted';
	else if (!(total_better || class_better || exponent_better || orig_capped_only))
		verdict.reason = `rejected: not cheaper (${fmt(original.steps)} -> ${fmt(candidate.steps)} steps over ${counted.length} inputs, the same growth)`;
	else {
		verdict.proven = true;
		verdict.reason = 'proven';
	}
	return verdict;
}

export function fmt(n: number): string {
	if (Math.abs(n) >= 1e6) return n.toExponential(2).replace('e+', 'e');
	return Math.round(n).toLocaleString('en-US');
}

/** `proven: n^1.98 -> n^1.01, 2.18e9 -> 5.77e7 steps at 100x, identical on 4,519 inputs` */
export function headline(v: Verdict): string {
	const parts: string[] = [];
	const g = v.growth;
	if (g) {
		const last = g.rows[g.rows.length - 1];
		const shape =
			g.candidate && g.candidate.class !== null
				? `n^${g.original.exponent.toFixed(2)} -> n^${g.candidate.exponent.toFixed(2)}`
				: `n^${g.original.exponent.toFixed(2)}`;
		parts.push(shape);
		if (last.original && last.candidate)
			parts.push(`${fmt(last.original.steps)} -> ${fmt(last.candidate.steps)} steps at ${last.k}x`);
	} else {
		parts.push(
			`${fmt(v.steps.original.steps)} -> ${fmt(v.steps.candidate.steps)} steps over the recorded inputs`
		);
	}
	if (v.inputs.differing === 0)
		parts.push(`identical on ${v.inputs.same.toLocaleString('en-US')} inputs`);
	else
		parts.push(
			`differs on ${v.inputs.differing.toLocaleString('en-US')} of ${v.inputs.total.toLocaleString('en-US')} inputs`
		);
	const s = v.steps.setup;
	const setup = s
		? `; up to +${Math.round(((s.worst.candidate - s.worst.original) / s.worst.original) * 100)}% on ${s.inputs} input(s) up to size ${fmt(s.below)}`
		: '';
	return `${v.reason.split(':')[0]}: ${parts.join(', ')}${setup}`;
}

/** The function's samples from the record directories and the bench files. */
export async function samples_of(
	o: ProveOptions,
	t: Target
): Promise<{ samples: Sample[]; calls: number }> {
	const lists: FunctionRecord[][] = [];
	for (const dir of o.records ?? []) lists.push(read_record_dir(dir));
	if (o.bench && o.bench.length > 0) {
		const dir = job_dir();
		try {
			const out = join(dir, 'bench.bin');
			const job: RecordJob = {
				kind: 'record',
				root: resolve(o.root),
				files: o.bench.map((f) => resolve(f)),
				targets: { [t.module]: [t.path] },
				scales: o.sizes ?? DEFAULTS.sizes,
				out
			};
			await child(job, dir, null, o.timeout_ms ?? DEFAULTS.timeout_ms);
			lists.push(load_records(out));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
	const r = merge_records(lists).find((x) => x.id === t.id);
	return { samples: r?.samples ?? [], calls: r?.calls ?? 0 };
}

function job_dir(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), 'heisenbench-prove-')));
}

/** The directory node_modules of Heisenbench's dependencies are found under (the top-most one with node_modules). */
function deps_root(): string {
	let dir = PACKAGE_DIR;
	let found = PACKAGE_DIR;
	for (;;) {
		if (existsSync(join(dir, 'node_modules'))) found = dir;
		const up = dirname(dir);
		if (up === dir) return found;
		dir = up;
	}
}

/**
 * Run a job in a child. A prove job runs sandboxed: Node's permission model with reads under the
 * project root, Heisenbench and the job directory, a write to its result file only, and native
 * addons (the parser the counting transform uses is one). No network, no child processes, no
 * workers, no inspector.
 */
async function child(
	job: ProveJob | RecordJob,
	dir: string,
	sandbox: { root: string } | null,
	timeout_ms: number
): Promise<void> {
	const job_file = join(dir, 'job.bin');
	writeFileSync(job_file, serialize(job));
	const flags = ['--no-warnings', '--stack-size=4000'];
	if (sandbox) {
		const reads = [
			...new Set([
				realpathSync(sandbox.root),
				realpathSync(PACKAGE_DIR),
				realpathSync(OWN_DIR),
				realpathSync(deps_root()),
				dir
			])
		];
		flags.push(
			'--permission',
			...reads.map((r) => `--allow-fs-read=${r}`),
			`--allow-fs-write=${job.out}`,
			'--allow-addons'
		);
	}
	try {
		await run_process(process.execPath, [...flags, own_file('prove/child'), job_file], {
			cwd: sandbox?.root ?? job.root,
			timeout_ms
		});
	} catch (e) {
		const err = e as ProcessError;
		const tail = (err.stderr ?? '').trim().split('\n').slice(-6).join('\n');
		throw new Error(`heisenbench: the ${job.kind} child ${err.message}${tail ? `: ${tail}` : ''}`);
	}
}

/** Where the candidate module is served from: next to the original (its imports resolve the same), at a path no file is at. */
function candidate_path(file: string, n: number): string {
	const ext = extname(file);
	let p = join(dirname(file), `${basename(file, ext)}.heisenbench-candidate-${n}${ext}`);
	for (let i = 2; existsSync(p); i++)
		p = join(dirname(file), `${basename(file, ext)}.heisenbench-candidate-${n}-${i}${ext}`);
	return p;
}

/** Count the original alone on its inputs (the proposer's view of the function). */
export async function profile_original(
	o: ProveOptions,
	t: Target,
	samples: Sample[]
): Promise<ProveChildResult> {
	return run_child_job(o, t, samples, null);
}

async function run_child_job(
	o: ProveOptions,
	t: Target,
	samples: Sample[],
	candidate: { file: string; source: string } | null
): Promise<ProveChildResult> {
	const dir = job_dir();
	try {
		const out = join(dir, 'out.bin');
		const job: ProveJob = {
			kind: 'prove',
			root: realpathSync(resolve(o.root)),
			deps: o.deps ?? true,
			module: t.module,
			path: t.path,
			candidate,
			samples,
			sizes: o.sizes ?? DEFAULTS.sizes,
			cap: o.cap ?? DEFAULTS.cap,
			variants: o.variants ?? DEFAULTS.variants,
			edge: o.edge ?? 'shapes',
			seed: o.seed ?? DEFAULTS.seed,
			shrink: o.shrink ?? DEFAULTS.shrink,
			out
		};
		writeFileSync(out, '');
		await child(job, dir, { root: job.root }, o.timeout_ms ?? DEFAULTS.timeout_ms);
		return deserialize(readFileSync(out)) as ProveChildResult;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export class CandidateError extends Error {}

/** Prove one candidate (the source of top-level declarations, splice.ts) against the original. */
export async function prove_candidate(
	o: ProveOptions,
	t: Target,
	samples: Sample[],
	candidate_source: string,
	name: string,
	n = 1
): Promise<ProveReport> {
	const original = readFileSync(t.file, 'utf8');
	const unsafe = unsafe_reason(t.file, candidate_source, { allow_imports: true });
	if (unsafe) throw new CandidateError(`the candidate is refused: ${unsafe}`);
	let spliced;
	try {
		spliced = splice(t.file, original, candidate_source, t.path);
	} catch (e) {
		if (e instanceof SpliceError) throw new CandidateError(e.message);
		throw e;
	}
	const file = candidate_path(t.file, n);
	const result = await run_child_job(o, t, samples, { file, source: spliced.source });
	const verdict = judge(result, o);
	return {
		schema: PROVE_SCHEMA,
		function: t.id,
		candidate: name,
		verdict,
		headline: headline(verdict),
		diff: unified_diff(t.module, original, spliced.source),
		replaced: spliced.replaced,
		added: spliced.added,
		child: result
	};
}

/** The candidate given as a file, or as source on the command line's behalf. */
export function read_candidate(path: string): string {
	const p = isAbsolute(path) ? path : resolve(path);
	if (!existsSync(p)) throw new Error(`heisenbench prove: no such candidate ${path}`);
	return readFileSync(p, 'utf8');
}
