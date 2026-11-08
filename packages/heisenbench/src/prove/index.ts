import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { SVELTE_CONFIGS } from '../transform/index.ts';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import type { FunctionRecord, Sample } from '../coverage/recorder.ts';
import { load_records } from '../coverage/recorder.ts';
import { merge_records, read_record_dir } from '../coverage/replay-run.ts';
import { GROWTH_RANK } from '../growth/fit.ts';
import { DEFAULT_SIZES, GROWTH_CAP } from '../growth/index.ts';
import { OWN_DIR, PACKAGE_DIR, own_file } from '../own.ts';
import { canonical_function, load_weights_list } from '../weight/weights.ts';
import type { AppWeights } from '../weight/weights.ts';
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
 * 2. Fewer steps. Both are counted on the same inputs. Three verdicts:
 *
 *    proven           the same behavior; no recorded or grown input costs more than the
 *                     original's steps plus the tolerance (5% + 256 steps); and the total, or the
 *                     growth curve, improves
 *    proven at scale  the same behavior and cheaper at scale (a better growth curve, or cheaper at
 *                     every grown size), but some smaller inputs cost more: the Map it builds once
 *                     costs more than the loop it replaced on a short list. The headline says how
 *                     much, on which sizes, and from which grown size on it is cheaper
 *    rejected         the behavior differs, or it costs more and is not cheaper at scale
 *
 *    `--setup-tolerance` is an opt-in: a "proven at scale" whose costlier inputs all stay within
 *    it is "proven". Edge cases decide behavior only: their steps are shown, never a regression.
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
	 * Opt-in, unset by default: a "proven at scale" candidate whose costlier inputs each cost at
	 * most this share more than the original (plus `tolerance_steps`) is "proven".
	 */
	setup_tolerance?: number;
	/** App weights files (`heisenbench weights`, comma-joined): which sizes app traffic calls it at. */
	weights?: string;
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

/** `Class > method` or `Class > static method`: a method of a top-level class. */
const METHOD_PATH = /^[A-Za-z_$][\w$]* > (?:static )?[A-Za-z_$][\w$]*$/;

export function target_of(root: string, module: string, fn: string): Target {
	const file = resolve(module);
	if (!existsSync(file)) throw new Error(`heisenbench prove: no such module ${module}`);
	const id = relative(resolve(root), file).split(sep).join('/');
	if (id.startsWith('..'))
		throw new Error(`heisenbench prove: ${module} is not under --root ${root}`);
	// a full id (`src/a.ts > f`), or a path in the module (`f`, `Cache > get`)
	const head = fn.includes(' > ') ? fn.slice(0, fn.indexOf(' > ')) : null;
	const names_module = head !== null && (head.includes('/') || /\.[cm]?[jt]sx?$/.test(head));
	if (names_module && head !== id) throw new Error(`heisenbench prove: ${fn} is not in ${id}`);
	const path = names_module ? fn.slice(head!.length + 3) : fn;
	// a method of a top-level class (`Cache > get`, `Cache > static of`): its candidate is the class
	if (path.includes(' > ') && !METHOD_PATH.test(path))
		throw new Error(
			`heisenbench prove: ${fn} is nested; prove the top-level function that holds it (${path.split(' > ')[0]}) with a candidate for it`
		);
	return { id: `${id} > ${path}`, module: id, file, path };
}

export type VerdictKind = 'proven' | 'proven at scale' | 'rejected' | 'not proven';

/** Where the candidate costs more than the strict tolerance, while it is cheaper at scale. */
export interface AtScale {
	/** The costlier recorded and grown inputs. */
	inputs: number;
	recorded: number;
	/** The one that costs the most more, by ratio. */
	worst: { label: string; size: number; original: number; candidate: number };
	/** Smallest and largest size among them. */
	sizes: [number, number];
	/** The smallest factor of the steepest grown curve from which on the candidate is cheaper at every factor. */
	cheaper_from: { k: number; size: number } | null;
	/** `--setup-tolerance` was given and every costlier input stays within it. */
	within_setup_tolerance: boolean;
}

/** The sizes app traffic calls the function at, read from app weights (steps per call -> input size). */
export interface TrafficSizes {
	/** Units (app scenarios) that call it, with the steps a call costs there and the size that costs that. */
	units: Array<{ unit: string; calls: number; steps_per_call: number; size: number }>;
	/** Units the weights have; none of them may call it. */
	of: number;
	sizes: [number, number] | null;
	/** The candidate's steps over the original's at the measured inputs nearest those sizes. */
	ratios: [number, number] | null;
}

