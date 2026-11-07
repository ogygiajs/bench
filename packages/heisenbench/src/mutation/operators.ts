import { parseSync } from 'oxc-parser';
import { Positions } from '../transform/positions.ts';

/*
 * Performance mutants (spec: mutation score). Each operator rewrites one function of a module so
 * it does more work and the same thing, and the mutation layer (mutation/index.ts) checks that a
 * bench case notices. The rewrite is a source edit on the original file (TypeScript or JavaScript)
 * that adds text on existing lines only, so every line keeps its number and the step diff compares
 * the mutant with the original line for line.
 *
 *   double     the call costs twice its steps: at the end of the outermost call, a counted loop
 *              runs until the steps since the call began have doubled (it reads the counting
 *              runtime's running total; on the plain build it does nothing). Everything the call
 *              ran is in those steps, its callees too, so it is "this function got twice as slow".
 *   quadratic  inside the loop of the function that runs most, one more pass over the collection
 *              the loop walks (`for (const _ of xs) {}`), its result unused: linear becomes
 *              quadratic in that collection.
 *   alloc      one more object per iteration of that loop, or per call when there is no loop.
 *   cache      a memo is defeated: `if (cache.has(k)) return ...` never takes the hit,
 *              `const hit = cache.get(k)` reads nothing, `x ??= f()` always computes, a lazily
 *              set variable is never read back.
 *
 * Every mutant goes with the twin hook (`hook`): the function hands what it returns, throws or
 * builds to `globalThis[TWIN]` (mutation/twin.ts), so the mutant can be checked against the
 * original on the bench's own inputs. The hook is in the original it is compared with too, so
 * both count it the same.
 *
 * Generators are never mutated, and `double` leaves async functions alone (their steps while they
 * wait are other code's).
 */

export type Operator = 'double' | 'quadratic' | 'alloc' | 'cache';
export const OPERATORS: readonly Operator[] = ['double', 'quadratic', 'alloc', 'cache'];

/** What each operator is called in a sentence. */
export const OPERATOR_WORDS: Record<Operator, string> = {
	double: '2x slowdowns',
	quadratic: 'linear-to-quadratic slowdowns',
	alloc: 'extra allocations',
	cache: 'defeated caches'
};

interface Node {
	type: string;
	start: number;
	end: number;
	[key: string]: unknown;
}

function get(n: Node, k: string): Node | null {
	const v = n[k];
	return v && typeof v === 'object' && !Array.isArray(v) && 'type' in v ? (v as Node) : null;
}

function all(n: Node, k: string): Node[] {
	const v = n[k];
	return Array.isArray(v)
		? (v.filter((x) => x && typeof x === 'object' && 'type' in x) as Node[])
		: [];
}

const FUNCTION_TYPES = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression'
]);
const TS_WRAPPERS = new Set([
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSNonNullExpression',
	'TSTypeAssertion',
	'ParenthesizedExpression'
]);
const LOOP_TYPES = new Set([
	'ForStatement',
	'ForOfStatement',
	'ForInStatement',
	'WhileStatement',
	'DoWhileStatement'
]);
/** Array methods whose callback runs once per element. */
const ITERATING = new Set([
	'forEach',
	'map',
	'filter',
	'reduce',
	'reduceRight',
	'some',
	'every',
	'find',
	'findIndex',
	'findLast',
	'findLastIndex',
	'flatMap'
]);

/** Every child node of `n`, in source order. */
function children(n: Node): Node[] {
	const out: Node[] = [];
	for (const k of Object.keys(n)) {
		if (k === 'type' || k === 'start' || k === 'end' || k === 'parent') continue;
		const v = n[k];
		if (Array.isArray(v)) {
			for (const x of v) if (x && typeof x === 'object' && 'type' in x) out.push(x as Node);
		} else if (v && typeof v === 'object' && 'type' in v) out.push(v as Node);
	}
	return out.sort((a, b) => a.start - b.start);
}

/** Walk `n` in pre-order; `enter` returns false to skip a node's children. */
function walk(n: Node, enter: (n: Node, parent: Node | null) => boolean | void): void {
	const go = (x: Node, parent: Node | null) => {
		if (enter(x, parent) === false) return;
		for (const c of children(x)) go(c, x);
	};
	go(n, null);
}

