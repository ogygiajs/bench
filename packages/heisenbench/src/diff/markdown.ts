import type { DiffResult, Finding, FunctionChange } from './index.ts';
import { render_measure } from '../measure/markdown.ts';
import { cell, code } from '../md.ts';

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
	} else {
		lines.push(
			`**${flagged.length}** function${flagged.length === 1 ? '' : 's'} changed in ${new Set(flagged.map((c) => c.case)).size} case(s). Steps are exact counts, not timings.`,
			'',
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
	if (d.missing.base.length > 0)
		lines.push(`New cases: ${d.missing.base.map(code).join(', ')}`, '');
	if (d.missing.pr.length > 0)
		lines.push(`Removed cases: ${d.missing.pr.map(code).join(', ')}`, '');
	return lines.join('\n');
}
