import { code } from '../md.ts';
import { fmt_ns } from '../measure/time.ts';
import { range_text } from '../ranges/text.ts';
import { fmt_factor } from './fit.ts';
import type { AuditReport } from './fit.ts';

/** How many cases one finding lists; the rest are counted. */
const CASES_SHOWN = 5;

/**
 * The "Prices" part of a comment: one bullet per suspect price, with the cases that point at it.
 * `quiet`: nothing at all when no price is suspect (the PR comment shows it only then).
 */
export function render_audit(r: AuditReport, o: { quiet?: boolean } = {}): string {
	if (r.findings.length === 0) {
		if (o.quiet) return '';
		return `#### Prices\n\nNo price suspect: steps follow time on all ${r.cases.length} audited case(s) (${r.sizes.join(', ')}x, ${r.rounds} rounds).\n`;
	}
	const lines: string[] = [
		'#### Prices',
		'',
		`Steps and time disagree on how these prices grow (${r.cases.length} case(s) audited at ${r.sizes.join(', ')}x, ${r.rounds} rounds each). The counts are exact; the price they use may not be.`,
		''
	];
	for (const f of r.findings) {
		const what = f.term
			? `its price leaves out a cost per ${f.term}`
			: f.direction === 'over'
				? 'it charges work the engine does not do'
				: 'it misses work the engine does';
		lines.push(
			`- **price suspect: ${code(f.kind)}**: ${what}; time matches at ${fmt_factor(f.factor)} its steps`
		);
		for (const c of f.cases.slice(0, CASES_SHOWN)) {
			// what the counts say the largest size takes, next to what it took (extra text only)
			const at =
				c.model && c.ns !== undefined
					? `; at ${r.sizes[r.sizes.length - 1]}x it took ${fmt_ns(c.ns)} (model ${range_text(c.model)})`
					: '';
			lines.push(
				`  - ${code(c.name)}: its ${f.term ?? 'steps'} grow${f.term ? 's' : ''} ${c.kind_class ?? '?'} (exponent ${c.kind_exponent.toFixed(2)}), the case's time ${c.time_class ?? '?'} (${c.time_exponent.toFixed(2)})${at}`
			);
		}
		if (f.cases.length > CASES_SHOWN) lines.push(`  - and ${f.cases.length - CASES_SHOWN} more`);
		if (f.lines && f.lines.length > 0)
			lines.push(`  - most of it at ${f.lines.map(code).join(', ')}`);
	}
	lines.push('');
	return lines.join('\n');
}
