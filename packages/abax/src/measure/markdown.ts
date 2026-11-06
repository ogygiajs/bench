import { markOf, range } from '@bench/compare';
import type { DiffResult } from '../diff/index.ts';
import type { TimeComparison, TimeMetric } from './time.ts';
import { fmt_ns } from './time.ts';
import { code } from '../md.ts';

/** Leaks, elided allocations and time-led cases, under the step table. */
export function render_measure(d: DiffResult): string[] {
	const m = d.measure;
	if (!m) return [];
	const lines: string[] = [];
	const fresh = m.leaks.filter((l) => !l.base_leaked);
	if (fresh.length > 0) {
		lines.push('**Leaks** (retained heap grows with every call):', '');
		for (const l of fresh) {
			const r = l.pr.retained;
			const where = l.pr.source
				? ` held by ${code(l.pr.source.variable)} (${code(`${l.pr.source.module}:${l.pr.source.line}`)}, kept growing by ${code(l.pr.source.function)})`
				: '';
			lines.push(
				`- ${code(l.case)}: ${l.pr.bytes_per_call} B per call${r ? `, ${r.per_call} ${r.type} per call` : ''}${where}`
			);
		}
		lines.push('');
	}
	const elided = d.findings.filter((f) => f.elided);
	if (elided.length > 0) {
		lines.push(
			`Allocations the engine elides (estimated, not real bytes; not counted as a regression): ${elided
				.map((f) => code(`${f.module}:${f.line}`))
				.join(', ')}`,
			''
		);
	}
	if (m.time_led.length > 0) {
		lines.push(
			`Time-led (steps do not predict time well here; trust the time layer): ${m.time_led.map(code).join(', ')}`,
			''
		);
	}
	return lines;
}

const LABEL: Record<TimeMetric, string> = {
	p50_ns: 'p50',
	p99_ns: 'p99',
	throughput: 'ops/s',
	cpu_ns: 'CPU/op'
};

function fmt_metric(m: TimeMetric, v: number): string {
	return m === 'throughput' ? `${Math.round(v).toLocaleString('en-US')}/s` : fmt_ns(v);
}

/** The time layer's PR vs base table (same job, interleaved, no-overlap rule). */
export function render_time(t: TimeComparison): string {
	const lines: string[] = ['#### Time (plain build, PR and base taking turns)', ''];
	if (t.cases.length === 0) {
		lines.push('No case timed.', '');
		return lines.join('\n');
	}
	const metrics: TimeMetric[] = ['p50_ns', 'p99_ns', 'throughput', 'cpu_ns'];
	lines.push(
		`| Case | ${metrics.map((m) => LABEL[m]).join(' | ')} |`,
		`| --- | ${metrics.map(() => '---').join(' | ')} |`
	);
	for (const c of t.cases) {
		const cells = metrics.map((m) => {
			const v = c.verdicts[m];
			const f = (n: number) => fmt_metric(m, n);
			const samples = (xs: number[] | undefined) => (xs && xs.length > 0 ? range(xs, f) : '');
			return `${markOf(v)} ${samples(v.baseSamples)} → ${samples(v.prSamples)}`;
		});
		lines.push(`| ${code(c.name)} | ${cells.join(' | ')} |`);
	}
	lines.push(
		'',
		`${t.repeats} turns each, the side going first alternating. ⚠️ worse beyond noise, better: better beyond noise, ≈ within noise.`,
		''
	);
	if (t.errors.length > 0)
		lines.push(`**Failed**: ${t.errors.map((e) => `${code(e.name)} (${e.side})`).join(', ')}`, '');
	return lines.join('\n');
}
