/**
 * The rows of the training data (training.ts), built from what one measured group left on disk:
 * the counted reports of both sides, their engine health, the input sizes and the time comparison.
 * Two files come out of it (packages/heisenbench/calibration/data/training.md has the fields):
 *
 *   counts   exact: same inputs, same bytes. Steps (by kind), allocations, bytes, calls, units,
 *            engine health and input size of both sides of every pair, and their deltas.
 *   times    measured: every timing sample of both sides, the noise rule's verdicts, the label,
 *            and the machine's load while it was timed. Varies from run to run.
 *
 * A row is keyed by its `id` in both files.
 */
import { diffEngine } from '@bench/heisenbench';
import type {
	CaseReport,
	EngineCase,
	EngineReport,
	Report,
	TimeComparison
} from '@bench/heisenbench';
import { kind_steps } from '../../../packages/heisenbench/src/audit/fit.ts';
import { case_units } from '../../../packages/heisenbench/src/calibrate/weights.ts';
import type { Prices } from '../../../packages/heisenbench/src/prices.ts';
import type { Planted } from './planted.ts';

export const COUNTS_SCHEMA = 'heisenbench-training-counts/1';
export const TIMES_SCHEMA = 'heisenbench-training-times/1';

export interface SideCounts {
	steps: number;
	allocations: number;
	bytes: number;
	calls: number;
	/** Both counted runs agreed (they always do; a false here is a bug in counting). */
	stable: boolean;
	/**
	 * Steps per kind of work (an op kind like `call`, a dynamic price like `dyn.string_char`, a
	 * built-in like `bi.Array.prototype.sort`), priced with the file's `prices`. An op kind's steps
	 * over its price are its unit count.
	 */
	steps_by_kind: Record<string, number>;
	/** Calls per built-in (`Array.prototype.sort`), whatever their size. */
	builtin_calls: Record<string, number>;
	/** Size of the case's input (strings, elements, entries, keys), null when it could not be read. */
	input_size: number | null;
}

/** What V8 did with the case's functions, on the plain build (engine health). */
export interface EngineSummary {
	functions: number;
	/** Per tier, the functions that ended there. */
	interpreted: number;
	baseline: number;
	maglev: number;
	turbofan: number;
	/** Inlined into optimized code (whatever their own tier). */
	inlined: number;
	/** Had optimized code and lost it. */
	deoptimized: number;
	/** Forced to optimize, and V8 did not. */
	refused: number;
	/** Deopt events over every function. */
	deopts: number;
	sites: number;
	polymorphic: number;
	megamorphic: number;
	/** Functions and sites V8 did not repeat on every run (left out of the counts above). */
	unstable: number;
}

export interface CountRow {
	id: string;
	source: 'planted' | 'history';
	file: string;
	name: string;
	/** Planted rows: the template, the variant, the direction of the change by construction, the size knob. */
	template?: string;
	variant?: string;
	planted?: Planted;
	/** What `planted` is about: the steps, or what V8 does (planted.ts PLANTED_FOR). */
	planted_for?: 'steps' | 'engine';
	size?: number;
	/** History rows: the commit, its first parent, its subject. */
	commit?: string;
	parent?: string;
	subject?: string;
	base: SideCounts;
	pr: SideCounts;
	delta: {
		steps: number;
		/** % of the base's steps (100 when the base had none and the PR has some). */
		steps_pct: number;
		allocations: number;
		bytes: number;
		calls: number;
		/** PR minus base per kind, kinds that changed only. */
		steps_by_kind: Record<string, number>;
	};
	engine: {
		base: EngineSummary;
		pr: EngineSummary;
		/** Engine findings of the PR comment's engine diff: got worse, got better (by kind). */
		worse: Record<string, number>;
		better: Record<string, number>;
	} | null;
}

/** One timing sample: SAMPLE_FIELDS in order. */
export type Sample = [number, number, number, number | null, number];
export const SAMPLE_FIELDS = ['p50_ns', 'mean_ns', 'p99_ns', 'cpu_ns', 'samples'] as const;

export interface MetricVerdict {
	base: number;
	pr: number;
	/** % change of the median, PR against base. */
	diff_pct: number;
	regressed: boolean;
	improved: boolean;
	unjudged?: boolean;
}

export type Label = 'slower' | 'faster' | 'same';

export interface TimeRow {
	id: string;
	group: string;
	/** Rounds per side, confirming rounds included. */
	rounds: number;
	/** Rounds run more because a metric looked changed. */
	confirmed: number;
	/** Which side went first in each round. */
	order: Array<'base' | 'pr'>;
	base: Sample[];
	pr: Sample[];
	verdicts: Record<'p50_ns' | 'p99_ns' | 'throughput' | 'cpu_ns', MetricVerdict>;
	/** The p50 verdict of the no-overlap noise rule, the one the PR comment shows. */
	label: Label;
	beyond_noise: boolean;
}

