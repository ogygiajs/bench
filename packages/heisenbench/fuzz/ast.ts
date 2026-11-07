import { parseSync } from 'oxc-parser';

/*
 * The fuzzer's own view of a program's functions, from its own walk of the AST: the oracles find
 * functions by position here and never through the transform's numbering.
 */

export interface Node {
	type: string;
	start: number;
	end: number;
	[key: string]: unknown;
}

export interface FnInfo {
	/** Start of the function node (the transform's function position). */
	start: number;
	end: number;
	/** The body (a block, or an arrow's expression). */
	body_start: number;
	body_end: number;
	generator: boolean;
	async: boolean;
}

export interface AstIndex {
	program: Node;
	fns: FnInfo[];
	/** FunctionDeclaration start -> start of the statement list it is hoisted to. */
	hoisted: Map<number, number>;
	/** Every node type seen. */
	types: Set<string>;
	/** Class bodies: [start, end). */
	classes: Array<[number, number]>;
	/** Method function start -> start of its method definition (its key, where V8's range starts). */
	members: Map<number, number>;
	lines: number[];
}

const SKIP = new Set(['type', 'start', 'end', 'range', 'loc']);

export function children(n: Node): Node[] {
	const out: Node[] = [];
	for (const k in n) {
		if (SKIP.has(k)) continue;
		const v = n[k];
		if (Array.isArray(v)) {
			for (const x of v)
				if (x && typeof x === 'object' && typeof (x as Node).type === 'string') out.push(x as Node);
		} else if (v && typeof v === 'object' && typeof (v as Node).type === 'string')
			out.push(v as Node);
	}
	return out;
}

export function parse(code: string, filename = 'x.mjs', lang: 'js' | 'ts' = 'js'): Node {
	const r = parseSync(filename, code, { sourceType: 'module', lang, preserveParens: false });
	if (r.errors.length > 0) throw new Error(`parse: ${r.errors[0].message}`);
	return r.program as unknown as Node;
}

export function line_starts(code: string): number[] {
	const out = [0];
	for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) out.push(i + 1);
	return out;
}

export function offset_of(lines: number[], line: number, col: number): number {
	return (lines[line - 1] ?? 0) + col;
}

export function index_ast(code: string, lang: 'js' | 'ts' = 'js'): AstIndex {
	const program = parse(code, lang === 'ts' ? 'x.ts' : 'x.mjs', lang);
	const fns: FnInfo[] = [];
	const hoisted = new Map<number, number>();
	const types = new Set<string>();
	const classes: Array<[number, number]> = [];
	const members = new Map<number, number>();
	const visit = (n: Node, list_start: number): void => {
		types.add(n.type);
		if (n.type === 'ClassBody') classes.push([n.start, n.end]);
		if (
			n.type === 'MethodDefinition' ||
			(n.type === 'Property' && (n.method === true || n.kind !== 'init'))
		) {
			const value = n.value as Node | null;
			if (value) members.set(value.start, n.start);
		}
		if (
			n.type === 'FunctionDeclaration' ||
			n.type === 'FunctionExpression' ||
			n.type === 'ArrowFunctionExpression'
		) {
			const body = n.body as Node | null;
			if (body) {
				fns.push({
					start: n.start,
					end: n.end,
					body_start: body.start,
					body_end: body.end,
					generator: n.generator === true,
					async: n.async === true
				});
			}
			if (n.type === 'FunctionDeclaration') hoisted.set(n.start, list_start);
		}
		let inner = list_start;
		if (n.type === 'BlockStatement' || n.type === 'StaticBlock') inner = n.start;
		if (n.type === 'SwitchCase') inner = n.start;
		for (const c of children(n)) visit(c, inner);
	};
	visit(program, program.start);
	fns.sort((a, b) => a.start - b.start);
	return { program, fns, hoisted, types, classes, members, lines: line_starts(code) };
}

/** Innermost function whose node contains `offset`. */
export function fn_at(ix: AstIndex, offset: number): FnInfo | null {
	let best: FnInfo | null = null;
	for (const f of ix.fns) {
		if (f.start > offset) break;
		if (offset < f.end && (!best || f.start >= best.start)) best = f;
	}
	return best;
}

/**
 * The function V8 says a frame runs in, from the position V8 gives for that function: a method's
 * is its key (`get a`, `static m`), before the function node itself.
 */
export function fn_starting_near(ix: AstIndex, offset: number): FnInfo | null {
	let best: FnInfo | null = null;
	let best_start = -1;
	for (const f of ix.fns) {
		const start = Math.min(f.start, ix.members.get(f.start) ?? f.start);
		if (start <= offset && offset < f.end && start >= best_start) {
			best = f;
			best_start = start;
		}
	}
	return best;
}