/** The node under any TypeScript wrapper and parentheses. */
function bare(n: Node): Node {
	let x = n;
	while (TS_WRAPPERS.has(x.type)) x = get(x, 'expression') ?? x;
	return x;
}

/** A side-effect-free path: `xs`, `this.items`, `a.b[0]`, `#x` reads (no call, no computed key). */
function simple_chain(n: Node): boolean {
	const x = bare(n);
	if (x.type === 'Identifier' || x.type === 'ThisExpression') return true;
	if (x.type === 'MemberExpression') {
		const prop = get(x, 'property');
		if (x.computed === true && prop?.type !== 'Literal') return false;
		if (x.optional === true) return false;
		return simple_chain(get(x, 'object')!);
	}
	return false;
}

/** `Object.keys(x)` / `x.keys()` over a simple chain: re-reading it is safe. */
function collection_expr(n: Node): boolean {
	const x = bare(n);
	if (simple_chain(x)) return true;
	if (x.type !== 'CallExpression') return false;
	const callee = get(x, 'callee');
	const args = all(x, 'arguments');
	if (callee?.type !== 'MemberExpression' || callee.computed === true) return false;
	const name = (get(callee, 'property') as { name?: string } | null)?.name;
	const obj = get(callee, 'object')!;
	if (
		obj.type === 'Identifier' &&
		(obj as { name?: string }).name === 'Object' &&
		(name === 'keys' || name === 'values' || name === 'entries') &&
		args.length === 1
	)
		return simple_chain(args[0]);
	return (
		(name === 'keys' || name === 'values' || name === 'entries') &&
		args.length === 0 &&
		simple_chain(obj)
	);
}

/** The `X` of the first `X.length` (or `X.size`) over a simple chain inside `n`. */
function length_of(n: Node | null): { coll: Node; prop: 'length' | 'size' } | null {
	if (!n) return null;
	let found: { coll: Node; prop: 'length' | 'size' } | null = null;
	walk(n, (x) => {
		if (found) return false;
		if (FUNCTION_TYPES.has(x.type)) return false;
		if (x.type === 'MemberExpression' && x.computed !== true) {
			const name = (get(x, 'property') as { name?: string } | null)?.name;
			const obj = get(x, 'object')!;
			if ((name === 'length' || name === 'size') && simple_chain(obj)) {
				found = { coll: obj, prop: name };
				return false;
			}
		}
		return true;
	});
	return found;
}

export interface Loop {
	/** Where the scan or the allocation goes: the start of a block, or a statement to wrap. */
	at: { pos: number; wrap_end: number | null; arrow_expr: Node | null };
	/** The collection's text, and how to walk it again. */
	coll: string | null;
	walk: 'of' | 'in' | 'index' | null;
	line: number;
	end_line: number;
	/** The lines of its body: what runs once per iteration. */
	body_lines: [number, number];
	what: string;
}

export interface CacheSite {
	start: number;
	end: number;
	text: string;
	line: number;
	what: string;
}

export interface PlannedFunction {
	/** `module > path`, as the counting transform names it. */
	id: string;
	path: string;
	line: number;
	end_line: number;
	async: boolean;
	generator: boolean;
	ctor: boolean;
	params: string[];
	/** Why it cannot be mutated at all (no body, a generator), or null. */
	skip: string | null;
	/** The operators that apply to it. */
	applies: Operator[];
	/** The loops of its own body (not of the functions inside it), and its memo sites. */
	loops: Loop[];
	caches: CacheSite[];
	node: Node;
}

export interface ModulePlan {
	module: string;
	source: string;
	/** Identifier prefix that occurs nowhere in the source. */
	p: string;
	functions: PlannedFunction[];
	/** Functions of the inventory that are not where it says (listed, never guessed). */
	unmatched: string[];
}

function param_names(fn: Node): string[] {
	return all(fn, 'params').map((p, i) => {
		let x: Node = p;
		if (x.type === 'TSParameterProperty') x = get(x, 'parameter') ?? x;
		if (x.type === 'AssignmentPattern') x = get(x, 'left') ?? x;
		const rest = x.type === 'RestElement';
		if (rest) x = get(x, 'argument') ?? x;
		if (x.type === 'Identifier') return (rest ? '...' : '') + String((x as { name?: string }).name);
		return `arg${i}`;
	});
}