/** The load average while one group was timed. */
export interface GroupLoad {
	id: string;
	kind: 'planted' | 'history';
	started: string;
	seconds: number;
	/** os.loadavg() 1-minute, at the start, the end, the lowest, highest and mean of the samples. */
	load: { start: number; end: number; min: number; max: number; mean: number };
	/** [seconds since start, 1-minute load], every LOAD_EVERY_S seconds. */
	series: Array<[number, number]>;
	error: string | null;
}

export interface CountsFile {
	schema: typeof COUNTS_SCHEMA;
	prices: { version: number; hash: string };
	/** What the rows were made from. */
	inputs: {
		planted: { templates: string[]; pairs: number } | null;
		history: { repo: string; from: string; to: string; bench: string; commits: number } | null;
	};
	rows: CountRow[];
}

export interface TimesFile {
	schema: typeof TIMES_SCHEMA;
	date: string;
	machine: { cpu: string; cores: number; os: string; node: string; v8: string };
	/** The bench repo commit that measured. */
	heisenbench: string | null;
	repeats: number;
	time_ms: number;
	sample_fields: typeof SAMPLE_FIELDS;
	groups: GroupLoad[];
	rows: TimeRow[];
}

// ---- counts

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

function sorted<T>(o: Record<string, T>): Record<string, T> {
	const out: Record<string, T> = {};
	for (const k of Object.keys(o).sort()) out[k] = o[k];
	return out;
}

export function side_counts(c: CaseReport, prices: Prices, input_size: number | null): SideCounts {
	const units = case_units(c);
	const by_kind: Record<string, number> = {};
	for (const [k, v] of kind_steps(units, prices)) by_kind[k] = r6(v);
	const calls: Record<string, number> = {};
	for (const [k, v] of Object.entries(units)) {
		if (v !== 0 && k.startsWith('bi.') && k.endsWith('.calls')) calls[k.slice(3, -6)] = v;
	}
	return {
		steps: c.totals.steps,
		allocations: c.totals.allocations,
		bytes: c.totals.bytes,
		calls: c.totals.calls,
		stable: c.stable,
		steps_by_kind: sorted(by_kind),
		builtin_calls: sorted(calls),
		input_size
	};
}

export function engine_summary(e: EngineCase): EngineSummary {
	const s: EngineSummary = {
		functions: 0,
		interpreted: 0,
		baseline: 0,
		maglev: 0,
		turbofan: 0,
		inlined: 0,
		deoptimized: 0,
		refused: 0,
		deopts: 0,
		sites: 0,
		polymorphic: 0,
		megamorphic: 0,
		unstable: 0
	};
	for (const f of e.functions) {
		if (f.unstable) {
			s.unstable++;
			continue;
		}
		s.functions++;
		if (f.tier === 'interpreted') s.interpreted++;
		else if (f.tier === 'baseline') s.baseline++;
		else if (f.tier === 'maglev') s.maglev++;
		else if (f.tier === 'turbofan') s.turbofan++;
		if (f.inlined) s.inlined++;
		if (f.not_optimized === 'deoptimized') s.deoptimized++;
		if (f.not_optimized === 'refused') s.refused++;
		for (const d of f.deopts) s.deopts += d.count;
	}
	for (const site of e.sites) {
		if (site.unstable) {
			s.unstable++;
			continue;
		}
		s.sites++;
		if (site.state === 'polymorphic') s.polymorphic++;
		if (site.state === 'megamorphic' || site.state === 'generic') s.megamorphic++;
	}
	return s;
}

const pct = (pr: number, base: number): number =>
	base === 0 ? (pr === 0 ? 0 : 100) : Math.round(((pr - base) / base) * 1e6) / 1e4;

const key_of = (c: { file: string; name: string }): string => `${c.file} > ${c.name}`;

/** Engine findings per case and kind. */
function by_case(list: Array<{ case: string; kind: string }>): Map<string, Record<string, number>> {
	const out = new Map<string, Record<string, number>>();
	for (const f of list) {
		const m = out.get(f.case) ?? {};
		m[f.kind] = (m[f.kind] ?? 0) + 1;
		out.set(f.case, m);
	}
	return out;
}

export interface GroupCounts {
	source: 'planted' | 'history';
	base: Report;
	pr: Report;
	/** Input sizes per `file > name`, each side. */
	sizes: { base: Record<string, number | null>; pr: Record<string, number | null> };
	/** Only rows of these bench files (null: every file both sides counted). */
	files: string[] | null;
	/** Row id of a case. */
	id: (c: CaseReport) => string;
	/** Fields a row adds (planted: template, variant...; history: commit...). */
	extra: (c: CaseReport) => Partial<CountRow>;
}

