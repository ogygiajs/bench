/**
 * The `heisenbench` section of the PR's benchmark comment, and the JSON result kept on the results branch.
 *
 * Every part is capped (the bench files run, the files that did not run, engine and growth
 * findings, the full run's table), so a PR that touches everything still gets a section that
 * reads in one screen and stays far from GitHub's comment size limit; the rest is in result.json.
 * Every name that lands in the markdown (case names, function ids, errors) is escaped for it.
 */
import {
	SECTION_MARKER,
	markdownCell,
	markdownCode,
	renderMarkdown,
	renderSections
} from '@bench/heisenbench';
import type { DiffResult, Report, TimeComparison } from '@bench/heisenbench';
import type { LoadError } from './run.ts';
import { FLAG_RATIO, flagged } from './search.ts';
import type { SearchRun } from './search.ts';
import type { Selection } from './select.ts';
import type { WeightRun } from './weights.ts';

export const RESULT_SCHEMA = 'ogygia-heisenbench/1';
export const HEADING = '#### Heisenbench: steps per function';

type SectionsDiff = Parameters<typeof renderSections>[0];

/** How many entries each list or table shows; the rest are counted in one line. */
export const CAPS = {
	selection: 20,
	load_errors: 10,
	engine: 15,
	engine_better: 10,
	growth: 15,
	growth_same: 15,
	search: 5,
	weights: 5,
	failed: 15,
	full_rows: 200
} as const;

export interface Meta {
	/** `pr`: a PR against its base; `main`: a full run of one commit. */
	kind: 'pr' | 'main' | 'manual';
	pr: number | null;
	sha: string;
	/** The base the PR was opened against (as the dispatch sent it). */
	base: string | null;
	/** What the PR is measured against: the merge base of the PR and its base. */
	merge_base: string | null;
	/** The bench repository commit (the Heisenbench that counted). */
	heisenbench: string | null;
	node: string;
	run_url: string | null;
	/** The plain-build layers each `heisenbench run` added (`time,bytes,leaks`), or null. */
	measure: string | null;
}

export interface Result {
	schema: typeof RESULT_SCHEMA;
	meta: Meta;
	selection: Selection;
	head: Report | null;
	base: Report | null;
	diff: (DiffResult & SectionsDiff) | null;
	load_errors: { head: LoadError[]; base: LoadError[] };
	/** A PR's time layer: both trees timed in turns (null on a full run, or with nothing to time). */
	time: { comparison: TimeComparison | null; markdown: string; error: string | null } | null;
	/** A PR's changed functions ranked by main's real-app weights (absent: not asked for). */
	weights?: WeightRun | null;
	/** A PR's worst-case search over the changed cases that declare an input. */
	search?: SearchRun | null;
}

const code = markdownCode;

function steps_text(n: number): string {
	const a = Math.abs(n);
	const sign = n < 0 ? '−' : '+';
	if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)}M`;
	if (a >= 1e4) return `${sign}${(a / 1e3).toFixed(1)}K`;
	return `${sign}${Math.round(a * 100) / 100}`;
}

function ns_text(ns: number): string {
	const a = Math.abs(ns);
	const sign = ns < 0 ? '−' : '+';
	if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)} ms`;
	if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)} µs`;
	return `${sign}${a.toFixed(a >= 10 ? 0 : 1)} ns`;
}

/** A time in the unit that reads best: `877.86 µs`, the same as the time table. */
function time_text(ns: number): string {
	if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
	if (ns >= 1e3) return `${(ns / 1e3).toFixed(2)} µs`;
	return `${ns.toFixed(0)} ns`;
}

/** Changed functions ranked by real-app weight: a short table, or one line saying why not. */
export function weight_lines(w: WeightRun): string[] {
	const from = w.sha ? ` (main ${short(w.sha)})` : '';
	if (w.status !== 'ranked') {
		return [`**Real-app weight**: not ranked, ${markdownCell(w.note ?? w.status)}${from}.`, ''];
	}
	// no function changed: nothing to rank, nothing to say
	if (w.ranked.length === 0) return [];
	const shown = w.ranked.filter((r) => r.show);
	if (shown.length === 0) {
		return [
			`**Real-app weight**${from}: no changed function costs the app scenarios enough to show (${w.suppressed} small, on a cold or warm path).`,
			''
		];
	}
	const lines = [
		`**Real-app weight**${from}: the change per call times the calls per unit of real work.`,
		'',
		'| Function | Δ per call | Path | Per unit |',
		'| --- | ---: | --- | --- |'
	];
	for (const r of shown.slice(0, CAPS.weights)) {
		const t = r.top;
		const per = t
			? `${steps_text(t.steps)} steps${t.ns !== null ? ` (≈ ${ns_text(t.ns)})` : ''} per ${markdownCell(t.unit)} (${Math.round(t.calls * 100) / 100} calls)`
			: 'no scenario runs it';
		lines.push(
			`| ${code(`${r.function}:${r.line}`)} | ${steps_text(r.delta_per_call)} steps | ${r.heat} | ${per} |`
		);
	}
	const rest = w.shown - Math.min(shown.length, CAPS.weights);
	const tail = [
		rest > 0 ? `${rest} more in result.json` : '',
		w.suppressed > 0 ? `${w.suppressed} small, on a cold or warm path, not shown` : ''
	].filter(Boolean);
	if (tail.length > 0) lines.push('', `${tail.join('; ')}.`);
	lines.push('');
	return lines;
}

function seconds(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s} s`;
	return s % 60 === 0 ? `${s / 60} min` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