export interface Verdict {
	kind: VerdictKind;
	/** `kind === 'proven'`. */
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
		/** Recorded and grown inputs whose candidate costs more than the tolerance (worst first, at most 5). */
		regressions: Array<{ label: string; size: number; original: number; candidate: number | null }>;
		regressed: number;
		/** For "proven at scale" (and a proven within --setup-tolerance): where it costs more. */
		at_scale: AtScale | null;
		improved: number;
		/** Edge-case inputs whose candidate costs more (shown, not a regression: edge cases test behavior). */
		edge_regressions: number;
	};
	growth: ProveChildResult['growth'];
	/** With `--weights`: the sizes app traffic calls it at. */
	traffic: TrafficSizes | null;
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
	// cheaper at every grown size of the steepest curve, or a better curve and cheaper at its largest
	const grown = (g?.rows ?? []).filter((x) => x.k > 1);
	const cheaper = (x: (typeof grown)[number]) =>
		x.candidate !== null && (x.original === null || x.candidate.steps < x.original.steps);
	const wins_grown = grown.length > 0 && grown.every(cheaper);
	const wins_largest = grown.length > 0 && cheaper(grown[grown.length - 1]);
	const at_scale_ok = wins_grown || (growth_better && wins_largest);
	let went_past = 0;
	for (const r of rows) {
		const oc = r.original.cost;
		const cc = r.candidate?.cost ?? null;
		if (!oc) continue;
		const past = r.candidate?.capped === true;
		if (cc && cc.steps < oc.steps) improved++;
		if (!(past || (cc && regresses(oc.steps, cc.steps, t)))) continue;
		if (!gated(r)) {
			edge_regressions++;
			continue;
		}
		if (past) went_past++;
		regressions.push({
			label: r.label,
			size: r.size,
			original: oc.steps,
			candidate: cc?.steps ?? null
		});
	}
	regressions.sort(
		(a, b) => (b.candidate ?? Infinity) / b.original - (a.candidate ?? Infinity) / a.original
	);
	const original = sum_cost(counted.map((r) => r.original.cost!));
	const candidate = sum_cost(counted.map((r) => r.candidate!.cost!));
	const total_better = candidate.steps < original.steps * (1 - min_gain);
	let at_scale: AtScale | null = null;
	if (regressions.length > 0 && went_past === 0 && at_scale_ok) {
		const worst = regressions[0] as AtScale['worst'];
		const sizes = regressions.map((x) => x.size);
		const st = o.setup_tolerance;
		at_scale = {
			inputs: regressions.length,
			recorded: regressions.filter(
				(x) => rows.find((r) => r.label === x.label)?.kind === 'recorded'
			).length,
			worst,
			sizes: [Math.min(...sizes), Math.max(...sizes)],
			cheaper_from: cheaper_from(g),
			within_setup_tolerance:
				st !== undefined &&
				regressions.every((x) => x.candidate! <= x.original * (1 + st) + t.tolerance_steps)
		};
	}
	const verdict: Verdict = {
		kind: 'not proven',
		proven: false,
		reason: '',
		inputs: { total: rows.length, by_kind, same, differing, undecided },
		minimal: child.minimal,
		steps: {
			original,
			candidate,
			regressions: regressions.slice(0, 5),
			regressed: regressions.length,
			at_scale,
			improved,
			edge_regressions
		},
		growth: g,
		traffic: null
	};
	const tol = `${Math.round(t.tolerance * 100)}% + ${t.tolerance_steps} steps`;
	const say = (kind: VerdictKind, reason: string) => {
		verdict.kind = kind;
		verdict.proven = kind === 'proven';
		verdict.reason = reason;
	};
	if (child.errors.length > 0) say('not proven', `not proven: ${child.errors[0]}`);
	else if (rows.length === 0)
		say('not proven', 'not proven: no recorded input of the function (give --records or --bench)');
	else if (differing > 0)
		say('rejected', `rejected: behaves differently on ${differing} of ${rows.length} inputs`);
	else if (counted.length === 0) say('not proven', 'not proven: no input both sides counted');
	else if (at_scale?.within_setup_tolerance)
		say('proven', `proven: within the setup tolerance of ${Math.round(o.setup_tolerance! * 100)}%`);
	else if (at_scale)
		say(
			'proven at scale',
			`proven at scale: costs more than ${tol} on ${at_scale.inputs} smaller input(s), cheaper at scale`
		);
	else if (regressions.length > 0)
		say(
			'rejected',
			`rejected: costs more steps on ${regressions.length} input(s) (more than ${tol})${went_past > 0 ? `, ${went_past} past its step cap` : ''}, and is not cheaper at scale`
		);
	else if (!(total_better || growth_better))
		say(
			'rejected',
			`rejected: not cheaper (${fmt(original.steps)} -> ${fmt(candidate.steps)} steps over ${counted.length} inputs, the same growth)`
		);
	else say('proven', 'proven');
	// where it costs more matters to a candidate that stands; a rejection lists its regressions
	if (verdict.kind === 'rejected' || verdict.kind === 'not proven') verdict.steps.at_scale = null;
	return verdict;
}