/** The statements of a function's own body, walked without entering the functions inside it. */
function own_walk(fn: Node, enter: (n: Node, parent: Node | null) => boolean | void): void {
	const body = get(fn, 'body');
	if (!body) return;
	walk(body, (n, parent) => {
		if (FUNCTION_TYPES.has(n.type)) return false;
		if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') return false;
		return enter(n, parent);
	});
}

/** Where a block-or-statement body takes inserted code. */
function insertion_of(body: Node): Loop['at'] {
	if (body.type === 'BlockStatement')
		return { pos: body.start + 1, wrap_end: null, arrow_expr: null };
	return { pos: body.start, wrap_end: body.end, arrow_expr: null };
}

function loops_of(fn: Node, source: string, pos: Positions): Loop[] {
	const out: Loop[] = [];
	const t = (n: Node) => source.slice(n.start, n.end);
	const line = (o: number) => pos.generated(o).line;
	own_walk(fn, (n) => {
		if (LOOP_TYPES.has(n.type)) {
			const body = get(n, 'body')!;
			let coll: Node | null = null;
			let how: Loop['walk'] = null;
			if (n.type === 'ForOfStatement' && n.await !== true) {
				const right = get(n, 'right')!;
				if (collection_expr(right)) {
					coll = right;
					how = 'of';
				}
			} else if (n.type === 'ForInStatement') {
				const right = get(n, 'right')!;
				if (simple_chain(right)) {
					coll = right;
					how = 'in';
				}
			} else {
				const l =
					length_of(get(n, 'test')) ??
					(n.type === 'ForStatement' ? length_of(get(n, 'init')) : null);
				if (l) {
					coll = l.coll;
					how = l.prop === 'length' ? 'index' : 'of';
				}
			}
			out.push({
				at: insertion_of(body),
				coll: coll ? t(coll) : null,
				walk: how,
				line: line(n.start),
				end_line: line(n.end - 1),
				body_lines: [line(body.start), line(body.end - 1)],
				what: coll ? `the loop over \`${t(coll)}\`` : 'the loop'
			});
			return true;
		}
		if (n.type === 'CallExpression') {
			const callee = get(n, 'callee');
			const cb = all(n, 'arguments')[0];
			if (
				callee?.type === 'MemberExpression' &&
				callee.computed !== true &&
				callee.optional !== true &&
				ITERATING.has(String((get(callee, 'property') as { name?: string } | null)?.name)) &&
				cb &&
				(cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression') &&
				cb.async !== true &&
				cb.generator !== true
			) {
				const obj = get(callee, 'object')!;
				const body = get(cb, 'body')!;
				const name = String((get(callee, 'property') as { name?: string }).name);
				out.push({
					at:
						body.type === 'BlockStatement'
							? { pos: body.start + 1, wrap_end: null, arrow_expr: null }
							: { pos: body.start, wrap_end: body.end, arrow_expr: body },
					coll: simple_chain(obj) ? t(obj) : null,
					walk: simple_chain(obj) ? 'of' : null,
					line: line(n.start),
					end_line: line(n.end - 1),
					body_lines: [line(body.start), line(body.end - 1)],
					what: simple_chain(obj)
						? `the \`${t(obj)}.${name}\` callback`
						: `the \`.${name}\` callback`
				});
			}
		}
		return true;
	});
	return out;
}

/** `undefined !== v`, `v != null`, `v`: the name tested for a hit, or null. */
function hit_test(test: Node, source: string): string | null {
	const x = bare(test);
	if (simple_chain(x)) return source.slice(x.start, x.end);
	if (x.type === 'BinaryExpression' && ['!==', '!='].includes(String(x.operator))) {
		const l = bare(get(x, 'left')!);
		const r = bare(get(x, 'right')!);
		const empty = (n: Node) =>
			(n.type === 'Identifier' && (n as { name?: string }).name === 'undefined') ||
			(n.type === 'Literal' && (n as { value?: unknown }).value === null);
		if (empty(r) && simple_chain(l)) return source.slice(l.start, l.end);
		if (empty(l) && simple_chain(r)) return source.slice(r.start, r.end);
	}
	return null;
}

/** The statement(s) an `if` takes, as a list. */
function branch(n: Node | null): Node[] {
	if (!n) return [];
	return n.type === 'BlockStatement' ? all(n, 'body') : [n];
}

function returns_text(stmts: Node[], source: string, text: string | null): boolean {
	return stmts.some((s) => {
		if (s.type !== 'ReturnStatement') return false;
		if (text === null) return true;
		const a = get(s, 'argument');
		return a !== null && source.slice(bare(a).start, bare(a).end) === text;
	});
}

function method_call(n: Node, name: string): Node | null {
	const x = bare(n);
	if (x.type !== 'CallExpression') return null;
	const callee = get(x, 'callee');
	if (callee?.type !== 'MemberExpression' || callee.computed === true) return null;
	if ((get(callee, 'property') as { name?: string } | null)?.name !== name) return null;
	return simple_chain(get(callee, 'object')!) ? x : null;
}

function declared_in(fn: Node): Set<string> {
	const out = new Set<string>();
	for (const p of param_names(fn)) out.add(p.replace(/^\.\.\./, ''));
	own_walk(fn, (n) => {
		if (n.type === 'VariableDeclarator') {
			walk(get(n, 'id')!, (x) => {
				if (x.type === 'Identifier') out.add(String((x as { name?: string }).name));
			});
		}
	});
	return out;
}

function caches_of(fn: Node, source: string, pos: Positions): CacheSite[] {
	const out: CacheSite[] = [];
	const t = (n: Node) => source.slice(n.start, n.end);
	const line = (o: number) => pos.generated(o).line;
	const local = declared_in(fn);
	/** Texts assigned with `=` somewhere in the function. */
	const assigned = new Set<string>();
	own_walk(fn, (n) => {
		if (n.type === 'AssignmentExpression' && n.operator === '=')
			assigned.add(t(bare(get(n, 'left')!)));
	});
	own_walk(fn, (n) => {
		if (n.type === 'IfStatement') {
			const test = get(n, 'test')!;
			const cons = branch(get(n, 'consequent'));
			const has = method_call(test, 'has');
			if (has && returns_text(cons, source, null)) {
				out.push({
					start: test.start,
					end: test.end,
					text: 'false',
					line: line(test.start),
					what: `\`${t(test)}\` never hits`
				});
				return true;
			}
			const neg = bare(test);
			if (neg.type === 'UnaryExpression' && neg.operator === '!') {
				const inner = method_call(get(neg, 'argument')!, 'has');
				if (inner) {
					const obj = t(get(get(inner, 'callee')!, 'object')!);
					const fills = cons.some(
						(s) => s.type === 'ExpressionStatement' && t(s).startsWith(`${obj}.set(`)
					);
					if (fills) {
						out.push({
							start: test.start,
							end: test.end,
							text: 'true',
							line: line(test.start),
							what: `\`${t(test)}\` always misses`
						});
						return true;
					}
				}
			}
			const name = hit_test(test, source);
			if (
				name !== null &&
				returns_text(cons, source, name) &&
				assigned.has(name) &&
				!local.has(name.split('.')[0])
			) {
				out.push({
					start: test.start,
					end: test.end,
					text: 'false',
					line: line(test.start),
					what: `\`${name}\` is never read back`
				});
			}
			return true;
		}
		if (n.type === 'VariableDeclaration' || n.type === 'BlockStatement' || n.type === 'Program') {
			// `const hit = cache.get(k); if (hit !== undefined) return hit;`
			return true;
		}
		if (n.type === 'AssignmentExpression' && (n.operator === '??=' || n.operator === '||=')) {
			const left = bare(get(n, 'left')!);
			const outer =
				left.type === 'MemberExpression' ||
				(left.type === 'Identifier' && !local.has(String((left as { name?: string }).name)));
			if (outer) {
				const op = source.indexOf(String(n.operator), left.end);
				out.push({
					start: op,
					end: op + String(n.operator).length,
					text: '=',
					line: line(n.start),
					what: `\`${t(left)} ${String(n.operator)}\` always computes`
				});
			}
		}
		return true;
	});
	// `const v = c.get(k)` followed by `if (v) return v`, in one statement list
	own_walk(fn, (n) => {
		const list = n.type === 'BlockStatement' ? all(n, 'body') : null;
		if (!list) return true;
		for (let i = 0; i + 1 < list.length; i++) {
			const d = list[i];
			if (d.type !== 'VariableDeclaration') continue;
			for (const dec of all(d, 'declarations')) {
				const id = get(dec, 'id');
				const init = get(dec, 'init');
				if (id?.type !== 'Identifier' || !init || !method_call(init, 'get')) continue;
				const name = String((id as { name?: string }).name);
				const next = list.slice(i + 1).find((s) => s.type === 'IfStatement');
				if (!next) continue;
				if (hit_test(get(next, 'test')!, source) !== name) continue;
				if (!returns_text(branch(get(next, 'consequent')), source, name)) continue;
				out.push({
					start: init.start,
					end: init.end,
					text: 'undefined',
					line: line(init.start),
					what: `\`${t(bare(init))}\` reads nothing`
				});
			}
		}
		return true;
	});
	// one site per place, in source order
	const seen = new Set<number>();
	return out
		.filter((c) => (seen.has(c.start) ? false : (seen.add(c.start), true)))
		.sort((a, b) => a.start - b.start);
}

/** Function nodes of a parsed module by `line:col` of their start (as the counting transform records them). */
function function_nodes(program: Node, pos: Positions): Map<string, Node[]> {
	const out = new Map<string, Node[]>();
	walk(program, (n, parent) => {
		if (FUNCTION_TYPES.has(n.type)) {
			const at = pos.generated(n.start);
			const key = `${at.line}:${at.col}`;
			const list = out.get(key) ?? [];
			(n as { __ctor?: boolean }).__ctor =
				parent?.type === 'MethodDefinition' && parent.kind === 'constructor';
			list.push(n);
			out.set(key, list);
		}
		return true;
	});
	return out;
}

export interface InventoryEntry {
	id: string;
	path: string;
	line: number;
	col?: number;
	end_line: number;
}

/** The mutants each function of one module can take. */
export function plan_module(
	module: string,
	file: string,
	source: string,
	functions: readonly InventoryEntry[]
): ModulePlan {
	const lang = file.endsWith('.ts') || file.endsWith('.mts') || file.endsWith('.cts') ? 'ts' : 'js';
	const parsed = parseSync(file, source, { sourceType: 'module', lang, preserveParens: true });
	if (parsed.errors.length > 0)
		throw new Error(`cannot parse ${module}: ${parsed.errors[0].message}`);
	const program = parsed.program as unknown as Node;
	const pos = new Positions(source, null);
	const by_at = function_nodes(program, pos);
	let p = '$hbm$';
	for (let i = 1; source.includes(p); i++) p = `$hbm${i}$`;
	const plan: ModulePlan = { module, source, p, functions: [], unmatched: [] };
	const by_line = new Map<number, Node[]>();
	for (const list of by_at.values())
		for (const n of list) {
			const l = pos.generated(n.start).line;
			by_line.set(l, [...(by_line.get(l) ?? []), n]);
		}
	for (const f of functions) {
		let node = f.col !== undefined ? by_at.get(`${f.line}:${f.col}`)?.[0] : undefined;
		if (!node) {
			const same = (by_line.get(f.line) ?? []).filter(
				(n) => pos.generated(n.end - 1).line === f.end_line
			);
			if (same.length === 1) node = same[0];
		}
		if (!node) {
			plan.unmatched.push(f.id);
			continue;
		}
		const body = get(node, 'body');
		const generator = node.generator === true;
		const is_async = node.async === true;
		const ctor = (node as { __ctor?: boolean }).__ctor === true;
		const pf: PlannedFunction = {
			id: f.id,
			path: f.path,
			line: f.line,
			end_line: f.end_line,
			async: is_async,
			generator,
			ctor,
			params: param_names(node),
			skip: !body ? 'it has no body' : generator ? 'a generator' : null,
			applies: [],
			loops: [],
			caches: [],
			node
		};
		if (pf.skip === null) {
			pf.loops = loops_of(node, source, pos);
			pf.caches = caches_of(node, source, pos);
			if (!is_async) pf.applies.push('double');
			if (pf.loops.some((l) => l.coll !== null)) pf.applies.push('quadratic');
			pf.applies.push('alloc');
			if (pf.caches.length > 0) pf.applies.push('cache');
		}
		plan.functions.push(pf);
	}
	return plan;
}

/**
 * The loop a mutant goes into: the one whose body ran the most steps in the base count, else the
 * first (a loop the cases never enter is picked only when no loop ran).
 */
export function pick_loop(
	loops: readonly Loop[],
	steps_at: (line: number) => number,
	want_collection: boolean
): Loop | null {
	let best: Loop | null = null;
	let best_steps = -1;
	for (const l of loops) {
		if (want_collection && l.coll === null) continue;
		let s = 0;
		for (let i = l.body_lines[0]; i <= l.body_lines[1]; i++) s += steps_at(i);
		if (s > best_steps) {
			best = l;
			best_steps = s;
		}
	}
	return best;
}

export interface Mutant {
	operator: Operator;
	/** The line the added work is on. */
	line: number;
	/** What the mutant does, in words. */
	what: string;
	/** The loop's collection (quadratic). */
	collection: string | null;
	loop: Loop | null;
}

/** The mutant of one operator for a function (null when the operator does not apply). */
export function make_mutant(
	f: PlannedFunction,
	operator: Operator,
	steps_at: (line: number) => number
): Mutant | null {
	if (!f.applies.includes(operator)) return null;
	if (operator === 'double') {
		return {
			operator,
			line: f.line,
			what: 'every call costs twice its steps',
			collection: null,
			loop: null
		};
	}
	if (operator === 'quadratic') {
		const l = pick_loop(f.loops, steps_at, true)!;
		return {
			operator,
			line: l.line,
			what: `one more pass over \`${l.coll}\` per iteration of ${l.what}`,
			collection: l.coll,
			loop: l
		};
	}
	if (operator === 'alloc') {
		const l = pick_loop(f.loops, steps_at, false);
		return l
			? {
					operator,
					line: l.line,
					what: `one more object per iteration of ${l.what}`,
					collection: null,
					loop: l
				}
			: { operator, line: f.line, what: 'one more object per call', collection: null, loop: null };
	}
	const first = f.caches[0];
	return {
		operator,
		line: first.line,
		what: f.caches.map((c) => c.what).join(', '),
		collection: null,
		loop: null
	};
}

interface Insert {
	pos: number;
	text: string;
	/** Same position: lower first. */
	order: number;
}

interface Replace {
	start: number;
	end: number;
	text: string;
}

class Patch {
	inserts: Insert[] = [];
	replaces: Replace[] = [];
	insert(pos: number, text: string, order = 0): void {
		this.inserts.push({ pos, text, order });
	}
	replace(start: number, end: number, text: string): void {
		this.replaces.push({ start, end, text });
	}
	apply(source: string): string {
		const ins = [...this.inserts].sort((a, b) => a.pos - b.pos || a.order - b.order);
		const rep = [...this.replaces].sort((a, b) => a.start - b.start);
		for (const r of rep) {
			if (ins.some((i) => i.pos > r.start && i.pos < r.end))
				throw new Error('heisenbench mutate: an insertion falls inside a replaced range');
		}
		let out = '';
		let at = 0;
		let ri = 0;
		let ii = 0;
		while (ii < ins.length || ri < rep.length) {
			const next_i = ii < ins.length ? ins[ii].pos : Infinity;
			const next_r = ri < rep.length ? rep[ri].start : Infinity;
			if (next_i <= next_r) {
				out += source.slice(at, next_i) + ins[ii].text;
				at = Math.max(at, next_i);
				ii++;
			} else {
				out += source.slice(at, next_r) + rep[ri].text;
				at = rep[ri].end;
				ri++;
			}
		}
		const result = out + source.slice(at);
		if (result.split('\n').length !== source.split('\n').length)
			throw new Error('heisenbench mutate: a rewrite changed the line count');
		return result;
	}
}

/** The returns of a function's own body (not of the functions inside it). */
function own_returns(fn: Node): Node[] {
	const out: Node[] = [];
	own_walk(fn, (n) => {
		if (n.type === 'ReturnStatement') out.push(n);
		return true;
	});
	return out;
}

/**
 * One module's source with function `f` hooked for the twin check and, when `mutant` is given,
 * mutated. `hook` false: the mutant alone (what growth counts).
 */
export function rewrite(
	plan: ModulePlan,
	f: PlannedFunction,
	mutant: Mutant | null,
	hook: boolean
): string {
	const { p, source } = plan;
	const patch = new Patch();
	const fn = f.node;
	const body = get(fn, 'body')!;
	const expr = body.type !== 'BlockStatement';
	const id = JSON.stringify(f.id);
	const tw = `${p}tw`;
	const double = mutant?.operator === 'double';

	let pro = '';
	if (hook) pro += `const ${tw}=globalThis[Symbol.for('heisenbench.mutation.twin')];`;
	// The depth of the mutant's own calls lives on globalThis (no module-level code is added): only
	// the outermost call doubles, so a recursive function costs twice its steps, not 2^depth times.
	if (double)
		pro += `const ${p}rt=globalThis[Symbol.for('heisenbench.runtime')],${p}t0=${p}rt?${p}rt.s[0]:0,${p}k=Symbol.for('heisenbench.mutation.depth');globalThis[${p}k]=(globalThis[${p}k]|0)+1;`;
	if (mutant?.operator === 'alloc' && mutant.loop === null) pro += `const ${p}a={n:0};`;
	const needs_try = hook || double;
	const catch_text = hook ? `catch(${p}x){${tw}(${id},${p}x,'t');throw ${p}x}` : '';
	const finally_text = double
		? `finally{if(--globalThis[${p}k]===0&&${p}rt){const ${p}e=2*${p}rt.s[0]-${p}t0;while(${p}rt.s[0]<${p}e){}}}`
		: '';
	const fallthrough = hook ? (f.ctor ? `${tw}(${id},this,'c');` : `${tw}(${id},undefined);`) : '';
	if (expr) {
		const open = '{' + pro + (needs_try ? 'try{' : '') + 'return ' + (hook ? `${tw}(${id},(` : '(');
		const close =
			(hook ? '))' : ')') + ';' + (needs_try ? '}' + catch_text + finally_text : '') + '}';
		patch.insert(body.start, open, -10);
		patch.insert(body.end, close, 10);
	} else {
		patch.insert(body.start + 1, pro + (needs_try ? 'try{' : ''), -10);
		patch.insert(
			body.end - 1,
			fallthrough + (needs_try ? '}' + catch_text + finally_text : ''),
			10
		);
		if (hook) {
			for (const r of own_returns(fn)) {
				const a = get(r, 'argument');
				if (a) {
					patch.insert(a.start, `${tw}(${id},(`, -5);
					patch.insert(a.end, '))', 5);
				} else {
					patch.insert(r.start + 'return'.length, ` ${tw}(${id},undefined)`, 0);
				}
			}
		}
	}
	if (mutant && (mutant.operator === 'quadratic' || mutant.operator === 'alloc') && mutant.loop) {
		const l = mutant.loop;
		let text: string;
		if (mutant.operator === 'alloc') text = `const ${p}a={n:0};`;
		else if (l.walk === 'in') text = `for(const ${p}q in ${l.coll}){}`;
		else if (l.walk === 'index') text = `for(let ${p}j=0;${p}j<(${l.coll}).length;${p}j++){}`;
		else text = `for(const ${p}q of ${l.coll}){}`;
		if (l.at.arrow_expr) {
			patch.insert(l.at.pos, `{${text}return (`, -1);
			patch.insert(l.at.wrap_end!, ');}', 1);
		} else if (l.at.wrap_end !== null) {
			patch.insert(l.at.pos, `{${text}`, -1);
			patch.insert(l.at.wrap_end, '}', 1);
		} else {
			patch.insert(l.at.pos, text, 1);
		}
	}
	if (mutant?.operator === 'cache') {
		for (const c of f.caches) patch.replace(c.start, c.end, c.text);
	}
	return patch.apply(source);
}