function preview(input: string, max = 80): string {
	return input.length > max ? input.slice(0, max - 3) + '...' : input;
}

/** The worst-case search: one line, plus one per flagged case. */
export function search_lines(s: SearchRun): string[] {
	const searched = s.cases.length;
	// no changed case at all: nothing to say
	if (searched === 0 && s.no_input === 0 && s.skipped === 0) return [];
	const notes = [
		`${plural(searched, 'changed case')} with an input`,
		`${seconds(s.spent_ms)} of a ${seconds(s.budget_ms)} budget`,
		s.skipped > 0 ? `${s.skipped} not searched (time or the case cap)` : '',
		s.cases.some((c) => c.error) ? `${s.cases.filter((c) => c.error).length} did not finish` : ''
	].filter(Boolean);
	const head = `**Worst-case search** (${notes.join(', ')})`;
	if (searched === 0)
		return [
			`${head}: nothing to search${s.no_input > 0 ? ` (${plural(s.no_input, 'changed case')} with no input)` : ''}.`
		];
	const hits = s.cases.filter(flagged);
	if (hits.length === 0)
		return [`${head}: no input of the same size costs ${FLAG_RATIO}x the typical steps or more.`];
	const lines = [`${head}:`, ''];
	for (const c of hits.slice(0, CAPS.search)) {
		const h = c.head!;
		const base = c.base && !c.base.error ? `${c.base.ratio}x on the base` : 'not on the base';
		lines.push(
			`- ⚠️ ${code(c.name)}: an input costs ${h.ratio}x the typical steps (${Math.round(h.worst).toLocaleString('en-US')} vs ${Math.round(h.typical).toLocaleString('en-US')}; ${base}): ${code(preview(h.input))}`
		);
	}
	return lines;
}

/** The first non-empty line of an error, trimmed and shortened: one table cell or list line. */
export function one_line(error: string, max = 200): string {
	const first = (error.split('\n').find((l) => l.trim() !== '') ?? '').trim();
	return first.length > max ? first.slice(0, max - 3) + '...' : first;
}

