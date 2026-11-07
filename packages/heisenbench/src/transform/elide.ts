import { parseSync } from 'oxc-parser';

/*
 * A type imported without `type` (`import { Rule, apply } from './rules.ts'`, where `Rule` is an
 * `export type`). `tsc` and bundlers drop an import that no value uses; Node's type stripping
 * keeps every import that is not `import type`, and the module then fails to link: "does not
 * provide an export named 'Rule'". So after stripping, a named import that nothing in the module
 * reads is blanked out, as the TypeScript compiler elides it.
 *
 * Only named imports (`{ a, b as c }`), and only when the name appears nowhere else in the
 * module: any identifier, property key or member name spelled the same keeps it. Dropping an
 * import nothing reads changes nothing at run time; the module is still imported (`import {}
 * from`), so what it does when it loads, and the order modules load in, stay as they were.
 * Blanking keeps every offset, line and column.
 */

interface Node {
	type: string;
	start: number;
	end: number;
	[key: string]: unknown;
}

interface Spec {
	start: number;
	end: number;
	local: string;
	named: boolean;
}

/** Spaces in place of `s[from, to)`, newlines kept. */
function blank(s: string[], from: number, to: number): void {
	for (let i = from; i < to; i++) if (s[i] !== '\n' && s[i] !== '\r') s[i] = ' ';
}

/** How often each name appears as an identifier outside the import declarations. */
function names_used(program: Node): Map<string, number> {
	const out = new Map<string, number>();
	const walk = (v: unknown): void => {
		if (v === null || typeof v !== 'object') return;
		if (Array.isArray(v)) {
			for (const x of v) walk(x);
			return;
		}
		const n = v as Node;
		if (n.type === 'ImportDeclaration') return;
		if ((n.type === 'Identifier' || n.type === 'JSXIdentifier') && typeof n.name === 'string') {
			out.set(n.name, (out.get(n.name) ?? 0) + 1);
		}
		for (const key in n) {
			if (key === 'type' || key === 'start' || key === 'end') continue;
			walk(n[key]);
		}
	};
	walk(program);
	return out;
}

/**
 * `js` (type-stripped TypeScript) with every named import nothing reads blanked out, and how many
 * were. `js` itself, and 0, when there is none or the module does not parse.
 */
export function elide_unused_imports(
	js: string,
	filename: string
): { code: string; elided: number } {
	if (!/\bimport\b[^;]*\{/.test(js)) return { code: js, elided: 0 };
	const parsed = parseSync(filename.replace(/\.[cm]?ts$/, '.js'), js, {
		sourceType: 'module',
		lang: 'js'
	});
	if (parsed.errors.length > 0) return { code: js, elided: 0 };
	const program = parsed.program as unknown as Node;
	const body = program.body as Node[];
	const imports = body.filter(
		(n) => n.type === 'ImportDeclaration' && (n.specifiers as Node[]).length > 0
	);
	if (imports.length === 0) return { code: js, elided: 0 };
	const used = names_used(program);
	let s: string[] | null = null;
	let elided = 0;
	for (const decl of imports) {
		const specs: Spec[] = (decl.specifiers as Node[]).map((n) => ({
			start: n.start,
			end: n.end,
			local: (n.local as Node & { name: string }).name,
			named: n.type === 'ImportSpecifier'
		}));
		const named = specs.filter((x) => x.named);
		const drop = named.filter((x) => !used.has(x.local));
		if (drop.length === 0) continue;
		// UTF-16 code units, as the parser's offsets count
		s ??= js.split('');
		elided += drop.length;
		const open = js.lastIndexOf('{', named[0].start);
		const close = js.indexOf('}', named[named.length - 1].end);
		if (drop.length === named.length) {
			// `import { A, B } from` -> `import {      } from` (a default import before it stays)
			blank(s, open + 1, close);
			continue;
		}
		// A dropped name goes with the comma after it. Every kept name keeps its own, so two kept
		// names stay one comma apart, and the last kept one keeps a trailing comma at most.
		for (let i = 0; i < named.length; i++) {
			if (!drop.includes(named[i])) continue;
			blank(s, named[i].start, named[i].end);
			const until = i + 1 < named.length ? named[i + 1].start : close;
			const comma = js.indexOf(',', named[i].end);
			if (comma !== -1 && comma < until) blank(s, comma, comma + 1);
		}
	}
	return s === null ? { code: js, elided: 0 } : { code: s.join(''), elided };
}
