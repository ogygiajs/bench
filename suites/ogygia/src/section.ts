/**
 * The `abax` section of the PR's benchmark comment, and the JSON result kept on the results branch.
 */
import { SECTION_MARKER, renderMarkdown, renderSections } from '@bench/abax';
import type { DiffResult, Report, TimeComparison } from '@bench/abax';
import type { LoadError } from './run.ts';
import type { Selection } from './select.ts';

export const RESULT_SCHEMA = 'ogygia-abax/1';
export const HEADING = '#### Abax: steps per function';

type SectionsDiff = Parameters<typeof renderSections>[0];

export interface Meta {
	/** `pr`: a PR against its base; `main`: a full run of one commit. */
	kind: 'pr' | 'main' | 'manual';
	pr: number | null;
	sha: string;
	/** The base the PR was opened against (as the dispatch sent it). */
	base: string | null;
	/** What the PR is measured against: the merge base of the PR and its base. */
	merge_base: string | null;
	/** The bench repository commit (the Abax that counted). */
	abax: string | null;
	node: string;
	run_url: string | null;
	/** The plain-build layers each `abax run` added (`time,bytes,leaks`), or null. */
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
}

function code(s: string): string {
	return '`' + s.split('`').join("'") + '`';
}

function short(sha: string | null): string {
	return sha ? code(sha.slice(0, 7)) : '?';
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function run_link(meta: Meta): string {
	return meta.run_url ? ` [Abax run](${meta.run_url})` : '';
}

/** Abax's own step table, without its marker and heading (the section has its own). */
function step_body(diff: DiffResult): string {
	const lines = renderMarkdown(diff).split('\n');
	if (lines[0] === SECTION_MARKER) lines.shift();
	if (lines[0]?.startsWith('#')) lines.shift();
	while (lines[0] === '') lines.shift();
	return lines.join('\n');
}

function load_error_lines(side: string, errors: LoadError[]): string[] {
	return errors.map((e) => {
		const first = e.error.split('\n').find((l) => l.trim() !== '') ?? '';
		return `- ${side}: ${code(e.file)} (${e.command}): ${code(first.trim().slice(0, 200))}`;
	});
}

function selection_lines(sel: Selection): string[] {
	if (sel.selected.length === 0) return [];
	const lines = ['<details><summary>Bench files run</summary>', ''];
	for (const f of sel.selected) {
		const hits = sel.reach[f];
		if (!hits || hits.length === 0) {
			lines.push(`- ${code(f)}`);
			continue;
		}
		const shown = hits.slice(0, 4).map(code).join(', ');
		const more = hits.length > 4 ? ` and ${hits.length - 4} more` : '';
		lines.push(`- ${code(f)}, reaching ${shown}${more}`);
	}
	lines.push('', '</details>', '');
	return lines;
}

/** The PR comment's `abax` section. */
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
			? `all ${plural(sel.all.length, 'bench file')} ran (${sel.reason})`
			: `${sel.selected.length} of ${plural(sel.all.length, 'bench file')} reach the files this PR changes`;
	lines.push(
		`${against}: ${why}. Steps are exact counts, not timings: one run of each side decides.${run_link(meta)}`,
		''
	);
	lines.push(...selection_lines(sel));
	const errors = [
		...load_error_lines('PR', r.load_errors.head),
		...load_error_lines('base', r.load_errors.base)
	];
	if (errors.length > 0) lines.push('**Did not run**:', '', ...errors, '');
	if (r.base && r.base.cases.length === 0 && r.head && r.head.cases.length > 0) {
		lines.push(
			'The base has none of these cases yet, so there is nothing to compare them with.',
			''
		);
	}
	if (r.diff) {
		lines.push(step_body(r.diff));
		const extra = renderSections(r.diff);
		if (extra) lines.push('', extra);
	}
	if (r.time?.error) {
		const first = r.time.error.split('\n').find((l) => l.trim() !== '') ?? '';
		lines.push('', `**Time layer failed**: ${code(first.trim().slice(0, 200))}`);
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
	const errors = load_error_lines('head', r.load_errors.head);
	if (errors.length > 0) lines.push('**Did not run**:', '', ...errors, '');
	if (cases.length > 0) {
		lines.push(
			'| Case | Steps | Allocations | Bytes (est.) | Bytes (real) | p50 | Leak | |',
			'| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |'
		);
		for (const c of cases) {
			const m = c.measure;
			const note = c.error ? `failed: ${code(c.error.slice(0, 120))}` : c.stable ? '' : 'unstable';
			const real = m?.bytes ? fmt(m.bytes.real) : '';
			const p50 = m?.time ? `${fmt(m.time.p50_ns)} ns` : '';
			const leak = m?.leak
				? m.leak.leaked
					? `⚠️ ${fmt(m.leak.bytes_per_call)} B/call`
					: 'none'
				: '';
			lines.push(
				`| ${code(c.name)} | ${fmt(c.totals.steps)} | ${fmt(c.totals.allocations)} | ${fmt(c.totals.bytes)} | ${real} | ${p50} | ${leak} | ${note} |`
			);
		}
		lines.push('');
	}
	return lines.join('\n').trimEnd() + '\n';
}