function short(sha: string | null): string {
	return sha ? code(sha.slice(0, 7)) : '?';
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function run_link(meta: Meta): string {
	return meta.run_url ? ` [Heisenbench run](${meta.run_url})` : '';
}

/** `n more` line for a list cut at `cap`, or nothing. */
function more(total: number, cap: number, what: string): string[] {
	return total > cap ? [`- and ${total - cap} more ${what} (in result.json)`] : [];
}

/** Heisenbench's own warning that the two reports differ in environment; the section says it first. */
const HEISENBENCH_ENV_NOTE = '> ⚠️ The two reports come from different environments';

/** Heisenbench's own step table, without its marker, its heading and its environment note. */
function step_body(diff: DiffResult): string {
	const lines = renderMarkdown(diff).split('\n');
	if (lines[0] === SECTION_MARKER) lines.shift();
	if (lines[0]?.startsWith('#')) lines.shift();
	const env = lines.findIndex((l) => l.startsWith(HEISENBENCH_ENV_NOTE));
	if (env !== -1) lines.splice(env, lines[env + 1] === '' ? 2 : 1);
	while (lines[0] === '') lines.shift();
	return lines.join('\n');
}

/** One line when head and base were counted in different environments. */
export function env_note(diff: DiffResult | null): string | null {
	const env = diff?.env ?? [];
	if (env.length === 0) return null;
	return `⚠️ PR and base were counted in different environments (${markdownCell(env.join('; '))}): steps are compared, engine health is not.`;
}

/**
 * The bench files that did not run on one side: the suite's own errors (a command that crashed,
 * timed out or wrote nothing) and the files the report says did not load. One line each.
 */
function error_entries(side: string, errors: LoadError[], report: Report | null): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const e of errors) {
		seen.add(`${e.file}\0${e.command}`);
		out.push(`- ${side}: ${code(e.file)} (${e.command}): ${code(one_line(e.error))}`);
	}
	for (const e of report?.load_errors ?? []) {
		if (seen.has(`${e.file}\0run`)) continue;
		out.push(`- ${side}: ${code(e.file)} (load): ${code(one_line(e.error))}`);
	}
	return out;
}

function did_not_run(r: Result, sides: Array<['PR' | 'base' | 'head', 'head' | 'base']>): string[] {
	const entries = sides.flatMap(([label, key]) =>
		error_entries(label, r.load_errors[key], key === 'head' ? r.head : r.base)
	);
	if (entries.length === 0) return [];
	return [
		'**Did not run**:',
		'',
		...entries.slice(0, CAPS.load_errors),
		...more(entries.length, CAPS.load_errors, 'files'),
		''
	];
}

function selection_lines(sel: Selection): string[] {
	if (sel.selected.length === 0) return [];
	const lines = ['<details><summary>Bench files run</summary>', ''];
	for (const f of sel.selected.slice(0, CAPS.selection)) {
		const hits = sel.reach[f];
		if (!hits || hits.length === 0) {
			lines.push(`- ${code(f)}`);
			continue;
		}
		const shown = hits.slice(0, 4).map(code).join(', ');
		const rest = hits.length > 4 ? ` and ${hits.length - 4} more` : '';
		lines.push(`- ${code(f)}, reaching ${shown}${rest}`);
	}
	lines.push(...more(sel.selected.length, CAPS.selection, 'bench files'));
	lines.push('', '</details>', '');
	return lines;
}

/** Heisenbench's engine and growth parts, each list cut to its cap with a count of the rest. */
function capped_sections(d: SectionsDiff): string {
	const parts: string[] = [];
	const e = d.engine;
	if (e) {
		const engine = renderSections({
			engine: {
				findings: e.findings.slice(0, CAPS.engine),
				better: e.better.slice(0, CAPS.engine_better),
				unstable: e.unstable.slice(0, CAPS.failed),
				failed: e.failed.slice(0, CAPS.failed)
			},
			growth: null,
			search: null
		});
		const cut =
			Math.max(0, e.findings.length - CAPS.engine) +
			Math.max(0, e.better.length - CAPS.engine_better) +
			Math.max(0, e.unstable.length - CAPS.failed) +
			Math.max(0, e.failed.length - CAPS.failed);
		parts.push(cut > 0 ? `${engine}\n${cut} more engine entries are in result.json.\n` : engine);
	}
	const g = d.growth;
	if (g || d.search) {
		const growth = renderSections({
			engine: null,
			growth: g && {
				findings: g.findings.slice(0, CAPS.growth),
				better: g.better.slice(0, CAPS.growth),
				same: g.same.slice(0, CAPS.growth_same),
				failed: g.failed.slice(0, CAPS.failed)
			},
			search: d.search && d.search.slice(0, CAPS.search)
		});
		const cut =
			(g
				? Math.max(0, g.findings.length - CAPS.growth) +
					Math.max(0, g.better.length - CAPS.growth) +
					Math.max(0, g.same.length - CAPS.growth_same) +
					Math.max(0, g.failed.length - CAPS.failed)
				: 0) + Math.max(0, (d.search?.length ?? 0) - CAPS.search);
		parts.push(cut > 0 ? `${growth}\n${cut} more growth entries are in result.json.\n` : growth);
	}
	return parts.join('\n');
}

