import { existsSync, readFileSync } from 'node:fs';
import { parseSync } from 'oxc-parser';
import { GROWTH_RANK } from '../growth/fit.ts';
import type { GrowthClass } from '../growth/fit.ts';

/*
 * Complexity contracts, declared: a JSDoc tag on the function it limits.
 *
 *   /** @heisenbench linear in items *\/
 *   export function rank(items: Row[], limit: number) { ... }
 *
 * The tag names a class (constant, log, linear, n log n, quadratic, cubic, quartic) and, after
 * `in`, the parameter the growth is over. Without `in`, it is over the function's whole input.
 *
 * Why a comment on the function and not an entry in a bench file's config: a comment changes
 * nothing that runs (the counting transform, the plain build and the types all ignore it), it sits
 * where a reviewer reads the code it limits, it moves and renames with the function (a config
 * entry names `module > path`, which a move silently orphans), and API docs built from the
 * declarations show it with the function's other docs.
 *
 * A tag binds to the function that starts right after its comment: a function declaration, a
 * `const` holding a function or an arrow, a class method or an object method. On an overload
 * signature it binds to the implementation after it. A tag that names an unknown class, a
 * parameter the function does not have, or no function at all is an error, never ignored.
 */

/** The classes a contract can declare: fit.ts's, up to quartic. */
export type ContractClass = Extract<
	GrowthClass,
	'constant' | 'log' | 'linear' | 'n log n' | 'quadratic' | 'cubic' | 'quartic'
>;

export const CONTRACT_CLASSES: readonly ContractClass[] = [
	'constant',
	'log',
	'linear',
	'n log n',
	'quadratic',
	'cubic',
	'quartic'
];

export const TAG = '@heisenbench';

export interface Contract {
	/** The function's id in reports (`module > path`). */
	id: string;
	module: string;
	path: string;
	/** Where the function starts (1-based), and where its tag is. */
	line: number;
	tag_line: number;
	class: ContractClass;
	/** The parameter the growth is over (null: the whole input). */
	param: string | null;
	/** Its index among the function's parameters (null with no parameter). */
	argument: number | null;
	/** The tag's words, as written after `@heisenbench`. */
	text: string;
}

export interface ContractError {
	module: string;
	line: number;
	text: string;
	error: string;
}

/** A counted function of the module (the transform's meta: path and where it starts). */
export interface CountedFunction {
	path: string;
	line: number;
	col: number;
	kind: string;
}

interface Node {
	type: string;
	start: number;
	end: number;
	[k: string]: unknown;
}

const WORDS =
	/^(constant|log|linear|n\s*log\s*n|quadratic|cubic|quartic)(?:\s+in\s+([A-Za-z_$][\w$]*))?$/;

/** `n log n`, `nlogn`, `n  log n` -> `n log n`; the class words, or null. */
function parse_words(text: string): { class: ContractClass; param: string | null } | null {
	const m = WORDS.exec(text.trim().replace(/\s+/g, ' '));
	if (!m) return null;
	const cls = (/^n\s*log\s*n$/.test(m[1]) ? 'n log n' : m[1]) as ContractClass;
	return { class: cls, param: m[2] ?? null };
}

function is_node(v: unknown): v is Node {
	return typeof v === 'object' && v !== null && typeof (v as Node).type === 'string';
}

