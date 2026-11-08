import { cell, code } from '../md.ts';
import type { MutationReport, Score } from './index.ts';
import { OPERATOR_WORDS } from './operators.ts';
import type { Operator } from './operators.ts';

/** Missed functions listed with their suggestion. */
const MAX_MISSED = 10;
/** Missed functions listed in all (the rest are in the JSON). */
const MAX_LISTED = 30;

const SHORT: Record<Operator, string> = {
	double: '2x',
	quadratic: 'quadratic',
	alloc: 'alloc',
	cache: 'cache'
};

function pct(x: number | null): string {
	return x === null ? 'n/a' : `${Math.round(x * 100)}%`;
}

/** `**7%** · 94%`: of every function, then of the functions a case runs; `≈` for a sample's estimate. */
function score_cell(s: Score): string {
	if (s.mutants === 0) return '';
	if (s.score === null) return 'n/a';
	const run = s.run_score === null ? '' : ` · ${pct(s.run_score)}`;
	return `${s.estimated ? '≈ ' : ''}**${pct(s.score)}**${run}`;
}

function seconds(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s} s`;
	return s % 60 === 0 ? `${s / 60} min` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

function and_list(parts: string[]): string {
	return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/**
 * The headline: `Benchmarks catch 7% of 2x slowdowns and 0% of linear-to-quadratic ones; in the
 * functions a case runs, 94% and 20%.`
 */
export function mutation_headline(r: MutationReport): string {
	const ops = r.operators.filter((op) => r.totals[op] && r.totals[op].mutants > 0);
	if (ops.length === 0) return 'No function took a mutant.';
	const about = ops.some((op) => r.totals[op].estimated) ? 'about ' : '';
	const all = and_list(ops.map((op) => `${pct(r.totals[op].score)} of ${OPERATOR_WORDS[op]}`));
	const run = ops.filter((op) => r.totals[op].run_score !== null);
	const where =
		run.length > 0
			? `; in the functions a case runs, ${and_list(run.map((op) => `${pct(r.totals[op].run_score)} of ${OPERATOR_WORDS[op]}`))}`
			: '';
	return `Benchmarks catch ${about}${all}${where}.`;
}

export function render_mutation(r: MutationReport): string {
	const lines: string[] = ['#### Mutation score: what the benchmarks would miss', ''];
	const sampled =
		r.sample.mode === 'all'
			? `every one of the ${r.sample.reached} functions a case runs was mutated`
			: `${r.sample.evaluated} of the ${r.sample.reached} functions a case runs were mutated (a sample stratified by package, seed ${r.seed}; ≈ marks an estimate)`;
	lines.push(
		`${mutation_headline(r)} ${r.sample.functions} functions; ${sampled}; the ${r.sample.functions - r.sample.reached} no case runs miss every mutant.`,
		'',
		'Caught: the step table of a PR comment would show it (exact counts, so any change shows); a quadratic mutant is caught only when growth flags it (a case with `scale` whose class changes or whose added steps grow quadratically, or growth from recorded calls).',
		''
	);
	const ops = r.operators;
	const loud = ops
		.filter((op) => op !== 'quadratic' && r.totals[op].caught > 0)
		.map((op) => `${r.totals[op].loud} of the ${r.totals[op].caught} caught ${OPERATOR_WORDS[op]}`);
	if (loud.length > 0)
		lines.push(
			`Loud (a case grew by 1% and 1,000 steps or more, so the comment says which change made it slower): ${loud.join(', ')}.`,
			''
		);
	lines.push(
		"Each cell: caught of every function's mutants · of the mutants in functions a case runs.",
		'',
		`| Package | Functions | Run by a case | ${ops.map((op) => SHORT[op]).join(' | ')} |`,
		`| --- | ---: | ---: | ${ops.map(() => '---:').join(' | ')} |`
	);
	for (const p of r.packages) {
		lines.push(
			`| ${code(p.package)} | ${p.functions} | ${p.reached} | ${ops.map((op) => score_cell(p.scores[op])).join(' | ')} |`
		);
	}
	const fns = r.packages.reduce((s, p) => s + p.functions, 0);
	const reached = r.packages.reduce((s, p) => s + p.reached, 0);
	lines.push(
		`| all | ${fns} | ${reached} | ${ops.map((op) => score_cell(r.totals[op])).join(' | ')} |`,
		''
	);
	const discarded = ops.reduce((s, op) => s + r.totals[op].discarded, 0);
	const invalid = ops.reduce((s, op) => s + r.totals[op].invalid, 0);
	if (discarded + invalid > 0)
		lines.push(
			`${discarded} mutant(s) changed what the function returns or throws on the bench's inputs and were discarded${invalid ? `; ${invalid} did not load and are left out` : ''}.`,
			''
		);

	if (r.missed.length > 0) {
		const by =
			r.basis === 'real traffic'
				? 'by what doubling them would cost the imported traffic'
				: r.basis === 'app weights'
					? 'by their steps in the app scenarios'
					: 'by their steps in the bench cases';
		lines.push(`**Missed**, ${by}:`, '');
		for (const [i, m] of r.missed.slice(0, MAX_MISSED).entries()) {
			lines.push(
				`${i + 1}. ${code(m.id)} (${m.operators.map((op) => SHORT[op]).join(', ')}; ${cell(m.weight.text)})`
			);
			if (m.suggestion) {
				lines.push(
					'',
					'<details><summary>a case that would catch it</summary>',
					'',
					m.suggestion,
					'',
					'</details>',
					''
				);
			}
		}
		const rest = r.missed.slice(MAX_MISSED, MAX_LISTED);
		if (rest.length > 0) {
			lines.push('', '<details><summary>more missed functions</summary>', '');
			for (const m of rest)
				lines.push(
					`- ${code(m.id)} (${m.operators.map((op) => SHORT[op]).join(', ')}; ${cell(m.weight.text)})`
				);
			if (r.missed.length > MAX_LISTED)
				lines.push(`- and ${r.missed.length - MAX_LISTED} more in the JSON`);
			lines.push('', '</details>');
		}
		lines.push('');
	}
	if (r.exhausted)
		lines.push(
			'The recount budget ran out: some sampled functions were not mutated (listed as skipped in the JSON).',
			''
		);
	lines.push(
		`Cost: ${r.cost.recounts} recount(s) (${r.cost.growth} of them growth), ${r.cost.reused + r.cost.cached} tree(s) reused (${r.cost.cached} from an earlier run), ${seconds(r.cost.ms)}.`
	);
	return lines.join('\n') + '\n';
}
