// The scenario tables of results/*.md: one summary table per scenario (headline metrics, every
// framework), then every metric in a details block.
import { HEADLINE, METRICS, labelOf, metricOf } from './metrics.ts';

function table(scenario, keys) {
	const fws = scenario.frameworks;
	const head = ['Metric', ...fws.map((f) => `**${f.id}**`)];
	const lines = [
		`| ${head.join(' | ')} |`,
		`|${head.map((_, i) => (i ? '---:' : '---')).join('|')}|`
	];
	for (const key of keys) {
		const def = metricOf(key);
		const cells = fws.map((f) => (f.metrics[key] == null ? 'n/a' : def.fmt(f.metrics[key])));
		if (cells.every((c) => c === 'n/a')) continue;
		lines.push(`| ${labelOf(key)} | ${cells.join(' | ')} |`);
	}
	return lines.join('\n');
}

export function scenarioMarkdown(scenarios, passes) {
	const out = [];
	for (const [name, s] of Object.entries(scenarios)) {
		out.push(`## Scenario: ${name}`, '', s.title ? `${s.title}.` : '', '');
		if (s.error) {
			out.push(`> ⚠️ ${s.error}`, '');
			if (!s.frameworks?.length) continue;
		}
		if (!s.frameworks?.length) {
			out.push('No app was measured.', '');
			continue;
		}
		const all = [...new Set(s.frameworks.flatMap((f) => Object.keys(f.metrics)))].filter((k) =>
			metricOf(k)
		);
		const order = (k) =>
			Object.keys(METRICS).indexOf(k.split(':')[0]) * 100 + (k.includes(':') ? 1 : 0);
		all.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
		out.push(
			table(
				s,
				HEADLINE.filter((k) => all.includes(k))
			),
			''
		);
		out.push('<details><summary>Every metric</summary>', '', table(s, all), '', '</details>', '');
		const errs = s.frameworks.filter((f) => f.errors?.length);
		for (const f of errs) out.push(`- ⚠️ ${f.id}: ${f.errors.join('; ')}`);
		if (errs.length) out.push('');
		out.push(
			`_Served: ${s.frameworks.map((f) => `${f.id} ${f.served}`).join(', ')}. Medians of ${passes} pass${passes === 1 ? '' : 'es'}._`,
			''
		);
	}
	return out.join('\n');
}
