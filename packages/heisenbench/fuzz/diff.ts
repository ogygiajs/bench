import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diff_reports } from '../src/diff/index.ts';
import { parse_diff } from '../src/diff/git.ts';
import type { FileDiff } from '../src/diff/git.ts';
import { REPORT_SCHEMA } from '../src/report.ts';
import type { CaseReport, Report } from '../src/report.ts';
import { children, parse } from './ast.ts';
import type { Node } from './ast.ts';
import type { Program } from './gen.ts';
import type { Lab } from './lab.ts';
import type { Failure } from './check.ts';
import { Rng } from './rng.ts';

/*
 * Oracle 6, `heisenbench diff` on a program and a rewrite of it:
 *
 *   rewrites that cost nothing   comments and blank lines, renamed local variables, reordered
 *                                top-level functions, re-indented code: no finding at all
 *   a planted cost               a loop, an allocation or a built-in call on a line of its own
 *                                before a statement that ran: exactly one finding, on that line,
 *                                with the whole case's change as its delta
 */

type Rewrite = 'comments' | 'rename' | 'reorder' | 'reindent';
const REWRITES: Rewrite[] = ['comments', 'rename', 'reorder', 'reindent'];
const PLANTS = [
	(n: string) => `for (let ${n} = 0; ${n} < 3; ${n}++) {}`,
	(n: string) => `const ${n} = [1, 2];`,
	(_n: string) => `void Math.max(1, 2);`,
	(n: string) => `const ${n} = { a: 1 };`
];

/**
 * Statements of function bodies a plant can go before. Not in generators: a generator object's
 * estimated size grows with its locals, so a planted variable costs there too (on the function's
 * own line), as it should. `last`: the last statement of a body that ends a block (a branch, a
 * loop body, a function body; not a plain `{ }`, after which the same block goes on).
 */
function statements_in(program: Node): Array<{ node: Node; last: boolean }> {
	const out: Array<{ node: Node; last: boolean }> = [];
	const LISTS = new Set(['BlockStatement', 'SwitchCase', 'Program', 'StaticBlock']);
	const visit = (n: Node, in_fn: boolean, parent: Node | null): void => {
		if (n.type.includes('Function') && n.generator === true) return;
		const fn = in_fn || n.type.includes('Function');
		if (fn && (n.type === 'BlockStatement' || n.type === 'SwitchCase')) {
			const list = (n.type === 'BlockStatement' ? n.body : n.consequent) as Node[];
			const plain = n.type === 'BlockStatement' && parent !== null && LISTS.has(parent.type);
			list.forEach((s, i) => out.push({ node: s, last: !plain && i === list.length - 1 }));
		}
		for (const c of children(n)) visit(c, fn, n);
	};
	visit(program, false, null);
	return out;
}

function rename(text: string): string {
	return text.replace(/\bv(\d+)\b/g, 'z$1');
}

export function rewrite(source: string, kind: Rewrite, rng: Rng, lang: 'js' | 'ts'): string {
	const lines = source.split('\n');
	switch (kind) {
		case 'comments': {
			const out: string[] = [];
			for (const l of lines) {
				// a comment or a blank line before a line that starts a statement
				if (rng.chance(0.2) && /^\s*(let|const|log|if|for|return)\b/.test(l)) {
					out.push(rng.chance(0.5) ? '' : `${l.match(/^\s*/)![0]}// note ${rng.int(1000)}`);
				}
				out.push(rng.chance(0.1) ? `${l} /* trailing */` : l);
			}
			return out.join('\n');
		}
		case 'rename':
			// the same length: a name can end up in a string (an error message) whose length is priced
			return rename(source);
		case 'reorder': {
			const program = parse(source, lang === 'ts' ? 'x.ts' : 'x.mjs', lang);
			const fns = (program.body as Node[]).filter((n) => n.type === 'FunctionDeclaration');
			if (fns.length < 2) return source;
			const i = rng.int(fns.length - 1);
			const [a, b] = [fns[i], fns[i + 1]];
			return (
				source.slice(0, a.start) +
				source.slice(b.start, b.end) +
				source.slice(a.end, b.start) +
				source.slice(a.start, a.end) +
				source.slice(b.end)
			);
		}
		case 'reindent':
			return lines.map((l) => l.replace(/^\t+/, (t) => '  '.repeat(t.length))).join('\n');
	}
}

function report_of(c: CaseReport, id: string): Report {
	const text = JSON.stringify(c).split(JSON.stringify(id).slice(1, -1)).join('p.mjs');
	return {
		schema: REPORT_SCHEMA,
		prices: { version: 1, hash: 'fuzz' },
		node: process.version,
		git: { sha: null, prefix: '' },
		cases: [JSON.parse(text) as CaseReport]
	};
}