/** Every node, outer before inner. */
function walk(n: Node, visit: (n: Node) => void): void {
	visit(n);
	for (const k of Object.keys(n)) {
		if (k === 'type' || k === 'start' || k === 'end') continue;
		const v = n[k];
		if (Array.isArray(v)) {
			for (const x of v) if (is_node(x)) walk(x, visit);
		} else if (is_node(v)) walk(v, visit);
	}
}

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** The function a documented node holds, or null (an overload signature is resolved by the caller). */
function function_of(n: Node | null | undefined): Node | null {
	for (let i = 0; n && i < 4; i++) {
		if (FUNCTIONS.has(n.type)) return n;
		if (n.type === 'ExportNamedDeclaration' || n.type === 'ExportDefaultDeclaration')
			n = n.declaration as Node | null;
		else if (n.type === 'VariableDeclaration') {
			const ds = n.declarations as Node[];
			n = ds.length === 1 ? (ds[0].init as Node | null) : null;
		} else if (n.type === 'VariableDeclarator') n = n.init as Node | null;
		else if (
			n.type === 'MethodDefinition' ||
			n.type === 'Property' ||
			n.type === 'PropertyDefinition' ||
			n.type === 'TSAbstractMethodDefinition'
		)
			n = n.value as Node | null;
		else if (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression')
			n = n.expression as Node | null;
		else return null;
	}
	return null;
}

/** A parameter's name (`a`, `a = 1`, `...rest`, `a?: T`), or null for a pattern. */
function param_name(p: Node): string | null {
	if (p.type === 'TSParameterProperty') return param_name(p.parameter as Node);
	if (p.type === 'Identifier') return p.name as string;
	if (p.type === 'AssignmentPattern') return param_name(p.left as Node);
	if (p.type === 'RestElement') return param_name(p.argument as Node);
	return null;
}

function lang_of(filename: string): 'ts' | 'tsx' | 'js' | 'jsx' {
	if (/\.(c|m)?tsx$/.test(filename)) return 'tsx';
	if (/\.(c|m)?ts$/.test(filename)) return 'ts';
	if (filename.endsWith('.jsx')) return 'jsx';
	return 'js';
}

function line_starts(src: string): number[] {
	const out = [0];
	for (let i = src.indexOf('\n'); i !== -1; i = src.indexOf('\n', i + 1)) out.push(i + 1);
	return out;
}

function position(starts: readonly number[], offset: number): { line: number; col: number } {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >>> 1;
		if (starts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return { line: lo + 1, col: offset - starts[lo] };
}

/**
 * The contracts declared in one module's source. `functions`: the module's counted functions (the
 * transform's meta), which give each contract its id. A `.svelte` file is not read (its script's
 * comments are not where the compiled functions are).
 */
export function read_contracts(
	source: string,
	filename: string,
	module: string,
	functions: readonly CountedFunction[]
): { contracts: Contract[]; errors: ContractError[] } {
	const contracts: Contract[] = [];
	const errors: ContractError[] = [];
	if (!source.includes(TAG) || filename.endsWith('.svelte')) return { contracts, errors };
	const parsed = parseSync(filename, source, { sourceType: 'module', lang: lang_of(filename) });
	const starts = line_starts(source);
	const tagged: Array<{ end: number; text: string; line: number }> = [];
	for (const c of parsed.comments) {
		if (c.type !== 'Block' || !c.value.startsWith('*')) continue;
		const lines = c.value.split('\n');
		let offset = c.start + 2;
		const tags: Array<{ text: string; line: number }> = [];
		for (const l of lines) {
			const at = l.indexOf(TAG);
			// a tag is `@heisenbench` at the start of a doc line (after its `*`), not a mention
			if (
				at !== -1 &&
				/^\s*\*?\s*$/.test(l.slice(0, at)) &&
				!/[\w-]/.test(l[at + TAG.length] ?? '')
			)
				tags.push({
					text: l
						.slice(at + TAG.length)
						.replace(/\*+\s*$/, '')
						.trim(),
					line: position(starts, offset + at).line
				});
			offset += l.length + 1;
		}
		if (tags.length > 1) {
			errors.push({
				module,
				line: tags[1].line,
				text: tags[1].text,
				error: 'one contract per function: this doc comment has more than one @heisenbench tag'
			});
			continue;
		}
		if (tags.length === 1) tagged.push({ end: c.end, ...tags[0] });
	}
	if (tagged.length === 0) return { contracts, errors };
	if (parsed.errors.length > 0) {
		for (const t of tagged)
			errors.push({
				module,
				line: t.line,
				text: t.text,
				error: `the module does not parse: ${parsed.errors[0].message}`
			});
		return { contracts, errors };
	}
	// the outermost node starting at each offset, and every function declaration in source order
	const at_offset = new Map<number, Node>();
	const declarations: Node[] = [];
	walk(parsed.program as unknown as Node, (n) => {
		if (!at_offset.has(n.start)) at_offset.set(n.start, n);
		if (n.type === 'FunctionDeclaration' || n.type === 'TSDeclareFunction') declarations.push(n);
	});
	for (const t of tagged) {
		const fail = (error: string) => errors.push({ module, line: t.line, text: t.text, error });
		const words = parse_words(t.text);
		if (!words) {
			fail(
				`not a contract: write \`${TAG} <class> in <parameter>\`, the class one of ${CONTRACT_CLASSES.join(', ')}`
			);
			continue;
		}
		let next = t.end;
		while (next < source.length && /\s/.test(source[next])) next++;
		const documented = at_offset.get(next);
		const decl =
			documented?.type === 'ExportNamedDeclaration' ||
			documented?.type === 'ExportDefaultDeclaration'
				? (documented.declaration as Node | null)
				: documented;
		// an overload signature: the implementation after it, of the same name
		const fn =
			decl?.type === 'TSDeclareFunction'
				? (declarations.find(
						(d) =>
							d.type === 'FunctionDeclaration' &&
							d.body &&
							d.start > next &&
							(d.id as Node | null)?.name === (decl.id as Node | null)?.name
					) ?? null)
				: function_of(documented);
		if (!fn) {
			fail('the tag is on no function (it binds to the function right after its comment)');
			continue;
		}
		const at = position(starts, fn.start);
		const same_line = functions.filter((f) => f.kind === 'function' && f.line === at.line);
		const counted =
			same_line.find((f) => f.col === at.col) ??
			[...same_line].sort((a, b) => Math.abs(a.col - at.col) - Math.abs(b.col - at.col))[0];
		if (!counted) {
			fail(`no counted function starts at line ${at.line}`);
			continue;
		}
		// a TypeScript `this` parameter is not an argument
		const names = (fn.params as Node[])
			.map(param_name)
			.filter((p, i) => !(i === 0 && p === 'this'));
		let argument: number | null = null;
		if (words.param !== null) {
			argument = names.indexOf(words.param);
			if (argument === -1) {
				const list = names.filter((n): n is string => n !== null);
				fail(
					`\`${words.param}\` is not a parameter of ${counted.path} (${list.length > 0 ? `its parameters: ${list.join(', ')}` : 'it has none by name'})`
				);
				continue;
			}
		}
		contracts.push({
			id: `${module} > ${counted.path}`,
			module,
			path: counted.path,
			line: at.line,
			tag_line: t.line,
			class: words.class,
			param: words.param,
			argument,
			text: t.text.replace(/\s+/g, ' ')
		});
	}
	return { contracts, errors };
}

/**
 * The contracts of the modules a counting run loaded, read once per module from its source file
 * (the project's own modules: a dependency's tags are its maintainers' business).
 */
export class ContractBook {
	#read = new Set<string>();
	contracts = new Map<string, Contract>();
	errors: ContractError[] = [];

	read(
		modules: Iterable<{ id: string; file: string; functions: readonly CountedFunction[] }>
	): void {
		for (const m of modules) {
			if (this.#read.has(m.id)) continue;
			this.#read.add(m.id);
			if (m.file.includes('/node_modules/') || !existsSync(m.file)) continue;
			const r = read_contracts(readFileSync(m.file, 'utf8'), m.file, m.id, m.functions);
			for (const c of r.contracts) this.contracts.set(c.id, c);
			this.errors.push(...r.errors);
		}
	}
}

/** The rank of a contract's class (GROWTH_RANK). */
export function contract_rank(c: ContractClass): number {
	return GROWTH_RANK[c]!;
}
