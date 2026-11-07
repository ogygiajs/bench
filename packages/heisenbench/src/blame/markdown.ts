import { cell, code } from '../md.ts';
import { calls_text, cost_text } from '../weight/cost.ts';
import type { BlameResult, BlameUnit, CaseBlame } from './index.ts';

/** Causes shown; the rest are in the JSON. */
const MAX_GROUPS = 5;
/** Lines of one hunk's diff shown. */
const MAX_DIFF_LINES = 60;

/** A diff block whose fence no line of the diff can close. */
function fenced(text: string): string[] {
	let lines = text.split('\n');
	if (lines.length > MAX_DIFF_LINES) {
		lines = [...lines.slice(0, MAX_DIFF_LINES), `… ${lines.length - MAX_DIFF_LINES} more lines`];
	}
	const runs = text.match(/`+/g) ?? [];
	const fence = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
	return [`${fence}diff`, ...lines, fence];
}

function steps(n: number): string {
	const a = Math.abs(n);
	const sign = n < 0 ? '−' : '+';
	if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)}M`;
	if (a >= 1e4) return `${sign}${(a / 1e3).toFixed(1)}K`;
	return `${sign}${Math.round(a)}`;
}

function pct(part: number, whole: number): string {
	if (whole === 0) return '';
	const p = (part / whole) * 100;
	return `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(1)}%`;
}

function share(x: number | null): string {
	return x === null ? '?' : `${Math.round(x * 100)}%`;
}

function seconds(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s} s`;
	return s % 60 === 0 ? `${s / 60} min` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** `packages/x.ts` L10–14 */
export function unit_label(u: BlameUnit): string {
	const [a, b] = u.lines;
	const where =
		u.kind === 'edit'
			? a === b
				? ` L${a}`
				: ` L${a}–${b}`
			: ` (${u.kind === 'add' ? 'new file' : u.kind === 'delete' ? 'deleted' : u.kind === 'rename' ? 'renamed' : 'binary'})`;
	return `${code(u.file)}${where}`;
}

function list(labels: string[]): string {
	if (labels.length <= 1) return labels.join('');
	return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

/** Hunks named once per file: `a.ts` L3 and L9, `b.ts` L1 (each with `extra(id)` after it). */
function units_list(
	ids: number[],
	units: Map<number, BlameUnit>,
	extra?: (id: number) => string
): string {
	const by_file = new Map<string, string[]>();
	for (const id of ids) {
		const u = units.get(id)!;
		const lines = unit_label(u).slice(code(u.file).length).trim();
		const list_of = by_file.get(u.file) ?? [];
		list_of.push(lines + (extra ? extra(id) : ''));
		by_file.set(u.file, list_of);
	}
	return list([...by_file].map(([file, ls]) => `${code(file)} ${list(ls)}`));
}

function cases_text(cs: CaseBlame[]): string {
	const first = cs[0];
	const growth = first.anchors.base ? pct(first.extra, first.anchors.base) : steps(first.extra);
	const more =
		cs.length > 1
			? ` (and ${cs.length - 1} more case${cs.length === 2 ? '' : 's'}: ${cs
					.slice(1, 4)
					.map((c) => code(c.case))
					.join(', ')}${cs.length > 4 ? ', …' : ''})`
			: '';
	return `**${growth}** in ${code(first.case)} (${steps(first.extra)} steps)${more}`;
}

function where_table(c: CaseBlame, units: Map<number, BlameUnit>): string[] {
	if (c.functions.length === 0) return [];
	// the real-cost column, as the ranked findings show it, when real traffic priced the change
	const real = !!c.cost;
	const out = real
		? ['| Function | Δ self steps | Lines | Real cost |', '| --- | ---: | --- | --- |']
		: ['| Function | Δ self steps | Lines |', '| --- | ---: | --- |'];
	for (const f of c.functions) {
		const lines = f.lines
			.map((l) => {
				const u = l.unit === null ? null : units.get(l.unit);
				const outside = !u && f.only !== 'without' ? ' (unchanged line)' : '';
				return `L${l.line} ${steps(l.delta_steps)}${outside}`;
			})
			.join(', ');
		const only = f.only === 'with' ? ' (new)' : f.only === 'without' ? ' (gone)' : '';
		const cost = !real
			? ''
			: f.cost
				? ` ${cell(`${calls_text(f.cost)} → ${cost_text(f.cost)}`)} |`
				: ' not in the imported traffic |';
		out.push(
			`| ${code(`${f.module} > ${f.function}`)}${only} | ${steps(f.delta_self_steps)} | ${cell(lines)} |${cost}`
		);
	}
	return out;
}

/**
 * What the blamed change costs on the imported traffic, in the words the ranked findings use
 * (weight/cost.ts `cost_text`): in all, and per hunk when it is more than one.
 */
function cost_lines(c: CaseBlame, units: Map<number, BlameUnit>): string[] {
	const k = c.cost;
	if (!k) return [];
	const left =
		k.not_in_traffic > 0
			? ` ${k.not_in_traffic} changed function${k.not_in_traffic === 1 ? '' : 's'} the traffic does not run ${k.not_in_traffic === 1 ? 'is' : 'are'} not in it.`
			: '';
	if (!k.total) {
		return [
			`**Real cost**: not in the imported traffic: it runs none of the ${k.not_in_traffic} function${k.not_in_traffic === 1 ? '' : 's'} this change moves.`
		];
	}
	const each = k.hunks.filter((h) => h.cost);
	const per =
		each.length > 1
			? ` By hunk: ${list(each.map((h) => `${unit_label(units.get(h.unit)!)} ${cost_text(h.cost!)}`))}.`
			: '';
	return [
		`**Real cost** of this change on the imported traffic: ${cost_text(k.total)}.${per}${left}`
	];
}

function group_lines(cs: CaseBlame[], units: Map<number, BlameUnit>): string[] {
	const c = cs[0];
	const names = (ids: number[], extra?: (id: number) => string) => units_list(ids, units, extra);
	const revert = c.revert.units;
	const apply = c.apply.units;
	const named = [...new Set([...revert, ...apply])].sort((a, b) => a - b);
	const out: string[] = [];
	// what the rest of the PR does once the named hunks are undone
	const r = c.revert.extra;
	const rest =
		r === null || Math.abs(r) < 1
			? ''
			: `the rest of the PR ${r < 0 ? 'saves' : 'adds'} ${steps(Math.abs(r)).slice(1)} steps`;
	const own = (u: number) => {
		const s = c.shares.find((x) => x.unit === u)?.revert ?? null;
		return s === null ? '' : `${steps(s * c.extra)} steps`;
	};
	const these = (n: number) => (n === 1 ? 'this change in' : `these ${n} changes:`);
	if (c.status === 'narrowed') {
		out.push(
			`${cases_text(cs)} is narrowed to ${these(revert.length)} ${names(revert)}, before the budget ran out${rest ? ` (${rest})` : ''}.`
		);
	} else if (!c.interacts) {
		const notes = [
			revert.length === 1 && own(revert[0]) ? `${own(revert[0])} by itself` : '',
			rest
		].filter(Boolean);
		const each = revert.length > 1 ? (u: number) => (own(u) ? ` (${own(u)})` : '') : undefined;
		out.push(
			`${cases_text(cs)} comes from ${these(revert.length)} ${names(revert, each)}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}.`
		);
		if (revert.length > 1 && c.shares.length > 0 && c.shares.every((x) => !x.runs_alone)) {
			out.push('', 'None of them loads or runs without the others, so they are one change.');
		}
	} else {
		out.push(`${cases_text(cs)} comes from changes that only cost together: ${names(named)}.`, '');
		const alone = names(
			c.shares.map((x) => x.unit),
			(u) => ` ${share(c.shares.find((x) => x.unit === u)!.apply)}`
		);
		const together =
			apply.length === 1 ? 'that one' : apply.length === 2 ? 'both' : `all ${apply.length}`;
		const removed = c.revert.extra === null ? null : (c.extra - c.revert.extra) / c.extra;
		out.push(
			`They interact. Applied alone on the base: ${alone} of the extra steps; ${together} together: ${share(c.apply.extra === null ? null : c.apply.extra / c.extra)}. Undoing ${names(revert)} alone from this PR removes ${share(removed)} of it.`
		);
	}
	if (c.explained !== null && c.explained < 0.9) {
		out.push(
			'',
			`These hunks account for ${share(c.explained)} of the case's change; the rest comes from outside them.`
		);
	}
	const real = cost_lines(c, units);
	if (real.length > 0) out.push('', ...real);
	out.push('', '<details><summary>The change, and where its steps go</summary>', '');
	for (const id of named) {
		const u = units.get(id)!;
		out.push(`${unit_label(u)}:`, '', ...fenced(u.text ?? ''), '');
	}
	const table = where_table(c, units);
	if (table.length > 0)
		out.push('Steps that undoing it takes away, by function and line:', '', ...table, '');
	out.push('</details>', '');
	return out;
}

