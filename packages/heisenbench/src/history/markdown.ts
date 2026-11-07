import { cell, code } from '../md.ts';
import type {
	CommitRef,
	HistoryEvent,
	HistoryFunction,
	HistoryLine,
	HistoryResult
} from './index.ts';

/*
 * Two views of one history: the file as `git blame` prints it, with the cost columns in front
 * (the terminal), and a markdown page (the lines that ran or changed, and each function's timeline).
 */

function fmt(n: number): string {
	const r = Math.round(n * 100) / 100;
	return r.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function signed(n: number): string {
	return (n > 0 ? '+' : '') + fmt(n);
}

function ratio(r: number | null): string {
	if (r === null) return '';
	const p = r * 100;
	const s = Math.abs(p) >= 10 ? p.toFixed(0) : p.toFixed(1);
	return `${p > 0 ? '+' : ''}${s}%`;
}

/** `01dc5b99 (#186)`, or the range `57882cce..01dc5b99 (3 commits)`. */
export function commit_label(commits: CommitRef[]): string {
	if (commits.length === 0) return '?';
	const last = commits.at(-1)!;
	const pr = (c: CommitRef) => (c.pr !== null ? ` (#${c.pr})` : '');
	if (commits.length === 1) return `${last.sha.slice(0, 8)}${pr(last)}`;
	return `${commits[0].sha.slice(0, 8)}..${last.sha.slice(0, 8)} (${commits.length} commits)`;
}

/** What one change did, in words: `-98% (-1,203,400)`, `new code +120`, `unpriced`. */
export function change_text(e: HistoryEvent): string {
	const marks: string[] = [];
	if (e.counter_changed) marks.push('counter changed');
	if (e.edited) marks.push('edited');
	const tail = marks.length > 0 ? ` [${marks.join(', ')}]` : '';
	if (e.delta === null) return `unpriced${tail}`;
	if (e.kind === 'new code') return `new code ${signed(e.delta)}${tail}`;
	const r = ratio(e.ratio);
	return `${r ? r + ' ' : ''}(${signed(e.delta)})${tail}`;
}

/** The file with the cost columns in front, like `git blame`. */
export function render_history_text(r: HistoryResult): string {
	const today = r.runs.at(-1)!;
	const head = `${r.file}${r.function ? ` (${r.function})` : ''} at ${today.sha.slice(0, 12)}, ${r.runs.length} runs from ${r.runs[0].sha.slice(0, 12)}`;
	const rows = r.lines.map((l) => {
		const per = l.per_call !== null && l.steps !== 0 ? fmt(l.per_call) : '';
		const last = l.last ? commit_label(l.last.commits) : '';
		const delta = l.last ? change_text(l.last) : '';
		return [per, last, delta, String(l.line), l.text];
	});
	const width = [0, 1, 2, 3].map((i) =>
		Math.max(
			['steps/call', 'last change', 'Δ steps', 'line'][i].length,
			...rows.map((row) => row[i].length)
		)
	);
	const pad = (s: string, w: number, right = false) => (right ? s.padStart(w) : s.padEnd(w));
	const out = [
		head,
		'',
		`${pad('steps/call', width[0], true)}  ${pad('last change', width[1])}  ${pad('Δ steps', width[2])}  ${pad('line', width[3], true)}`
	];
	for (const row of rows)
		out.push(
			`${pad(row[0], width[0], true)}  ${pad(row[1], width[1])}  ${pad(row[2], width[2])}  ${pad(row[3], width[3], true)}  ${row[4]}`
		);
	out.push('', ...timeline_text(r));
	for (const n of r.notes) out.push(`note: ${n}`);
	return out.join('\n');
}

function timeline_text(r: HistoryResult): string[] {
	const out: string[] = [];
	for (const f of r.functions) {
		const changes = f.timeline.filter((t) => t.change !== null);
		out.push(`${f.id}  ${fmt(f.steps)} steps, ${fmt(f.calls)} calls today`);
		if (f.was.length > 0) out.push(`  was ${f.was.join(', then ')}`);
		if (changes.length === 0) out.push(`  no change in ${f.timeline.length} run(s)`);
		for (const t of changes)
			out.push(
				`  ${commit_label(t.change!.commits)}  ${change_text(t.change!)}  -> ${fmt(t.steps ?? 0)}`
			);
	}
	return out;
}

function line_row(l: HistoryLine): string {
	const last = l.last;
	return `| ${l.line} | ${code(l.text.trim() || ' ')} | ${l.per_call !== null && l.steps !== 0 ? fmt(l.per_call) : ''} | ${fmt(l.steps)} | ${last ? cell(commit_label(last.commits)) : ''} | ${last ? cell(change_text(last)) : ''} | ${l.events.length} |`;
}

function timeline_table(f: HistoryFunction, r: HistoryResult): string[] {
	const out = [
		`#### ${code(f.id)}`,
		'',
		`${fmt(f.steps)} steps and ${fmt(f.calls)} calls today, lines ${f.line} to ${f.end_line}.${f.was.length > 0 ? ` Was ${f.was.map(code).join(', then ')}.` : ''}`,
		'',
		'| Commit | Subject | Self steps | Δ |',
		'| --- | --- | ---: | ---: |'
	];
	// its first run, every change and today; the runs between them changed nothing
	const rows = f.timeline.filter(
		(t, i) => i === 0 || t.change !== null || i === f.timeline.length - 1
	);
	for (let i = 0; i < rows.length; i++) {
		const t = rows[i];
		const run = r.runs[t.run];
		const label = t.change ? commit_label(t.change.commits) : run.sha.slice(0, 8);
		const quiet = i > 0 ? f.timeline.indexOf(t) - f.timeline.indexOf(rows[i - 1]) - 1 : 0;
		if (quiet > 0) out.push(`| | ${quiet} run(s) with no change | | |`);
		out.push(
			`| ${cell(label)} | ${cell(run.subject)} | ${t.steps === null ? 'unpriced' : fmt(t.steps)} | ${t.change ? cell(change_text(t.change)) : ''} |`
		);
	}
	return out;
}

/** The markdown page: lines that ran or changed, then every function's timeline. */
export function render_history(r: HistoryResult): string {
	const today = r.runs.at(-1)!;
	const out = [
		`### History of ${code(r.file)}${r.function ? `, ${code(r.function)}` : ''}`,
		'',
		`${r.runs.length} runs, ${code(r.runs[0].sha.slice(0, 8))} to ${code(today.sha.slice(0, 8))} (${cell(today.subject)}). Steps are today's, over every case; a change is counted over the cases both runs counted with the same input.`,
		''
	];
	for (const n of r.notes) out.push(`- ${n}`);
	if (r.notes.length > 0) out.push('');
	const shown = r.lines.filter((l) => l.steps !== 0 || l.events.length > 0);
	out.push(
		'| Line | Code | Steps/call | Steps | Last change | Δ | Changes |',
		'| ---: | --- | ---: | ---: | --- | ---: | ---: |',
		...shown.map(line_row),
		''
	);
	for (const f of r.functions) out.push(...timeline_table(f, r), '');
	return out.join('\n');
}