/** The rows of one group: every case both sides counted without an error. */
export function count_rows(g: GroupCounts, prices: Prices): CountRow[] {
	const base = new Map(g.base.cases.filter((c) => !c.error).map((c) => [key_of(c), c]));
	const files = g.files ? new Set(g.files) : null;
	const engine = (r: Report) =>
		new Map((r.engine?.cases ?? []).filter((c) => !c.error).map((c) => [key_of(c), c]));
	const be = engine(g.base);
	const pe = engine(g.pr);
	const ediff =
		g.base.engine && g.pr.engine
			? diffEngine(g.base.engine as EngineReport, g.pr.engine as EngineReport)
			: null;
	const worse = by_case(ediff?.findings ?? []);
	const better = by_case(ediff?.better ?? []);
	const rows: CountRow[] = [];
	for (const p of g.pr.cases) {
		if (p.error || (files && !files.has(p.file))) continue;
		const b = base.get(key_of(p));
		if (!b) continue;
		const bs = side_counts(b, prices, g.sizes.base[key_of(b)] ?? null);
		const ps = side_counts(p, prices, g.sizes.pr[key_of(p)] ?? null);
		const kinds = new Set([...Object.keys(bs.steps_by_kind), ...Object.keys(ps.steps_by_kind)]);
		const dk: Record<string, number> = {};
		for (const k of kinds) {
			const d = r6((ps.steps_by_kind[k] ?? 0) - (bs.steps_by_kind[k] ?? 0));
			if (d !== 0) dk[k] = d;
		}
		const bec = be.get(key_of(b));
		const pec = pe.get(key_of(p));
		rows.push({
			id: g.id(p),
			source: g.source,
			file: p.file,
			name: p.name,
			...g.extra(p),
			base: bs,
			pr: ps,
			delta: {
				steps: r6(ps.steps - bs.steps),
				steps_pct: pct(ps.steps, bs.steps),
				allocations: ps.allocations - bs.allocations,
				bytes: ps.bytes - bs.bytes,
				calls: ps.calls - bs.calls,
				steps_by_kind: sorted(dk)
			},
			engine:
				bec && pec
					? {
							base: engine_summary(bec),
							pr: engine_summary(pec),
							worse: sorted(worse.get(p.name) ?? {}),
							better: sorted(better.get(p.name) ?? {})
						}
					: null
		});
	}
	return rows;
}

// ---- times

const r1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * The timed rows of one group, by case name (a time comparison keys its cases by name only): a
 * name two counted rows share is left out, since its time cannot be told apart.
 */
export function time_rows(group: string, rows: CountRow[], t: TimeComparison): TimeRow[] {
	const by_name = new Map<string, CountRow | null>();
	for (const r of rows) by_name.set(r.name, by_name.has(r.name) ? null : r);
	const out: TimeRow[] = [];
	for (const tc of t.cases) {
		const row = by_name.get(tc.name);
		if (!row || tc.base.length === 0 || tc.pr.length === 0 || !tc.verdicts.p50_ns) continue;
		const sample = (s: TimeComparison['cases'][number]['base'][number]): Sample => [
			r1(s.p50_ns),
			r1(s.mean_ns),
			r1(s.p99_ns),
			s.cpu_ns === null ? null : r1(s.cpu_ns),
			s.samples
		];
		const verdicts = {} as TimeRow['verdicts'];
		for (const m of ['p50_ns', 'p99_ns', 'throughput', 'cpu_ns'] as const) {
			const v = tc.verdicts[m];
			verdicts[m] = {
				base: r1(v.base),
				pr: r1(v.pr),
				diff_pct: pct(v.pr, v.base),
				regressed: v.regressed,
				improved: v.improved,
				...(v.unjudged ? { unjudged: true } : {})
			};
		}
		const v = tc.verdicts.p50_ns;
		const label: Label = v.regressed ? 'slower' : v.improved ? 'faster' : 'same';
		out.push({
			id: row.id,
			group,
			rounds: tc.base.length,
			confirmed: tc.confirmed ?? 0,
			order: tc.order,
			base: tc.base.map(sample),
			pr: tc.pr.map(sample),
			verdicts,
			label,
			beyond_noise: label !== 'same'
		});
	}
	return out;
}

// ---- checks and writing

const LABELS: readonly string[] = ['slower', 'faster', 'same'];

function is_num(v: unknown): v is number {
	return typeof v === 'number' && Number.isFinite(v);
}

