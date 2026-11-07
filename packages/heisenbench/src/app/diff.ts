import type { DiffResult, Finding } from '../diff/index.ts';
import type { AppCaseReport, AppReport } from './types.ts';
import { is_app_case } from './types.ts';
import { format_ns, format_steps } from '../weight/rank.ts';

/*
 * The app-level summary of a PR vs base comparison of two app reports (spec 8 + 11): per phase,
 * the steps of one unit on each side and the line that moved them most.
 *
 *   dashboard server request (GET /): 1.83M → 1.91M steps (+4.3%), mostly `router/match.js:88`
 */

export const APP_SECTION_MARKER = '<!-- heisenbench:apps -->';

interface Row {
	name: string;
	line: string;
	delta: number;
}

/** The line that moved the phase most in the direction it moved (a +1K line in a phase that got
 * 5K cheaper overall does not explain it). */
function top_finding(findings: Finding[], case_name: string, direction: number): Finding | null {
	let best: Finding | null = null;
	for (const f of findings) {
		if (f.case !== case_name || Math.sign(f.delta.steps) !== Math.sign(direction)) continue;
		if (!best || Math.abs(f.delta.steps) > Math.abs(best.delta.steps)) best = f;
	}
	return best;
}

function per_unit(c: AppCaseReport): number {
	return c.totals.steps / Math.max(1, c.app.units);
}

function ns_per_unit(c: AppCaseReport): number | null {
	const ns = c.measure?.estimate?.ns;
	return typeof ns === 'number' ? ns / Math.max(1, c.app.units) : null;
}

export function app_lines(d: DiffResult, base: AppReport, pr: AppReport): Row[] {
	const base_cases = new Map(base.cases.filter(is_app_case).map((c) => [c.name, c]));
	const rows: Row[] = [];
	for (const pc of pr.cases) {
		if (!is_app_case(pc)) continue;
		const bc = base_cases.get(pc.name);
		if (!bc || bc.error || pc.error) continue;
		const b = per_unit(bc);
		const p = per_unit(pc);
		const delta = p - b;
		const unit = `${pc.app.scenario} ${pc.app.side === 'server' ? `server ${pc.app.unit}` : pc.app.unit}`;
		const head = `${unit} (${pc.app.label}): ${format_steps(b)} → ${format_steps(p)} steps`;
		if (Math.abs(delta) < 1e-6) {
			rows.push({ name: pc.name, line: `${head}, unchanged`, delta: 0 });
			continue;
		}
		const pct = b > 0 ? ` (${delta > 0 ? '+' : ''}${((delta / b) * 100).toFixed(1)}%)` : '';
		const nb = ns_per_unit(bc);
		const np = ns_per_unit(pc);
		const ns =
			nb !== null && np !== null ? `, ≈ ${format_ns(np - nb, true)} per ${pc.app.unit}` : '';
		const top = top_finding(d.findings, pc.name, delta);
		const where = top
			? `, mostly \`${top.module}:${top.line}\` (${top.delta.steps > 0 ? '+' : ''}${format_steps(top.delta.steps / Math.max(1, pc.app.units))})`
			: '';
		rows.push({ name: pc.name, line: `${head}${pct}${ns}${where}`, delta });
	}
	return rows;
}

/** Markdown: changed phases first (largest change first), then the unchanged ones folded. */
export function render_app_diff(d: DiffResult, base: AppReport, pr: AppReport): string {
	const rows = app_lines(d, base, pr);
	const changed = rows
		.filter((r) => r.delta !== 0)
		.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
	const same = rows.filter((r) => r.delta === 0);
	const out = [APP_SECTION_MARKER, '### Heisenbench: real apps', ''];
	if (changed.length === 0) out.push('No scenario phase changed its steps.', '');
	for (const r of changed) out.push(`- ${r.line}`);
	if (changed.length > 0) out.push('');
	if (same.length > 0) {
		out.push(`<details><summary>${same.length} unchanged</summary>`, '');
		for (const r of same) out.push(`- ${r.line}`);
		out.push('', '</details>', '');
	}
	const unstable = [...base.cases, ...pr.cases].filter((c) => is_app_case(c) && !c.stable);
	if (unstable.length > 0) {
		out.push(
			`**Unstable** (two identical runs counted differently): ${[...new Set(unstable.map((c) => '`' + c.name + '`'))].join(', ')}`,
			''
		);
	}
	return out.join('\n');
}
