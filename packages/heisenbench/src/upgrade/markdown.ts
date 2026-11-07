import { cell, code } from '../md.ts';
import type { UpgradeCase, UpgradeFunction, UpgradeResult } from './index.ts';

/** Cases given a line of their own; the rest are counted. */
const MAX_CASES = 8;
/** Functions per case in the table. */
const MAX_ROWS = 5;

export function steps(n: number): string {
	const a = Math.abs(n);
	const sign = n < 0 ? '−' : '+';
	if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)}M`;
	if (a >= 1e4) return `${sign}${(a / 1e3).toFixed(1)}K`;
	return `${sign}${Math.round(a)}`;
}

export function pct(part: number, whole: number): string {
	if (whole === 0) return part === 0 ? '0%' : 'new';
	const p = (part / whole) * 100;
	const digits = Math.abs(p) < 0.1 ? 2 : 1;
	return `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(digits)}%`;
}

function list(xs: string[]): string {
	if (xs.length <= 1) return xs.join('');
	return `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
}

/** `svelte 5.56.8 → 5.57.3` for the bumps a case counts, the one whose steps moved most first. */
function bumps_text(r: UpgradeResult, c: UpgradeCase): string {
	const moved = (name: string) =>
		Math.abs(
			c.by_package.filter((p) => p.package.startsWith(`${name}@`)).reduce((s, p) => s + p.delta, 0)
		);
	return list(
		r.bumps
			.filter((b) => c.packages.includes(b.name))
			.sort((a, b) => moved(b.name) - moved(a.name) || (a.name < b.name ? -1 : 1))
			.map((b) => `${b.name} ${b.from} → ${b.to}`)
	);
}

/** The lines that carry most of a function's change: `L151` or `L151, L160`. */
export function main_lines(f: UpgradeFunction): string {
	const total = Math.abs(f.delta_self_steps);
	const out: string[] = [];
	let got = 0;
	for (const l of f.lines) {
		if (Math.sign(l.delta_steps) !== Math.sign(f.delta_self_steps)) continue;
		out.push(`L${l.line}`);
		got += Math.abs(l.delta_steps);
		if (got >= 0.9 * total || out.length === 3) break;
	}
	return out.join(', ');
}

/** The function that carries most of a case's change, the same way. */
export function main_function(c: UpgradeCase): UpgradeFunction | null {
	const with_sign = c.functions.filter(
		(f) => Math.sign(f.delta_self_steps) === Math.sign(c.delta) && f.package !== 'own code'
	);
	return with_sign[0] ?? null;
}

/**
 * `upgrading svelte 5.56.8 → 5.57.3 makes `case` +12.0% (+3.50M steps; all in `fn` L151)`: the
 * case's change and where it is.
 */
export function headline(r: UpgradeResult, c: UpgradeCase): string {
	const head = `upgrading ${bumps_text(r, c)} makes ${code(c.case)} **${pct(c.delta, c.old_steps)}** (${steps(c.delta)} steps`;
	const f = main_function(c);
	if (!f || c.delta === 0) return `${head})`;
	const share = f.delta_self_steps / c.delta;
	const lines = main_lines(f);
	const at = `${code(`${f.module} > ${f.function}`)}${lines ? ` ${lines}` : ''}`;
	// more than the whole change: the rest of the upgrade gives some of it back
	if (share > 1.005)
		return `${head}: ${steps(f.delta_self_steps)} in ${at}, ${steps(c.delta - f.delta_self_steps)} elsewhere)`;
	return `${head}; ${share >= 0.995 ? 'all' : `${Math.round(share * 100)}%`} in ${at})`;
}

function function_row(c: UpgradeCase, f: UpgradeFunction): string {
	const lines = f.lines
		.map((l) => `L${l.line} ${steps(l.delta_steps)}${l.upstream ? ' (changed upstream)' : ''}`)
		.join(', ');
	const only = f.only === 'with' ? ' (new)' : f.only === 'without' ? ' (gone)' : '';
	const calls =
		f.calls.old !== f.calls.new
			? `${f.calls.old.toLocaleString('en-US')} → ${f.calls.new.toLocaleString('en-US')}`
			: '';
	return `| ${code(c.case)} | ${code(`${f.module} > ${f.function}`)}${only} | ${steps(f.delta_self_steps)} | ${calls} | ${cell(lines)} |`;
}

export function render_upgrade(r: UpgradeResult): string {
	const out: string[] = ['#### What the dependency upgrades cost', ''];
	if (r.bumps.length === 0) {
		out.push('No counted dependency changed its version.');
		return out.join('\n') + '\n';
	}
	const upgraded = r.bumps.map((b) => {
		const files =
			b.changed_files === null
				? ', installed files not found: lines compared by number'
				: b.changed_files === 0
					? ', no file changed'
					: `, ${b.changed_files} file${b.changed_files === 1 ? '' : 's'} changed`;
		return `**${b.name}** ${b.from} → ${b.to}${files}`;
	});
	out.push(
		`${list(upgraded)}. The PR's own code is counted twice, once with each side's install, so what changes here is the upgrade's alone.`,
		''
	);
	const moved = r.cases.filter((c) => c.delta !== 0);
	const still = r.cases.length - moved.length;
	for (const c of moved.slice(0, MAX_CASES)) out.push(`- ${headline(r, c)}`);
	if (moved.length > MAX_CASES)
		out.push(`- … ${moved.length - MAX_CASES} more case(s) in the JSON`);
	if (moved.length === 0) out.push('No case that counts the upgraded packages changed its steps.');
	else if (still > 0)
		out.push(
			'',
			`${still} more case${still === 1 ? '' : 's'} count${still === 1 ? 's' : ''} them and did not change.`
		);
	const rows = moved
		.slice(0, MAX_CASES)
		.flatMap((c) => c.functions.slice(0, MAX_ROWS).map((f) => function_row(c, f)));
	if (rows.length > 0) {
		out.push(
			'',
			'<details><summary>Where</summary>',
			'',
			'| Case | Function | Δ self steps | Calls | Lines |',
			'| --- | --- | ---: | ---: | --- |',
			...rows,
			'',
			'</details>'
		);
	}
	const notes: string[] = [];
	if (r.unexplained.length > 0)
		notes.push(
			`${r.unexplained.length} case(s) that count none of the upgraded packages changed too (${list(r.unexplained.slice(0, 3).map((u) => `${code(u.case)} ${steps(u.new_steps - u.old_steps)}`))}): their code is the same on both installs, so the count depends on something else (module state left by earlier cases, or a package that changed uncounted). Not blamed on the upgrade.`
		);
	if (r.order_dependent.length > 0)
		notes.push(
			`${r.order_dependent.length} case(s) count differently here than in the PR's report (${list(r.order_dependent.slice(0, 3).map((u) => `${code(u.case)} ${steps(u.recount - u.report)}`))}): the count depends on which cases ran before it.`
		);
	if (r.failed.length > 0)
		notes.push(
			`${r.failed.length} case(s) did not count on one install (${list(r.failed.slice(0, 3).map((f) => `${code(f.case)} on the ${f.side === 'old' ? "base's" : "PR's"}: ${cell(f.error)}`))}).`
		);
	if (r.added.length > 0) notes.push(`New dependencies counted: ${list(r.added.map(code))}.`);
	if (r.removed.length > 0) notes.push(`No longer counted: ${list(r.removed.map(code))}.`);
	for (const n of notes) out.push('', `> ${n}`);
	return out.join('\n') + '\n';
}