function check_side(s: SideCounts | undefined, at: string, out: string[]): void {
	if (!s || typeof s !== 'object') {
		out.push(`${at}: missing`);
		return;
	}
	for (const k of ['steps', 'allocations', 'bytes', 'calls'] as const)
		if (!is_num(s[k]) || s[k] < 0) out.push(`${at}.${k}: not a count`);
	if (typeof s.stable !== 'boolean') out.push(`${at}.stable: not a boolean`);
	if (s.input_size !== null && !is_num(s.input_size)) out.push(`${at}.input_size: not a number`);
	for (const k of ['steps_by_kind', 'builtin_calls'] as const) {
		const m = s[k];
		if (!m || typeof m !== 'object') out.push(`${at}.${k}: missing`);
		else if (Object.values(m).some((v) => !is_num(v))) out.push(`${at}.${k}: not numbers`);
	}
	if (s.steps_by_kind) {
		const sum = Object.values(s.steps_by_kind).reduce((a, b) => a + b, 0);
		if (Math.abs(sum - s.steps) > 1e-3 * Math.max(1, s.steps))
			out.push(`${at}.steps_by_kind: sums to ${sum}, not ${s.steps}`);
	}
}

/** What is wrong with a counts file (empty: nothing). */
export function check_counts(f: CountsFile): string[] {
	const out: string[] = [];
	if (f.schema !== COUNTS_SCHEMA) out.push(`schema: ${String(f.schema)}`);
	if (!f.prices || !is_num(f.prices.version) || typeof f.prices.hash !== 'string')
		out.push('prices: missing');
	if (!Array.isArray(f.rows)) return [...out, 'rows: not a list'];
	const ids = new Set<string>();
	for (const r of f.rows) {
		const at = `rows[${r.id}]`;
		if (typeof r.id !== 'string' || ids.has(r.id)) out.push(`${at}: id missing or repeated`);
		ids.add(r.id);
		if (r.source !== 'planted' && r.source !== 'history') out.push(`${at}.source`);
		if (r.source === 'planted' && !LABELS.includes(r.planted ?? ''))
			out.push(`${at}.planted: ${String(r.planted)}`);
		if (r.source === 'history' && typeof r.commit !== 'string') out.push(`${at}.commit`);
		check_side(r.base, `${at}.base`, out);
		check_side(r.pr, `${at}.pr`, out);
		if (!r.delta || !is_num(r.delta.steps) || !is_num(r.delta.steps_pct))
			out.push(`${at}.delta: missing`);
		else if (r.base && r.pr && Math.abs(r.pr.steps - r.base.steps - r.delta.steps) > 1e-3)
			out.push(`${at}.delta.steps: not pr - base`);
	}
	const sorted_ids = f.rows.map((r) => r.id).sort();
	if (sorted_ids.some((id, i) => id !== f.rows[i].id)) out.push('rows: not sorted by id');
	return out;
}

/** What is wrong with a times file, against the counts it goes with (empty: nothing). */
export function check_times(t: TimesFile, counts: CountsFile): string[] {
	const out: string[] = [];
	if (t.schema !== TIMES_SCHEMA) out.push(`schema: ${String(t.schema)}`);
	if (typeof t.machine?.node !== 'string') out.push('machine.node: missing');
	if (!Array.isArray(t.rows)) return [...out, 'rows: not a list'];
	const ids = new Set(counts.rows.map((r) => r.id));
	const groups = new Set((t.groups ?? []).map((g) => g.id));
	for (const g of t.groups ?? []) {
		if (!is_num(g.load?.start) || !is_num(g.load?.max)) out.push(`groups[${g.id}].load`);
	}
	for (const r of t.rows) {
		const at = `rows[${r.id}]`;
		if (!ids.has(r.id)) out.push(`${at}: no counted row`);
		if (!groups.has(r.group)) out.push(`${at}.group: ${r.group} not in groups`);
		if (!LABELS.includes(r.label)) out.push(`${at}.label: ${String(r.label)}`);
		if (r.beyond_noise !== (r.label !== 'same')) out.push(`${at}.beyond_noise`);
		if (r.base.length !== r.rounds || r.pr.length !== r.rounds) out.push(`${at}: rounds`);
		for (const s of [...r.base, ...r.pr])
			if (s.length !== SAMPLE_FIELDS.length || !is_num(s[0]) || !(s[0] >= 0)) {
				out.push(`${at}: a sample is not ${SAMPLE_FIELDS.join(', ')}`);
				break;
			}
	}
	return out;
}

/**
 * The file's text: its fields as indented JSON, except the lists of rows and groups, one entry
 * per line. The same value gives the same bytes.
 */
export function dataset_text(f: CountsFile | TimesFile): string {
	const parts = Object.entries(f).map(([k, v]) => {
		if ((k === 'rows' || k === 'groups') && Array.isArray(v)) {
			const items = v.map((x: unknown) => `\t\t${JSON.stringify(x)}`).join(',\n');
			return `\t${JSON.stringify(k)}: [${v.length > 0 ? `\n${items}\n\t` : ''}]`;
		}
		return `\t${JSON.stringify(k)}: ${JSON.stringify(v, null, '\t').split('\n').join('\n\t')}`;
	});
	return `{\n${parts.join(',\n')}\n}\n`;
}