/** The PR comment's `heisenbench` section. */
export function render_pr_section(r: Result): string {
	const { meta, selection: sel } = r;
	const lines: string[] = [HEADING, ''];
	const against = `${short(meta.sha)} against ${short(meta.merge_base)}, where it branched from its base`;
	if (sel.selected.length === 0) {
		lines.push(
			`No bench file reaches the files this PR changes (${plural(sel.all.length, 'bench file')} checked, ${against}).${run_link(meta)}`
		);
		return lines.join('\n') + '\n';
	}
	const why =
		sel.mode === 'all'
			? `all ${plural(sel.all.length, 'bench file')} ran (${markdownCell(sel.reason ?? '')})`
			: `${sel.selected.length} of ${plural(sel.all.length, 'bench file')} reach the files this PR changes`;
	lines.push(
		`${against}: ${why}. Steps are exact, so one run of each side decides.${run_link(meta)}`,
		''
	);
	const env = env_note(r.diff);
	if (env) lines.push(env, '');
	lines.push(...selection_lines(sel));
	lines.push(
		...did_not_run(r, [
			['PR', 'head'],
			['base', 'base']
		])
	);
	if (r.base && r.base.cases.length === 0 && r.head && r.head.cases.length > 0) {
		lines.push(
			'The base has none of these cases yet, so there is nothing to compare them with.',
			''
		);
	}
	if (r.weights) lines.push(...weight_lines(r.weights));
	if (r.diff) {
		lines.push(step_body(r.diff));
		const extra = capped_sections(r.diff);
		if (extra) lines.push('', extra);
	}
	const search = r.search ? search_lines(r.search) : [];
	if (search.length > 0) lines.push('', ...search);
	if (r.time?.error) {
		lines.push('', `**Time layer failed**: ${code(one_line(r.time.error))}`);
	} else if (r.time?.comparison && r.time.comparison.cases.length > 0) {
		lines.push('', r.time.markdown);
	}
	return lines.join('\n').trimEnd() + '\n';
}

function fmt(n: number): string {
	return Math.round(n).toLocaleString('en-US');
}

/** A full run (main push, nightly): what each case counts. Shown in the run summary. */
export function render_full_summary(r: Result): string {
	const lines: string[] = [HEADING, ''];
	const cases = r.head?.cases ?? [];
	lines.push(
		`${short(r.meta.sha)}: ${plural(cases.length, 'case')} in ${plural(r.selection.selected.length, 'bench file')}.${run_link(r.meta)}`,
		''
	);
	lines.push(...did_not_run(r, [['head', 'head']]));
	if (cases.length > 0) {
		lines.push(
			'| Case | Steps | Allocations | Bytes (est.) | Bytes (real) | p50 | Leak | Note |',
			'| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |'
		);
		for (const c of cases.slice(0, CAPS.full_rows)) {
			const m = c.measure;
			const note = c.error ? `failed: ${code(one_line(c.error, 120))}` : c.stable ? '' : 'unstable';
			const real = m?.bytes ? fmt(m.bytes.real) : '';
			const p50 = m?.time ? time_text(m.time.p50_ns) : '';
			const leak = m?.leak
				? m.leak.leaked
					? `⚠️ ${fmt(m.leak.bytes_per_call)} B/call`
					: 'none'
				: '';
			lines.push(
				`| ${code(c.name)} | ${fmt(c.totals.steps)} | ${fmt(c.totals.allocations)} | ${fmt(c.totals.bytes)} | ${real} | ${p50} | ${leak} | ${note} |`
			);
		}
		if (cases.length > CAPS.full_rows)
			lines.push('', `${cases.length - CAPS.full_rows} more cases are in result.json.`);
		lines.push('');
	}
	return lines.join('\n').trimEnd() + '\n';
}
