import { code } from '../md.ts';
import { growth_label } from '../growth/fit.ts';
import { at_scale_words, fmt, traffic_words } from './index.ts';
import type { AtScale, ProveReport } from './index.ts';

/*
 * The report of a proof: the headline (`proven: n^1.98 -> n^1.01, 2.18e9 -> 5.77e7 steps at
 * 100x, identical on 4,519 inputs`), what the inputs were, the growth table, the step totals, the
 * regressions or the minimal differing input, the lines with the most steps on each side, and the
 * diff ready to apply.
 */

function pct(a: number, b: number): string {
	if (!(a > 0)) return '';
	const d = (b - a) / a;
	return ` (${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}%)`;
}

function bytes(n: number): string {
	return `${fmt(n)} B`;
}

/** `PROVEN  `, `AT SCALE`, `REJECTED`: the first word of a printed line. */
const LABEL: Record<ProveReport['verdict']['kind'], string> = {
	proven: 'PROVEN  ',
	'proven at scale': 'AT SCALE',
	rejected: 'REJECTED',
	'not proven': 'REJECTED'
};

/** The sentence under a "proven at scale": where it costs more, and from where on it is cheaper. */
function at_scale_sentence(s: AtScale): string {
	const w = s.worst;
	return `${at_scale_words(s).replace(/^costs/, 'It costs')}; the most on ${w.label} (size ${fmt(w.size)})${s.within_setup_tolerance ? ', within --setup-tolerance' : ''}`;
}