/** The smallest factor of the curve from which on the candidate is cheaper at every factor. */
function cheaper_from(g: ProveChildResult['growth']): AtScale['cheaper_from'] {
	if (!g) return null;
	let from: AtScale['cheaper_from'] = null;
	for (let i = g.rows.length - 1; i >= 0; i--) {
		const x = g.rows[i];
		if (!(x.candidate && (x.original === null || x.candidate.steps < x.original.steps))) break;
		from = { k: x.k, size: x.size };
	}
	return from;
}

function pct_more(o: number, c: number): string {
	return `+${Math.round(((c - o) / o) * 100)}%`;
}

/**
 * Which input sizes app traffic calls the function at: each weights unit (an app scenario) that
 * calls it costs the original `inclusive_steps / calls` steps a call; the size at which the
 * original costs that many steps on the measured inputs (log-log between the two nearest) is the
 * size that unit passes it. Units of real traffic are timed, not counted, and are left out.
 */
export function traffic_sizes(w: AppWeights, t: Target, child: ProveChildResult): TrafficSizes {
	const id = canonical_function(t.module, t.path);
	const fw = w.functions[id] ?? {};
	const counted = Object.entries(w.units).filter(([, u]) => !u.traffic);
	const points = child.inputs
		.filter((r) => r.kind !== 'edge' && r.original.cost && r.size > 0)
		.map((r) => ({
			size: r.size,
			steps: r.original.cost!.steps,
			cand: r.candidate?.cost?.steps ?? null
		}))
		.sort((a, b) => a.steps - b.steps || a.size - b.size);
	const units: TrafficSizes['units'] = [];
	for (const [unit] of counted) {
		const f = fw[unit];
		if (!f || !(f.calls > 0) || points.length === 0) continue;
		const per = f.inclusive_steps / f.calls;
		units.push({ unit, calls: f.calls, steps_per_call: per, size: size_for(points, per) });
	}
	const sizes = units.map((u) => u.size);
	let ratios: TrafficSizes['ratios'] = null;
	if (sizes.length > 0) {
		const near = (s: number) =>
			points
				.filter((p) => p.cand !== null)
				.reduce<(typeof points)[number] | null>(
					(a, p) => (!a || Math.abs(Math.log(p.size / s)) < Math.abs(Math.log(a.size / s)) ? p : a),
					null
				);
		const rs = sizes
			.map(near)
			.filter((p) => p !== null)
			.map((p) => p!.cand! / p!.steps);
		if (rs.length > 0) ratios = [Math.min(...rs), Math.max(...rs)];
	}
	return {
		units,
		of: counted.length,
		sizes: sizes.length > 0 ? [Math.min(...sizes), Math.max(...sizes)] : null,
		ratios
	};
}

/** The size at which the original costs `steps`, log-log between the measured points around it. */
function size_for(points: ReadonlyArray<{ size: number; steps: number }>, steps: number): number {
	let lo = points[0];
	let hi = points[points.length - 1];
	if (steps <= lo.steps) return lo.size;
	if (steps >= hi.steps) return hi.size;
	for (const p of points) {
		if (p.steps <= steps) lo = p;
		if (p.steps >= steps) {
			hi = p;
			break;
		}
	}
	if (hi.steps === lo.steps) return lo.size;
	const f = Math.log(steps / lo.steps) / Math.log(hi.steps / lo.steps);
	return Math.round(Math.exp(Math.log(lo.size) + f * Math.log(hi.size / lo.size)));
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
	const s = v.steps.at_scale;
	const costs = s ? `; ${at_scale_words(s)}` : '';
	const tr = v.traffic ? `; ${traffic_words(v.traffic)}` : '';
	const kind = v.kind === 'proven' && s ? 'proven within the setup tolerance' : v.kind;
	return `${kind}: ${parts.join(', ')}${costs}${tr}`;
}