/** The blame part of the PR comment. */
export function render_blame(r: BlameResult): string {
	const units = new Map(r.units.map((u) => [u.id, u]));
	const lines: string[] = ['#### Which change made it slower', ''];
	const broken = r.recounts.filter((x) => Object.values(x.steps).some((s) => s === null)).length;
	const budget = `${r.spent.recounts} tree${r.spent.recounts === 1 ? '' : 's'} recounted (${r.spent.reused} reused${broken > 0 ? `, ${broken} did not load or run` : ''}) in ${seconds(r.spent.ms)}, of a budget of ${r.budget.recounts} recounts and ${seconds(r.budget.ms)}`;
	lines.push(
		`Each tree is this PR with some of its ${r.units.length} hunks undone, counted exactly: ${budget}.${r.exhausted ? ' The budget ran out, so some answers are narrowed, not exact.' : ''}`,
		''
	);
	const by_case = new Map(r.cases.map((c) => [c.case, c]));
	for (const g of r.groups.slice(0, MAX_GROUPS)) {
		const cs = g.cases.map((n) => by_case.get(n)!).sort((a, b) => b.extra - a.extra);
		lines.push(...group_lines(cs, units));
	}
	if (r.groups.length > MAX_GROUPS)
		lines.push(`${r.groups.length - MAX_GROUPS} more causes are in the JSON result.`, '');
	for (const c of r.cases) {
		if (c.status === 'found' || c.status === 'narrowed') continue;
		lines.push(
			`- ${code(c.case)}: ${c.status === 'outside' ? 'not from these hunks' : c.status}${c.note ? `, ${cell(c.note)}` : ''}.`
		);
	}
	return lines.join('\n').trimEnd() + '\n';
}