/** The markdown section of one proof. */
export function render_prove(r: ProveReport): string {
	const v = r.verdict;
	const out: string[] = [];
	out.push(`#### Proof: ${code(r.function)}`, '');
	out.push(`**${r.headline}**`, '');
	out.push(
		`Candidate: ${code(r.candidate)}${r.replaced.length ? `; replaces ${r.replaced.map(code).join(', ')}` : ''}${r.added.length ? `; adds ${r.added.map(code).join(', ')}` : ''}.`,
		''
	);
	const k = v.inputs.by_kind;
	out.push(
		`Behavior: ${v.inputs.total.toLocaleString('en-US')} inputs (${k.recorded} recorded, ${k.grown} grown, ${k.edge.toLocaleString('en-US')} edge cases): ${v.inputs.same.toLocaleString('en-US')} the same, ${v.inputs.differing} different, ${v.inputs.undecided} past the step cap. Compared: the result or the error, and the arguments and \`this\` after the call.`,
		''
	);
	if (v.minimal) {
		out.push(
			`The smallest input they differ on (shrunk from size ${v.minimal.from_size} to ${v.minimal.size}, from ${v.minimal.label}):`,
			''
		);
		out.push('```js', v.minimal.input, '```', '');
		out.push(`Difference: ${code(v.minimal.difference)}`, '');
	}
	const g = v.growth;
	if (g) {
		const cls = (c: typeof g.original | null) =>
			c && c.class !== null
				? `${growth_label(c.class, c.power)}, n^${c.exponent.toFixed(2)}`
				: 'not counted';
		out.push(
			`Growth of argument ${g.argument} (${g.kind}): ${cls(g.original)} -> ${cls(g.candidate)}${g.original.capped_at !== null ? ` (the original exceeded the cap at ${g.original.capped_at}x)` : ''}`,
			''
		);
		out.push(
			'| Size | Input | Steps | Allocations | Bytes |',
			'| ---: | ---: | ---: | ---: | ---: |'
		);
		for (const row of g.rows) {
			const o = row.original;
			const c = row.candidate;
			out.push(
				`| ${row.k}x | ${fmt(row.size)} | ${o ? fmt(o.steps) : '-'} -> ${c ? fmt(c.steps) : '-'}${o && c ? pct(o.steps, c.steps) : ''} | ${o ? fmt(o.allocations) : '-'} -> ${c ? fmt(c.allocations) : '-'} | ${o ? bytes(o.bytes) : '-'} -> ${c ? bytes(c.bytes) : '-'} |`
			);
		}
		out.push('');
	}
	const s = v.steps;
	out.push(
		`Steps over the recorded and grown inputs both sides counted: ${fmt(s.original.steps)} -> ${fmt(s.candidate.steps)}${pct(s.original.steps, s.candidate.steps)}; allocations ${fmt(s.original.allocations)} -> ${fmt(s.candidate.allocations)}; bytes ${bytes(s.original.bytes)} -> ${bytes(s.candidate.bytes)}. Cheaper on ${s.improved.toLocaleString('en-US')} inputs; costlier than the tolerance on ${s.regressed} recorded or grown and ${s.edge_regressions} edge-case inputs (edge cases test behavior, their steps do not decide).`,
		''
	);
	if (s.at_scale) out.push(`${at_scale_sentence(s.at_scale)}.`, '');
	if (v.traffic) {
		out.push(`${traffic_words(v.traffic).replace(/^app/, 'App')}.`, '');
		if (v.traffic.units.length > 0) {
			out.push(
				'| App scenario | Calls | Steps a call | Input size |',
				'| --- | ---: | ---: | ---: |'
			);
			for (const u of v.traffic.units)
				out.push(`| ${u.unit} | ${fmt(u.calls)} | ${fmt(u.steps_per_call)} | ~${fmt(u.size)} |`);
			out.push('');
		}
	}
	if (r.child.recorded_curve) {
		const rc = r.child.recorded_curve;
		out.push(
			`Over the recorded sizes (${fmt(rc.sizes[0])}..${fmt(rc.sizes[1])}): n^${rc.original.power.toFixed(2)} (r² ${rc.original.r2})${rc.candidate ? ` -> n^${rc.candidate.power.toFixed(2)} (r² ${rc.candidate.r2})` : ''}.`,
			''
		);
	}
	if (s.regressions.length > 0) {
		out.push('| Costlier input | Size | Steps |', '| --- | ---: | ---: |');
		for (const x of s.regressions)
			out.push(
				`| ${x.label} | ${fmt(x.size)} | ${fmt(x.original)} -> ${x.candidate === null ? 'past its cap' : `${fmt(x.candidate)}${pct(x.original, x.candidate)}`} |`
			);
		out.push('');
	}
	const b = r.child.blame;
	if (b.original.length > 0) {
		out.push(
			`<details><summary>Where the steps are at the largest input (size ${fmt(b.size)})</summary>`,
			''
		);
		out.push('| Side | Line | Steps | Share |', '| --- | --- | ---: | ---: |');
		for (const l of b.original)
			out.push(`| original | ${code(l.at)} | ${fmt(l.steps)} | ${Math.round(l.share * 100)}% |`);
		for (const l of b.candidate)
			out.push(`| candidate | ${code(l.at)} | ${fmt(l.steps)} | ${Math.round(l.share * 100)}% |`);
		out.push('', '</details>', '');
	}
	if (r.diff) {
		out.push(`<details><summary>The patch (${v.kind}; \`git apply\` it)</summary>`, '');
		out.push('```diff', r.diff.trimEnd(), '```', '', '</details>', '');
	}
	for (const n of r.child.notes ?? []) out.push(`Note: ${n}`, '');
	for (const e of r.child.errors) out.push(`Error: ${e}`, '');
	return out.join('\n');
}

/** The lines `heisenbench prove` prints. */
export function prove_lines(r: ProveReport): string {
	const v = r.verdict;
	const lines = [`${LABEL[v.kind]} ${r.function}  ${r.headline}`];
	if (v.kind === 'rejected' || v.kind === 'not proven') lines.push(`           ${v.reason}`);
	if (v.minimal) {
		lines.push(`           differs on: ${v.minimal.input.split('\n').join(' ').slice(0, 300)}`);
		lines.push(`           ${v.minimal.difference}`);
	}
	// a "proven at scale" says where it costs more in its headline; a rejection lists the inputs
	for (const x of v.steps.at_scale ? [] : v.steps.regressions.slice(0, 3))
		lines.push(
			`           costlier on ${x.label} (size ${fmt(x.size)}): ${fmt(x.original)} -> ${x.candidate === null ? 'past its cap' : fmt(x.candidate)} steps`
		);
	const g = v.growth;
	if (g)
		for (const row of g.rows)
			lines.push(
				`           ${String(row.k).padStart(4)}x  size ${fmt(row.size).padStart(10)}  ${row.original ? fmt(row.original.steps) : '-'} -> ${row.candidate ? fmt(row.candidate.steps) : '-'} steps`
			);
	for (const n of r.child.notes ?? []) lines.push(`           note: ${n}`);
	return lines.join('\n');
}
