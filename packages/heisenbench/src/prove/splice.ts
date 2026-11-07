import { parseSync } from 'oxc-parser';

/*
 * A candidate is a set of top-level declarations: each one replaces the declaration of the same
 * name in the original module (all its overloads), and a name the module does not have is added
 * just before the first declaration replaced. A candidate may be one function, a function and the
 * helpers it needs, or the whole fixed module: declarations that are the same as the original's
 * change nothing, and an import is accepted only when the module already has it word for word, so
 * the candidate module loads exactly what the original loads. The result is the original module's
 * text with the changed declarations swapped in, so its lines stay where they were.
 */

interface Node {
	type: string;
	start: number;
	end: number;
	[key: string]: unknown;
}

interface Statement {
	/** The declared name (null: an import or any other statement without one). */
	name: string | null;
	start: number;
	end: number;
	/** Where its leading comment starts (the text after the statement before it, trimmed). */
	lead: number;
	text: string;
}

export interface Spliced {
	/** The candidate module: the original text with the candidate's declarations swapped in. */
	source: string;
	/** Names the candidate replaced (its text differs from the original's). */
	replaced: string[];
	/** Names the candidate added. */
	added: string[];
}

export class SpliceError extends Error {}

function lang_of(file: string): 'ts' | 'js' | 'tsx' | 'jsx' {
	if (file.endsWith('.tsx')) return 'tsx';
	if (file.endsWith('.jsx')) return 'jsx';
	return /\.[cm]?ts$/.test(file) ? 'ts' : 'js';
}

function declared_name(n: Node): string | null {
	let d = n;
	if (d.type === 'ExportNamedDeclaration' || d.type === 'ExportDefaultDeclaration') {
		const inner = d.declaration as Node | null | undefined;
		if (!inner) return null;
		d = inner;
	}
	const id = d.id as { name?: string } | null | undefined;
	if (
		(d.type === 'FunctionDeclaration' ||
			d.type === 'TSDeclareFunction' ||
			d.type === 'ClassDeclaration' ||
			d.type === 'TSTypeAliasDeclaration' ||
			d.type === 'TSInterfaceDeclaration' ||
			d.type === 'TSEnumDeclaration') &&
		id?.name
	)
		return id.name;
	if (d.type === 'VariableDeclaration') {
		const decls = d.declarations as Node[];
		const first = decls.length === 1 ? (decls[0].id as Node & { name?: string }) : null;
		if (first?.type === 'Identifier' && first.name) return first.name;
	}
	return null;
}

/** The top-level statements of `text`, each with its name and its leading comment's start. */
export function statements(file: string, text: string): Statement[] {
	const r = parseSync(file, text, { sourceType: 'module', lang: lang_of(file) });
	if (r.errors.length > 0)
		throw new SpliceError(`${file} does not parse: ${r.errors[0].message.split('\n')[0]}`);
	const body = (r.program as unknown as { body: Node[] }).body;
	const out: Statement[] = [];
	let prev_end = 0;
	for (const n of body) {
		const between = text.slice(prev_end, n.start);
		// a leading comment is the comment text right before the statement, after the line break
		// that ends the statement before it
		const nl = between.indexOf('\n');
		const after_line = nl === -1 || prev_end === 0 ? 0 : nl + 1;
		const lead_text = between.slice(after_line);
		const offset = lead_text.length - lead_text.trimStart().length;
		out.push({
			name: declared_name(n),
			start: n.start,
			end: n.end,
			lead: prev_end + after_line + offset,
			text: text.slice(n.start, n.end)
		});
		prev_end = n.end;
	}
	return out;
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Statements grouped by name, in order (overloads of one function are one group). */
function groups(list: readonly Statement[]): Map<string, Statement[]> {
	const out = new Map<string, Statement[]>();
	for (const s of list) {
		if (s.name === null) continue;
		const g = out.get(s.name);
		if (g) g.push(s);
		else out.set(s.name, [s]);
	}
	return out;
}

/** The original module with the candidate's declarations in place of its own. */
export function splice(
	file: string,
	original: string,
	candidate: string,
	/** The function that is proven: the candidate must declare it. */
	target: string
): Spliced {
	const orig = statements(file, original);
	const cand = statements(file, candidate);
	const orig_groups = groups(orig);
	const cand_groups = groups(cand);
	const top = target.split(' > ')[0];
	if (!cand_groups.has(top)) throw new SpliceError(`the candidate does not declare ${top}`);
	const unnamed = new Set(orig.filter((s) => s.name === null).map((s) => squash(s.text)));
	for (const s of cand) {
		if (s.name !== null || unnamed.has(squash(s.text))) continue;
		const what = s.text.startsWith('import')
			? 'an import the module does not have'
			: 'top-level code that is not a declaration';
		throw new SpliceError(`the candidate has ${what}: ${squash(s.text).slice(0, 80)}`);
	}
	const replaced: string[] = [];
	const added: string[] = [];
	const edits: Array<{ start: number; end: number; text: string }> = [];
	const pending: string[] = [];
	for (const [name, g] of cand_groups) {
		const text = candidate.slice(g[0].start, g[g.length - 1].end);
		const with_lead = candidate.slice(g[0].lead, g[g.length - 1].end);
		const at = orig_groups.get(name);
		if (!at) {
			added.push(name);
			pending.push(with_lead);
			continue;
		}
		const old = original.slice(at[0].start, at[at.length - 1].end);
		if (squash(old) === squash(text)) continue;
		replaced.push(name);
		const prefix = pending.length > 0 ? pending.splice(0).join('\n\n') + '\n\n' : '';
		edits.push({ start: at[0].start, end: at[at.length - 1].end, text: prefix + text });
	}
	if (pending.length > 0) {
		// helpers with nothing replaced after them: before the target's own declaration
		const at = orig_groups.get(top);
		if (!at) throw new SpliceError(`${file} has no top-level ${top}`);
		edits.push({ start: at[0].lead, end: at[0].lead, text: pending.join('\n\n') + '\n\n' });
	}
	if (replaced.length === 0 && added.length === 0)
		throw new SpliceError('the candidate is the same as the original');
	edits.sort((a, b) => b.start - a.start);
	let source = original;
	for (const e of edits) source = source.slice(0, e.start) + e.text + source.slice(e.end);
	return { source, replaced, added };
}

/** The text of the top-level declaration `name` in `text` (all its overloads), or null. */
export function declaration_text(file: string, text: string, name: string): string | null {
	const g = groups(statements(file, text)).get(name);
	return g ? text.slice(g[0].lead, g[g.length - 1].end) : null;
}