function git_diff_files(a: string, b: string): FileDiff[] {
	const dir = mkdtempSync(join(tmpdir(), 'heisenbench-fuzz-diff-'));
	try {
		writeFileSync(join(dir, 'a'), a);
		writeFileSync(join(dir, 'b'), b);
		let out = '';
		try {
			out = execFileSync(
				'git',
				['diff', '--no-index', '--no-color', '-M', '--unified=0', 'a', 'b'],
				{
					cwd: dir,
					encoding: 'utf8'
				}
			);
		} catch (e) {
			// exit 1: the files differ
			out = (e as { stdout?: string }).stdout ?? '';
		}
		return parse_diff(out).map((f) => ({ ...f, old_path: 'p.mjs', new_path: 'p.mjs' }));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

let n = 0;

async function counted(
	lab: Lab,
	source: string,
	lang: 'js' | 'ts'
): Promise<{ report: Report; trace: string }> {
	const l = lab.load(source, lang, `d${++n}`);
	const c = await lab.counted(l);
	return { report: report_of(c.report, l.module_id), trace: JSON.stringify(c.trace) };
}

export async function check_diff(
	lab: Lab,
	prog: Program
): Promise<{ failures: Failure[]; runs: number }> {
	const failures: Failure[] = [];
	const rng = new Rng(prog.seed * 7 + 1);
	const base = await counted(lab, prog.source, prog.lang);
	let runs = 1;
	if (prog.deep) return { failures, runs };

	const kinds = REWRITES.filter(() => rng.chance(0.5));
	if (kinds.length === 0) kinds.push(rng.pick(REWRITES));
	let variant = prog.source;
	for (const k of kinds) variant = rewrite(variant, k, rng, prog.lang);
	if (variant !== prog.source) {
		const v = await counted(lab, variant, prog.lang);
		runs++;
		const d = diff_reports(base.report, v.report, { files: git_diff_files(prog.source, variant) });
		// a renamed variable shows in error messages (`Cannot access 'v4' before initialization`)
		const want = kinds.includes('rename') ? rename(base.trace) : base.trace;
		if (v.trace !== want) {
			failures.push({
				oracle: 'diff',
				detail: `the rewrite (${kinds.join(', ')}) changed what the program does`
			});
		} else if (d.findings.length > 0) {
			const f = d.findings[0];
			failures.push({
				oracle: 'diff',
				detail: `${kinds.join(', ')}: ${d.findings.length} finding(s), first ${f.kind} ${f.function}:${f.line} ${JSON.stringify(f.delta)}`
			});
		}
	}

	// A planted cost before a statement that ran. A loop splits the block it is in: the code after
	// it becomes a block of its own, whose count can differ from the block's (an exception may leave
	// a block midway; the block still counts as run, see the report). So a loop goes after the last
	// statement of a block, where nothing follows it.
	const program = parse(prog.source, prog.lang === 'ts' ? 'x.ts' : 'x.mjs', prog.lang);
	const ran = new Set<number>();
	for (const f of base.report.cases[0].functions)
		for (const l of f.lines) if (l.steps > 0) ran.add(l.line);
	const src = prog.source;
	const lines_at = (pos: number): number => src.slice(0, pos).split('\n').length;
	const kind = rng.int(PLANTS.length);
	const loop = kind === 0;
	const JUMPS = new Set([
		'ReturnStatement',
		'ThrowStatement',
		'BreakStatement',
		'ContinueStatement'
	]);
	const candidates = statements_in(program).filter(({ node: s, last }) => {
		if (s.type === 'FunctionDeclaration' || !ran.has(lines_at(s.start))) return false;
		const before = src.slice(src.lastIndexOf('\n', s.start - 1) + 1, s.start);
		const end_nl = src.indexOf('\n', s.end);
		const after = src.slice(s.end, end_nl === -1 ? src.length : end_nl);
		// alone on its lines
		if (before.trim() !== '' || after.trim() !== '') return false;
		return !loop || (last && !JUMPS.has(s.type) && !s.type.endsWith('Declaration'));
	});
	if (candidates.length === 0) return { failures, runs };
	const at = rng.pick(candidates).node;
	const indent = src.slice(src.lastIndexOf('\n', at.start - 1) + 1, at.start);
	const plant = PLANTS[kind](`planted_${prog.seed}`);
	let planted: string;
	let line: number;
	if (loop) {
		const end_nl = src.indexOf('\n', at.end);
		planted = src.slice(0, end_nl + 1) + indent + plant + '\n' + src.slice(end_nl + 1);
		line = lines_at(at.end) + 1;
	} else {
		const line_start = at.start - indent.length;
		planted = src.slice(0, line_start) + indent + plant + '\n' + src.slice(line_start);
		line = lines_at(at.start);
	}
	const p = await counted(lab, planted, prog.lang);
	runs++;
	if (p.trace !== base.trace) {
		failures.push({
			oracle: 'diff',
			detail: `the plant \`${plant}\` changed what the program does`
		});
		return { failures, runs };
	}
	const d = diff_reports(base.report, p.report, { files: git_diff_files(prog.source, planted) });
	const bt = base.report.cases[0].totals;
	const pt = p.report.cases[0].totals;
	const want = {
		steps: Math.round((pt.steps - bt.steps) * 1e6) / 1e6,
		allocations: pt.allocations - bt.allocations
	};
	const where = d.findings
		.map((f) => `${f.kind} ${f.function}:${f.line} ${JSON.stringify(f.delta)}`)
		.join('; ');
	// a plant after a statement every path leaves early never runs: nothing to find
	const expected = want.steps === 0 && want.allocations === 0 ? 0 : 1;
	if (d.findings.length !== expected) {
		failures.push({
			oracle: 'diff',
			detail: `plant \`${plant}\` at line ${line}: ${d.findings.length} finding(s) [${where}], want ${expected} (${JSON.stringify(want)})`
		});
	} else if (expected === 1) {
		const f = d.findings[0];
		if (
			f.line !== line ||
			Math.abs(f.delta.steps - want.steps) > 1e-6 ||
			f.delta.allocations !== want.allocations
		) {
			failures.push({
				oracle: 'diff',
				detail: `plant \`${plant}\` at line ${line}: found [${where}], want line ${line} ${JSON.stringify(want)}`
			});
		}
	}
	return { failures, runs };
}