/** `costs +162% (3,022 -> 7,915 steps) on 16 recorded and 2 grown inputs (sizes 5..35,250), cheaper from 10x up on the steepest grown input (from size 68,913)` */
export function at_scale_words(s: AtScale): string {
	const w = s.worst;
	const grown = s.inputs - s.recorded;
	const which =
		grown === 0
			? `${s.inputs} of the recorded inputs`
			: s.recorded === 0
				? `${s.inputs} grown inputs`
				: `${s.recorded} recorded and ${grown} grown inputs`;
	const sizes =
		s.sizes[0] === s.sizes[1]
			? `size ${fmt(s.sizes[0])}`
			: `sizes ${fmt(s.sizes[0])}..${fmt(s.sizes[1])}`;
	const from = s.cheaper_from
		? `, cheaper from ${s.cheaper_from.k}x up on the steepest grown input (from size ${fmt(s.cheaper_from.size)})`
		: '';
	return `costs ${pct_more(w.original, w.candidate)} (${fmt(w.original)} -> ${fmt(w.candidate)} steps) on ${which} (${sizes})${from}`;
}

/** `app traffic: not called in the 16 app scenarios` / `app traffic (docs, shop): sizes ~120..340, where the candidate costs 0.84x..1.20x` */
export function traffic_words(tr: TrafficSizes): string {
	if (tr.units.length === 0) return `app traffic: not called in the ${tr.of} app scenarios`;
	const names = [...new Set(tr.units.map((u) => u.unit))];
	const shown =
		names.length > 3
			? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
			: names.join(', ');
	const [a, b] = tr.sizes!;
	const at = a === b ? `size ~${fmt(a)}` : `sizes ~${fmt(a)}..${fmt(b)}`;
	const r = tr.ratios
		? `, where the candidate costs ${tr.ratios[0].toFixed(2)}x${tr.ratios[1] !== tr.ratios[0] ? `..${tr.ratios[1].toFixed(2)}x` : ''} the original's steps`
		: '';
	return `app traffic (${shown}): ${at}${r}`;
}

/** The function's samples from the record directories and the bench files. */
export async function samples_of(
	o: ProveOptions,
	t: Target
): Promise<{ samples: Sample[]; calls: number; too_deep: number }> {
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
	return { samples: r?.samples ?? [], calls: r?.calls ?? 0, too_deep: r?.too_deep ?? 0 };
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

/** Files the loader reads above a module, wherever it is: the package scope and Svelte's options. */
const UPWARD_FILES = ['package.json', ...SVELTE_CONFIGS];

/**
 * What the project's code may need to read outside its root, when it is a package of a
 * workspace: the `node_modules` of every directory above it (a pnpm workspace keeps every
 * dependency in the top one), the packages its own `node_modules` link to (a sibling of the
 * workspace), and the package.json and svelte.config files of every directory above it, which
 * the loader looks for (a module's package scope, a component's compiler options). Never the
 * sources of the directories above.
 */
export function project_reads(root: string): string[] {
	const out: string[] = [];
	const real = realpathSync(root);
	const linked = (nm: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(nm);
		} catch {
			return;
		}
		for (const e of entries) {
			const names = e.startsWith('@')
				? (() => {
						try {
							return readdirSync(join(nm, e)).map((x) => join(e, x));
						} catch {
							return [];
						}
					})()
				: [e];
			for (const n of names) {
				try {
					out.push(realpathSync(join(nm, n)));
				} catch {
					// a link to nothing
				}
			}
		}
	};
	linked(join(real, 'node_modules'));
	for (let d = dirname(real); ; d = dirname(d)) {
		for (const f of UPWARD_FILES) out.push(join(d, f));
		const nm = join(d, 'node_modules');
		if (existsSync(nm)) out.push(realpathSync(nm));
		if (dirname(d) === d) break;
	}
	return out;
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
				dir,
				...project_reads(sandbox.root)
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
	if (o.weights) verdict.traffic = traffic_sizes(load_weights_list(o.weights), t, result);
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
