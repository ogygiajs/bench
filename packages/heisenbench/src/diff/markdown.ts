import type { CaseSummary, DiffResult, Finding, FunctionChange } from './index.ts';
import { growth_label, is_superlinear } from '../growth/fit.ts';
import type { GrowthClass } from '../growth/fit.ts';
import { render_measure } from '../measure/markdown.ts';
import { cell, code } from '../md.ts';
import { odds_text } from '../models/feel.ts';

/** Marker of the Heisenbench section in the shared PR comment (upserted by section). */
export const SECTION_MARKER = '<!-- heisenbench:section -->';

/** Rows per table: a big refactor must not push the comment past GitHub's size limit. */
const MAX_ROWS = 50;

function fmt(n: number): string {
	const r = Math.round(n * 100) / 100;
	return r.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function signed(n: number, unit = ''): string {
	if (n === 0) return '0';
	return (n > 0 ? '+' : '') + fmt(n) + unit;
}

function pct(base: number, delta: number): string {
	if (base === 0) return '';
	const p = (delta / base) * 100;
	return ` (${p > 0 ? '+' : ''}${p.toFixed(1)}%)`;
}

/** Bytes, qualified when the engine elides the allocations behind them (real bytes did not grow). */
function bytes_cell(n: number, elided: boolean): string {
	return elided && n !== 0 ? `${signed(n, ' B')} (elided)` : signed(n, ' B');
}

/** A finding the step table shows: any step change, or an allocation change the engine keeps. */
export function shown(f: Finding): boolean {
	return f.delta.steps !== 0 || !f.elided;
}

/** A "Where" row after its case cell: the same text in two cases is one change, said once. */
function finding_cells(f: Finding): string {
	return `${f.kind} | ${code(`${f.module}:${f.line}`)} | ${signed(f.delta.steps)} | ${signed(f.delta.allocations)} | ${bytes_cell(f.delta.bytes, f.elided === true)} |`;
}

function cases_cell(cases: string[]): string {
	return cases.length === 1 ? cell(cases[0]) : `${cell(cases[0])} and ${cases.length - 1} more`;
}

function change_row(c: FunctionChange, ns?: number): string {
	const base = c.base ? c.base.self_steps : 0;
	const pr = c.pr ? c.pr.self_steps : 0;
	const name = c.renamed_from ? `${c.function} (was ${c.renamed_from})` : c.function;
	const est = ns === undefined ? '' : ` ≈ ${signed(ns, ' ns')}`;
	const elided = c.findings.some((f) => f.elided);
	return `| ${cell(c.case)} | ${code(`${c.module} > ${name}`)} | ${fmt(base)} → ${fmt(pr)} | ${signed(c.delta.self_steps)}${pct(base, c.delta.self_steps)}${est} | ${signed(c.delta.allocations)} | ${bytes_cell(c.delta.bytes, elided)} | ${signed(c.delta.inclusive_steps)} |`;
}

/**
 * Self steps by package for the changed cases that count a dependency: which package the case's
 * work is in, and which package the change is in. Packages that did not change are left out.
 */
function package_table(d: DiffResult, cases: ReadonlySet<string>): string[] {
	const rows = d.packages.filter(
		(p) => cases.has(p.case) && Math.abs(p.pr_steps - p.base_steps) >= 1e-6
	);
	if (rows.length === 0) return [];
	const out = [
		'Self steps by package (`own code` is the project):',
		'',
		'| Case | Package | Self steps | Δ | Share of the case |',
		'| --- | --- | ---: | ---: | ---: |'
	];
	const sorted = [...rows].sort(
		(a, b) => Math.abs(b.pr_steps - b.base_steps) - Math.abs(a.pr_steps - a.base_steps)
	);
	for (const p of sorted.slice(0, MAX_ROWS)) {
		const delta = p.pr_steps - p.base_steps;
		out.push(
			`| ${cell(p.case)} | ${code(p.package)} | ${fmt(p.base_steps)} → ${fmt(p.pr_steps)} | ${signed(delta)}${pct(p.base_steps, delta)} | ${Math.round(p.pr_share * 100)}% |`
		);
	}
	if (sorted.length > MAX_ROWS)
		out.push('', `${sorted.length - MAX_ROWS} more package rows are in the JSON result.`);
	out.push('');
	return out;
}

/** The Heisenbench section of the PR comment. */
export function render_markdown(d: DiffResult): string {
	const lines: string[] = [SECTION_MARKER, '### Heisenbench: steps per function', ''];
	// Elision qualifies bytes only: a function whose steps changed always shows.
	const flagged = d.changes.filter((c) => c.findings.some(shown));
	const ns_of = (c: FunctionChange) => d.measure?.ns[`${c.case} > ${c.module} > ${c.function}`];
	if (d.env && d.env.length > 0) {
		lines.push(
			`> ⚠️ The two reports come from different environments (${d.env.join('; ')}). Steps are compared; engine health is not.`,
			''
		);
	}
	if (!d.prices_match) {
		lines.push('> Prices differ between the two runs: steps are not comparable.', '');
	} else if (d.recounted) {
		lines.push(
			`> The two runs used different prices: both were recounted with prices v${d.recounted.version}.`,
			''
		);
	}
	if (flagged.length === 0) {
		lines.push('No function changed its own steps, allocations or bytes.', '');
		lines.push(...summary_lines(d));
	} else {
		lines.push(
			`**${flagged.length}** function${flagged.length === 1 ? '' : 's'} changed in ${new Set(flagged.map((c) => c.case)).size} case(s). Steps are exact counts, not timings.`,
			'',
			...case_table(d, new Set(flagged.map((c) => c.case))),
			'| Case | Function | Self steps | Δ | Δ allocs | Δ bytes | Δ inclusive |',
			'| --- | --- | ---: | ---: | ---: | ---: | ---: |'
		);
		const sorted = [...flagged].sort(
			(a, b) => Math.abs(b.delta.self_steps) - Math.abs(a.delta.self_steps)
		);
		for (const c of sorted.slice(0, MAX_ROWS)) lines.push(change_row(c, ns_of(c)));
		if (sorted.length > MAX_ROWS)
			lines.push('', `${sorted.length - MAX_ROWS} more changed functions are in the JSON result.`);
		lines.push(
			'',
			'<details><summary>Where</summary>',
			'',
			'| Case | | Line | Δ steps | Δ allocs | Δ bytes |',
			'| --- | --- | --- | ---: | ---: | ---: |'
		);
		// A function changed the same way in many cases gives one set of rows, not one per case.
		const rows = new Map<string, string[]>();
		for (const c of sorted) {
			for (const f of c.findings) {
				if (!shown(f)) continue;
				const key = finding_cells(f);
				const cases = rows.get(key);
				if (!cases) rows.set(key, [c.case]);
				else if (!cases.includes(c.case)) cases.push(c.case);
			}
		}
		const where = [...rows].map(([cells, cases]) => `| ${cases_cell(cases)} | ${cells}`);
		lines.push(...where.slice(0, MAX_ROWS));
		if (where.length > MAX_ROWS)
			lines.push('', `${where.length - MAX_ROWS} more lines are in the JSON result.`);
		lines.push('', '</details>', '');
		lines.push(...package_table(d, new Set(flagged.map((c) => c.case))));
	}
	lines.push(...render_measure(d));
	if (d.unstable.length > 0) {
		lines.push(
			`**Unstable** (counts differ between two identical runs): ${d.unstable.map(code).join(', ')}`,
			''
		);
	}
	if (d.failed.length > 0) lines.push(`**Failed**: ${d.failed.map(code).join(', ')}`, '');
	if (d.renames.length > 0) {
		lines.push(
			`Renamed: ${d.renames.map((r) => `${code(r.from)} → ${code(r.to)}`).join(', ')}`,
			''
		);
	}
	lines.push(...not_run_lines(d));
	if (d.missing.base.length > 0)
		lines.push(`New cases: ${d.missing.base.map(code).join(', ')}`, '');
	if (d.missing.pr.length > 0)
		lines.push(`Removed cases: ${d.missing.pr.map(code).join(', ')}`, '');
	return lines.join('\n');
}

/** Cases the summary and the case table show at most. */
const TOP_CASES = 10;

/**
 * The changed cases as a whole: steps base to PR, and the percent. A function's percent says how
 * much its own steps moved; this says how much more work the case does.
 */
function case_table(d: DiffResult, names: ReadonlySet<string>): string[] {
	const rows = d.cases.filter((c) => names.has(c.name) && c.base_steps !== c.pr_steps);
	if (rows.length === 0) return [];
	const sorted = [...rows].sort(
		(a, b) => Math.abs(b.pr_steps - b.base_steps) - Math.abs(a.pr_steps - a.base_steps)
	);
	const feel = d.feel && Object.keys(d.feel.odds).length > 0 ? d.feel : null;
	const out = feel
		? ['| Case | Steps | Δ | Odds it shows on the clock |', '| --- | ---: | ---: | ---: |']
		: ['| Case | Steps | Δ |', '| --- | ---: | ---: |'];
	for (const c of sorted.slice(0, MAX_ROWS)) {
		const delta = c.pr_steps - c.base_steps;
		const p = feel?.odds[c.name];
		const odds = feel ? ` ${p === undefined ? '' : odds_text(p)} |` : '';
		out.push(
			`| ${cell(c.name)} | ${fmt(c.base_steps)} → ${fmt(c.pr_steps)} | ${signed(delta)}${pct(c.base_steps, delta)} |${odds}`
		);
	}
	if (sorted.length > MAX_ROWS)
		out.push('', `${sorted.length - MAX_ROWS} more changed cases are in the JSON result.`);
	if (feel) out.push('', feel_note(feel));
	out.push('', 'By function:', '');
	return out;
}

/** What the odds column is, in one line: a guess from timed changes, never pass or fail. */
export function feel_note(f: { dataset: number; pairs: number }): string {
	return `<sub>Odds it shows on the clock: how likely the time layer is to see this step change beyond noise, guessed from ${f.pairs.toLocaleString('en-US')} timed changes (dataset v${f.dataset}). They were timed on a busy machine, so the odds lean low. Pass or fail never uses them.</sub>`;
}

function share(n: number): string {
	return `${Math.round(n * 100)}%`;
}

function summary_row(s: CaseSummary): string {
	const fn = s.top_function ? `${code(s.top_function.id)} ${share(s.top_function.share)}` : '';
	const line = s.top_line ? `${code(s.top_line.where)} ${share(s.top_line.share)}` : '';
	const g = s.growth
		? `${growth_label(s.growth.class as GrowthClass, s.growth.power)} (exponent ${s.growth.exponent})`
		: '';
	return `| ${cell(s.name)} | ${fmt(s.steps)} | ${fmt(s.allocations)} | ${fn} | ${line} | ${g} |`;
}

/**
 * When no function changed: the PR's own numbers, so the comment still says how heavy each case
 * is, where its work sits and how it grows. The heaviest cases, every case that grows faster than
 * linear, and every case collapsed.
 */
function summary_lines(d: DiffResult): string[] {
	const all = d.summary ?? [];
	if (all.length === 0) return [];
	const head = [
		'| Case | Steps | Allocations | Most self steps | Heaviest line | Growth |',
		'| --- | ---: | ---: | --- | --- | --- |'
	];
	const out = [
		`The PR's own counts, ${all.length} case${all.length === 1 ? '' : 's'}${all.length > TOP_CASES ? `, the ${TOP_CASES} heaviest` : ''}:`,
		'',
		...head,
		...all.slice(0, TOP_CASES).map(summary_row),
		''
	];
	const fast = all.filter((s) => s.growth && is_superlinear(s.growth.class as GrowthClass));
	if (fast.length > 0) {
		out.push(
			`**Grows faster than linear** (${fast.length}):`,
			'',
			...head,
			...fast.slice(0, MAX_ROWS).map(summary_row),
			''
		);
	}
	if (all.length > TOP_CASES) {
		out.push(
			`<details><summary>Every case (${all.length})</summary>`,
			'',
			...head,
			...all.slice(0, MAX_ROWS * 4).map(summary_row),
			'',
			'</details>',
			''
		);
	}
	return out;
}

/** Bench files that did not load on one side: their cases are not compared. */
function not_run_lines(d: DiffResult): string[] {
	const out: string[] = [];
	for (const [side, list] of [
		['base', d.did_not_run?.base ?? []],
		['PR', d.did_not_run?.pr ?? []]
	] as const) {
		for (const n of list) {
			const cases =
				n.cases.length === 0
					? ''
					: ` (${n.cases.length} case${n.cases.length === 1 ? '' : 's'} not compared)`;
			out.push(`- ${code(n.file)} did not load on the ${side}${cases}: ${code(n.error)}`);
		}
	}
	return out.length === 0 ? [] : ['**Did not run**:', '', ...out, ''];
}
