import type { DiffResult, Finding, FunctionChange } from './index.ts';
import { render_measure } from '../measure/markdown.ts';

/** Marker of the Abax section in the shared PR comment (upserted by section). */
export const SECTION_MARKER = '<!-- abax:section -->';

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

function code(s: string): string {
	return '`' + s.split('`').join("'") + '`';
}

function finding_row(f: Finding): string {
	return `| ${f.kind} | ${code(`${f.module}:${f.line}`)} | ${signed(f.delta.steps)} | ${signed(f.delta.allocations)} | ${signed(f.delta.bytes, ' B')} |`;
}

function change_row(c: FunctionChange, ns?: number): string {
	const base = c.base ? c.base.self_steps : 0;
	const pr = c.pr ? c.pr.self_steps : 0;
	const name = c.renamed_from ? `${c.function} (was ${c.renamed_from})` : c.function;
	const est = ns === undefined ? '' : ` ≈ ${signed(ns, ' ns')}`;
	return `| ${c.case} | ${code(`${c.module} > ${name}`)} | ${fmt(base)} → ${fmt(pr)} | ${signed(c.delta.self_steps)}${pct(base, c.delta.self_steps)}${est} | ${signed(c.delta.allocations)} | ${signed(c.delta.bytes, ' B')} | ${signed(c.delta.inclusive_steps)} |`;
}

/** The Abax section of the PR comment. */
export function render_markdown(d: DiffResult): string {
	const lines: string[] = [SECTION_MARKER, '### Abax: steps per function', ''];
	// Findings whose added allocations the engine elides are listed apart (render_measure).
	const flagged = d.changes.filter((c) => c.findings.some((f) => !f.elided));
	const ns_of = (c: FunctionChange) => d.measure?.ns[`${c.case} > ${c.module} > ${c.function}`];
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
		for (const c of sorted) lines.push(change_row(c, ns_of(c)));
		lines.push(
			'',
			'<details><summary>Where</summary>',
			'',
			'| | Line | Δ steps | Δ allocs | Δ bytes |',
			'| --- | --- | ---: | ---: | ---: |'
		);
		for (const c of sorted) for (const f of c.findings) if (!f.elided) lines.push(finding_row(f));
		lines.push('', '</details>', '');
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
