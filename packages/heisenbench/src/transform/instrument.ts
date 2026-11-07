import MagicString from 'magic-string';
import { parseSync } from 'oxc-parser';
import remapping from '@jridgewell/remapping';
import type { SourceMapInput } from '@jridgewell/trace-mapping';
import { Positions } from './positions.ts';
import { OP_INDEX, OP_KINDS, builtin_names, op_price_vector } from '../prices.ts';
import type { OpKind, Prices } from '../prices.ts';
import {
	ASYNC_FUNCTION_OBJECT,
	CLASS,
	KNOWN_CONSTRUCTORS,
	PROMISE,
	REGEXP,
	array_bytes,
	bound_bytes,
	closure_bytes,
	generator_bytes,
	object_bytes
} from '../layout.ts';
import { META_SCHEMA } from '../meta.ts';
import type {
	BlockMeta,
	BuiltinSiteMeta,
	FunctionKind,
	FunctionMeta,
	ModuleMeta,
	SiteKind,
	SiteMeta
} from '../meta.ts';

/*
 * The counting transform (spec 1).
 *
 * Every function gets a frame for the shadow call stack and every basic block a counter:
 *
 *   function f(a) { const r = R.enter(F+3); try { c[7]++, s[0] += 12; ...body } finally { R.exit(r) } }
 *
 * `c` is the module's Float64Array of block counts, `s` the one-slot running step total (used for
 * inclusive steps). Short-circuit parts of expressions are blocks too: `a && (c[8]++, b)`.
 * Optional chains count through `R.opt(c, i, price, obj)?.x`; awaits and yields save and restore
 * the shadow stack: `R.resume(r, await R.suspend(r, x))`.
 *
 * Every edit is created in pre-order and applied after the walk, when block prices are known:
 * opening text with appendRight (outer first), closing text with prependLeft (inner first).
 */

/** A loose ESTree node from oxc-parser. Fields are read through the helpers below. */
interface Node {
	type: string;
	start: number;
	end: number;
	[key: string]: unknown;
}

function get(node: Node, key: string): Node | null {
	const v = node[key];
	return v && typeof v === 'object' && 'type' in v ? (v as Node) : null;
}

function list(node: Node, key: string): Array<Node | null> {
	const v = node[key];
	return Array.isArray(v) ? (v as Array<Node | null>) : [];
}

function text(node: Node, key: string): string {
	const v = node[key];
	return typeof v === 'string' ? v : '';
}

function flag(node: Node, key: string): boolean {
	return node[key] === true;
}

function nodes(node: Node, key: string): Node[] {
	return list(node, key).filter((n): n is Node => n !== null);
}

/**
 * Position of the first `token` at or after `from` that is not inside a comment. Only used between
 * two nodes, where code holds nothing but punctuation, whitespace and comments (a comment may
 * contain the token: `() => /** @type {(x: T) => void} *\/ (fn)(x)`).
 */
export function find_token(code: string, token: string, from: number): number {
	let i = from;
	while (i < code.length) {
		if (code.startsWith('/*', i)) {
			const end = code.indexOf('*/', i + 2);
			i = end === -1 ? code.length : end + 2;
		} else if (code.startsWith('//', i)) {
			const end = code.indexOf('\n', i + 2);
			i = end === -1 ? code.length : end + 1;
		} else if (code.startsWith(token, i)) {
			return i;
		} else {
			i++;
		}
	}
	return -1;
}

/** Where an arrow function's `=>` can start: after its parameters, type parameters and return type. */
function arrow_search_start(node: Node): number {
	let at = node.start;
	for (const p of nodes(node, 'params')) at = Math.max(at, p.end);
	for (const k of ['typeParameters', 'returnType']) {
		const t = get(node, k);
		if (t) at = Math.max(at, t.end);
	}
	return at;
}

const SKIP_KEYS = new Set([
	'type',
	'start',
	'end',
	'range',
	'loc',
	'typeAnnotation',
	'typeParameters',
	'returnType',
	'typeArguments',
	'superTypeArguments',
	'implements',
	'decorators'
]);

const TS_EXPRESSION_WRAPPERS = new Set([
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSNonNullExpression',
	'TSTypeAssertion',
	'TSInstantiationExpression',
	'ParenthesizedExpression'
]);

const ARITH = new Set(['+', '-', '*', '/', '%', '**', '<<', '>>', '>>>', '&', '|', '^']);

export interface InstrumentOptions {
	/** Module identity in reports (path relative to the run root). */
	id: string;
	/** File name, used for the parser language and the output source map. */
	filename: string;
	/** Map from `code` back to the original source (compiled .svelte, Vite's TS output). */
	input_map?: SourceMapInput | null;
	prices: Prices;
	prices_hash: string;
	/** Specifier of the per-module virtual import that provides the counters (see virtual.ts). */
	module_specifier: string;
	/** Append `export const __heisenbench = {...}` with every private top-level binding. Default true. */
	expose?: boolean;
	lang?: 'js' | 'jsx' | 'ts' | 'tsx';
	/**
	 * A CommonJS module: parsed as one (sloppy mode, a `return` at the top), it takes its counters
	 * from the runtime (`Runtime.counters`) instead of importing a counter module, names itself by
	 * `__filename` where an ES module says `import.meta.url`, and exports nothing (`expose` off).
	 */
	commonjs?: boolean;
}

export interface InstrumentResult {
	code: string;
	map: ReturnType<MagicString['generateMap']>;
	meta: ModuleMeta;
	/** Where each block (aligned with meta.blocks) starts in the code given to the transform. */
	origins: BlockOrigin[];
}

/**
 * What starts a block, for checking its count against an independent counter (the fuzzer reads
 * V8's block coverage at `start`):
 *
 *   top       the module body
 *   entry     a function body (`start` is the body's first character)
 *   next      the statement after one that may jump or branch (return, if, a loop...)
 *   body      a branch body: if/else, loop body, try, catch, finally
 *   case      the first statement of a switch case
 *   static    a class static block
 *   expr      an expression that runs on its own (`start`..`end`): the right of && || ?? and of
 *             logical assignment, a ternary arm, a loop test or update, a case test, a default
 *             value, an instance field initialiser
 *   optional  the rest of an optional chain (`start` is its `?.`)
 */
export type BlockKind = 'top' | 'entry' | 'next' | 'body' | 'case' | 'static' | 'expr' | 'optional';

export interface BlockOrigin {
	kind: BlockKind;
	start: number;
	end: number;
}

interface FnRec {
	index: number;
	meta: FunctionMeta;
	parent: FnRec | null;
	is_arrow: boolean;
	framed: boolean;
	declared: Set<string>;
	refs: Set<string>;
	uses_arguments: boolean;
	blocks: number;
}

interface BlockRec {
	id: number;
	fn: FnRec;
	index: number;
	line: number;
	col: number;
	ops: number[];
	/** key = line * 64 + op kind */
	line_ops: Map<number, number>;
	origin: BlockOrigin;
}

interface SiteRec {
	index: number;
	meta: SiteMeta;
	block: BlockRec;
	/** Closure sites: the function whose captured variables size the context. */
	closure_of: FnRec | null;
	/** `new X()` sites: constructor name, sized after the walk. */
	new_name: string | null;
	/** `arguments` sites: the function that may use it. */
	arguments_of: FnRec | null;
}

/** A call that may reach a priced built-in (plan_bsite); `k` is its site index once walked. */
interface BsitePlan {
	name: string;
	/** True: the receiver is not captured, the wrapper checks its caller (`site_any`). */
	any: boolean;
	k: number;
	/** The receiver to wrap in `R.rcv(k, ...)` (null with `any`). */
	recv: Node | null;
}

interface Edit {
	pos: number;
	open: boolean;
	text: () => string;
	/** Replace the source from `pos` to `end` with the text (keeping text inserted at `pos`). */
	end?: number;
}

interface Naming {
	path: string;
	used: Map<string, number>;
}

/**
 * What names a function, class or object literal that has no name of its own. `named`: the binding,
 * key or assignment target the language names it after (`const f = () => {}`, `{ f() {} }`). `slot`:
 * only the place it sits in, argument `i` of a call to `sort` (`sort:0`) or nothing at all
 * (`<anonymous>`). One function can hold many functions in one slot (every `sort` callback), so a
 * slot name is completed by the function's shape hash (see `name_path`).
 */
interface Hint {
	name: string;
	slot: boolean;
}

const named = (name: string): Hint => ({ name, slot: false });

class Instrumenter {
	code: string;
	opts: InstrumentOptions;
	pos: Positions;
	prices: Float64Array;
	builtin_names: Set<string>;
	n: { c: string; d: string; f: string; b: string; s: string; R: string; r: string; u: string };

	fns: FnRec[] = [];
	blocks: BlockRec[] = [];
	sites: SiteRec[] = [];
	bsites: BuiltinSiteMeta[] = [];
	edits: Edit[] = [];
	naming: Naming[] = [{ path: '', used: new Map() }];
	shapes = new Map<Node, number>();
	zero_args = new Map<Node, Array<() => string>>();
	class_fields = new Map<string, number>();

	fn!: FnRec;
	block!: BlockRec;
	scope_block: BlockRec | null = null;
	/** Disposal scope variable of the statement list being walked (`await using`), if any. */
	using: string | null = null;
	using_count = 0;
	/** Start of the labels in front of the statement being walked (see take_label). */
	label_start: number | null = null;

	constructor(code: string, opts: InstrumentOptions) {
		this.code = code;
		this.opts = opts;
		this.pos = new Positions(code, opts.input_map);
		this.prices = op_price_vector(opts.prices);
		this.builtin_names = new Set(builtin_names(opts.prices));
		let p = '$a$';
		for (let i = 1; code.includes(p); i++) p = `$a${i}$`;
		this.n = {
			c: p + 'c',
			d: p + 'd',
			f: p + 'f',
			b: p + 'b',
			s: p + 's',
			R: p + 'R',
			r: p + 'r',
			u: p + 'u'
		};
	}

	/** The module's meta, once `finalize` made it (the CommonJS header embeds it). */
	meta: ModuleMeta | null = null;

	/** What the module says where a call site names its own module (`site_any`). */
	self_url(): string {
		return this.opts.commonjs ? this.n.u : 'import.meta.url';
	}

	// ---------------------------------------------------------------- records

	new_fn(
		path: string,
		kind: FunctionKind,
		node: Node,
		o: { async?: boolean; generator?: boolean; arrow?: boolean; framed: boolean }
	): FnRec {
		const at = this.pos.original(node.start);
		const end = this.pos.original(Math.max(node.start, node.end - 1));
		const f: FnRec = {
			index: this.fns.length,
			meta: {
				path,
				line: at.line,
				col: at.col,
				end_line: end.line,
				kind,
				async: o.async ?? false,
				generator: o.generator ?? false
			},
			parent: this.fns.length === 0 ? null : this.fn,
			is_arrow: o.arrow ?? false,
			framed: o.framed,
			declared: new Set(),
			refs: new Set(),
			uses_arguments: false,
			blocks: 0
		};
		this.fns.push(f);
		return f;
	}

	new_block(offset: number, kind: BlockKind, end = offset): BlockRec {
		const at = this.pos.original(offset);
		const b: BlockRec = {
			id: this.blocks.length,
			fn: this.fn,
			index: this.fn.blocks++,
			line: at.line,
			col: at.col,
			ops: Array.from({ length: OP_KINDS.length }, () => 0),
			line_ops: new Map(),
			origin: { kind, start: offset, end }
		};
		this.blocks.push(b);
		return b;
	}

	price(b: BlockRec): number {
		let p = 0;
		for (let i = 0; i < b.ops.length; i++) p += b.ops[i] * this.prices[i];
		return Math.round(p * 1e6) / 1e6;
	}

	op(kind: OpKind, offset: number, count = 1, block: BlockRec = this.block): void {
		this.op_at_line(kind, this.pos.original(offset).line, count, block);
	}

	op_at_line(kind: OpKind, line: number, count: number, block: BlockRec): void {
		const k = OP_INDEX[kind];
		block.ops[k] += count;
		const key = line * 64 + k;
		block.line_ops.set(key, (block.line_ops.get(key) ?? 0) + count);
	}

	site(
		kind: SiteKind,
		offset: number,
		bytes: number,
		dynamic: boolean,
		alloc = true,
		block: BlockRec = this.block
	): SiteRec {
		const at = this.pos.original(offset);
		const rec: SiteRec = {
			index: this.sites.length,
			meta: {
				fn: block.fn.index,
				block: block.id,
				kind,
				line: at.line,
				col: at.col,
				bytes,
				dynamic,
				alloc
			},
			block,
			closure_of: null,
			new_name: null,
			arguments_of: null
		};
		this.sites.push(rec);
		if (alloc) this.op_at_line('alloc', at.line, 1, block);
		return rec;
	}

	// ---------------------------------------------------------------- edits

	open(pos: number, t: () => string): void {
		this.edits.push({ pos, open: true, text: t });
	}

	close(pos: number, t: () => string): void {
		this.edits.push({ pos, open: false, text: t });
	}

	counter_expr(b: BlockRec): string {
		const p = this.price(b);
		const c = `${this.n.c}[${b.id}]++`;
		return p === 0 ? c : `${c},${this.n.s}[0]+=${p}`;
	}

	counter_stmt(b: BlockRec): string {
		return this.counter_expr(b) + ';';
	}

	/**
	 * Put an expression in an argument of a runtime call: `R.f(...,` + node + `)`. The parser drops
	 * parentheses, so a comma expression (`(a, b)`) gets its own back, or it would become two
	 * arguments.
	 */
	as_arg(node: Node, open: () => string, close: () => string = () => ')'): void {
		const seq = node.type === 'SequenceExpression';
		this.open(node.start, () => open() + (seq ? '(' : ''));
		this.close(node.end, () => (seq ? ')' : '') + close());
	}

	/** Start a block whose counter is a statement inserted at `pos`. */
	start_block_at(
		pos: number,
		origin: number,
		prefix?: () => string,
		kind: BlockKind = 'next'
	): BlockRec {
		const b = this.new_block(origin, kind);
		this.block = b;
		this.open(pos, () => (prefix ? prefix() : '') + this.counter_stmt(b));
		if (this.scope_block === null) this.scope_block = b;
		return b;
	}

	/**
	 * Wrap an expression so it counts a block of its own: `(c[i]++, expr)`.
	 *
	 * `naming`: the expression sits where the language names an anonymous function or class after
	 * its target (`#f = () => {}` is named `#f`, `x = () => {}` as a default value `x`). Wrapped in
	 * a comma it would lose that name, so it is wrapped as `(c[i]++, {"#f": () => {}}["#f"])`,
	 * which names it the same way.
	 */
	expr_block(node: Node, hint?: Hint, naming?: string | null): BlockRec {
		const prev = this.block;
		const b = this.new_block(node.start, 'expr', node.end);
		const named = naming != null && is_anonymous_definition(node);
		const key = named ? JSON.stringify(naming) : '';
		this.open(node.start, () => `(${this.counter_expr(b)},${named ? `{${key}:` : ''}`);
		this.close(node.end, () => (named ? `}[${key}])` : ')'));
		this.block = b;
		this.walk_expr(node, hint);
		this.block = prev;
		return b;
	}

	/** Extra arguments spread into an empty argument list: `f(...R.site_zero(k))`. */
	add_zero_arg(call: Node, piece: () => string): void {
		let pieces = this.zero_args.get(call);
		if (!pieces) {
			const ps: Array<() => string> = [];
			pieces = ps;
			this.zero_args.set(call, ps);
			this.open(call.end - 1, () => ps.map((p) => p()).join(','));
		}
		pieces.push(piece);
	}

	// ---------------------------------------------------------------- naming

	/**
	 * The path of a function, class or object literal named `name` in the current scope. An id must
	 * not move when unrelated code does, so it never counts its siblings unless it has to:
	 *
	 *   a name the language gives (`f`, `Router`, `match`) is the id, as long as it is the first of
	 *   that name in the scope; a later one of the same name adds its shape hash (`f~3fa9c2`)
	 *
	 *   a slot (`sort:0`, `<anonymous>`) always adds its shape hash: one function holds many `sort`
	 *   callbacks, and a new one before the others must not rename them
	 *
	 * Only functions alike in name AND shape (two identical callbacks) are told apart by order:
	 * `sort:0~3fa9c2#2`. `shape_hash` is over the syntax tree, so formatting, comments and types
	 * do not move it; an edit to the function's own code does, and the diff and the gate pair it by
	 * its context (identity.ts `context_path`).
	 */
	name_path(name: string, node: Node, slot: boolean): string {
		const top = this.naming[this.naming.length - 1];
		let unique = name;
		if (slot || top.used.has(name)) unique = `${name}~${this.shape_hash(node)}`;
		else top.used.set(name, 1);
		if (unique !== name) {
			const seen = top.used.get(unique) ?? 0;
			top.used.set(unique, seen + 1);
			if (seen > 0) unique = `${unique}#${seen + 1}`;
		}
		return top.path ? `${top.path} > ${unique}` : unique;
	}

	/** Six hex digits of the node's syntax tree: see `shape_of`. Memoized: nested ids reuse it. */
	shape_hash(node: Node): string {
		const h = shape_of(node, this.shapes);
		return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
	}

	key_name(key: Node | null, computed: boolean): string {
		if (!key) return '<anonymous>';
		if (key.type === 'Literal') return String(key.value);
		if (!computed) {
			if (key.type === 'Identifier') return text(key, 'name');
			if (key.type === 'PrivateIdentifier') return '#' + text(key, 'name');
		}
		return '[computed]';
	}

	callee_name(callee: Node): string {
		if (callee.type === 'Identifier') return text(callee, 'name');
		if (callee.type === 'MemberExpression' && !flag(callee, 'computed')) {
			const p = get(callee, 'property');
			if (p) return text(p, 'name');
		}
		if (callee.type === 'Super') return 'super';
		return 'call';
	}

	// ---------------------------------------------------------------- scope

	declare(name: string): void {
		this.fn.declared.add(name);
	}

	ref(name: string): void {
		this.fn.refs.add(name);
		if (name === 'arguments') {
			let f: FnRec | null = this.fn;
			while (f && f.is_arrow) f = f.parent;
			if (f && f.meta.kind === 'function') f.uses_arguments = true;
		}
	}

	// ---------------------------------------------------------------- program

	run(program: Node): void {
		const top = this.new_fn('<top>', 'top', program, { framed: false });
		this.fn = top;
		const body = nodes(program, 'body');
		let first = 0;
		while (first < body.length && typeof body[first].directive === 'string') first++;
		const header_pos = first < body.length ? body[first].start : this.code.length;
		const n = this.n;
		const spec = JSON.stringify(this.opts.module_specifier);
		this.open(header_pos, () =>
			this.opts.commonjs
				? `const{c:${n.c},d:${n.d},f:${n.f},b:${n.b},s:${n.s},r:${n.R}}=globalThis[Symbol.for("heisenbench.runtime")].counters(${spec},${JSON.stringify(JSON.stringify(this.meta))}),${n.u}=__filename;`
				: `import{c as ${n.c},d as ${n.d},f as ${n.f},b as ${n.b},s as ${n.s},r as ${n.R}}from${spec};`
		);
		this.scope_block = null;
		if (first < body.length) {
			this.start_block_at(header_pos, header_pos, undefined, 'top');
			this.walk_statements(body.slice(first), false);
		} else {
			this.block = this.new_block(header_pos, 'top');
		}
	}

	/** Returns true when the code after the list needs a new block. */
	/**
	 * `scope`: the list is a block scope of its own (not a switch case, whose declarations share
	 * the whole switch), so an `await using` in it can get its own disposal scope.
	 */
	walk_statements(stmts: Array<Node | null>, need_block: boolean, scope = true): boolean {
		const prev_scope = this.scope_block;
		const prev_using = this.using;
		this.scope_block = need_block ? null : this.block;
		this.using = null;
		const present = stmts.filter((s): s is Node => s !== null);
		if (scope && this.suspends() && present.some(is_using)) {
			this.using = this.dispose_scope(present[0].start, present[present.length - 1].end);
		}
		let split = need_block;
		for (const st of stmts) {
			if (!st) continue;
			if (split) {
				this.start_block_at(st.start, st.start);
				split = false;
			}
			if (this.walk_statement(st)) split = true;
		}
		this.scope_block = prev_scope;
		this.using = prev_using;
		return split;
	}

	/** A counted function that can suspend (async or a generator): its frame leaves the stack. */
	suspends(): boolean {
		const f = this.fn;
		return f.framed && (f.meta.async || f.meta.generator);
	}

	/**
	 * Wrap `start..end` in a disposal scope (runtime/dispose.ts) whose awaits suspend and resume
	 * the frame. Returns the scope's variable name; `first` is code to run first inside the try.
	 *
	 * The disposals run in its finally, which first resumes the frame: a generator resumed by
	 * `return()` or `throw()`, or an await that rejects, leaves through the finally without passing
	 * the resume the transform put after the `yield` or `await`. Each disposal awaits exactly what
	 * the language awaits (DisposeScope.step), so concurrent async code interleaves the same; a
	 * rejection is recorded and the next resource still disposed.
	 */
	dispose_scope(start: number, end: number, first?: (u: string) => string): string {
		const u = `${this.n.R}u${this.using_count++}`;
		const { R, r } = this.n;
		const awaits = this.fn.meta.async;
		this.open(start, () => `const ${u}=${R}.scope();try{${first ? first(u) : ''}`);
		this.close(
			end,
			() =>
				`}catch(${u}e){${u}.fail(${u}e)}finally{${R}.resume_if(${r});` +
				(awaits
					? `for(let ${u}p;(${u}p=${u}.step())!==${u};)try{${R}.resume(${r},await ${R}.suspend(${r},${u}p))}catch(${u}x){${R}.resume_if(${r});${u}.record(${u}x)}`
					: `${u}.step();`) +
				`${u}.finish()}`
		);
		return u;
	}

	/** `await using a = A, b = B` -> `const a = u.use(A, true), b = u.use(B, true)`. */
	rewrite_using(decl: Node, u: string): void {
		const awaited = text(decl, 'kind') === 'await using';
		const decls = nodes(decl, 'declarations');
		if (decls.length === 0) return;
		this.edits.push({ pos: decl.start, end: decls[0].start, open: true, text: () => 'const ' });
		for (const d of decls) {
			const init = get(d, 'init');
			if (!init) continue;
			this.as_arg(
				init,
				() => `${u}.use(`,
				() => `,${awaited})`
			);
			if (awaited) this.op('await', d.start);
		}
	}

	/** A branch body (if/else, loop body, catch, finally) is always a block of its own. */
	walk_branch(st: Node, prefix?: () => string, before?: () => void): void {
		const prev = this.block;
		if (st.type === 'BlockStatement') {
			this.start_block_at(st.start + 1, st.start, prefix, 'body');
			before?.();
			this.walk_statements(list(st, 'body'), false);
		} else {
			const b = this.new_block(st.start, 'body');
			this.block = b;
			this.open(st.start, () => '{' + (prefix ? prefix() : '') + this.counter_stmt(b));
			this.close(st.end, () => '}');
			before?.();
			this.walk_statement(st);
		}
		this.block = prev;
	}

	/**
	 * First thing in a loop body: stop a run that went past the runtime's step cap (Runtime.cap,
	 * Infinity unless a caller sets one), so an input that makes a loop run forever ends the run.
	 * Function entries check it too (Runtime.enter).
	 */
	cap_check(): () => string {
		return () => `${this.n.s}[0]>${this.n.R}.cap&&${this.n.R}.over();`;
	}

	resume_prefix(): (() => string) | undefined {
		const f = this.fn;
		if (!f.framed || !(f.meta.async || f.meta.generator)) return undefined;
		return () => `${this.n.R}.resume_if(${this.n.r});`;
	}

	/** Start of the labels in front of the statement being walked (null: it has none). */
	take_label(): number | null {
		const at = this.label_start;
		this.label_start = null;
		return at;
	}

	walk_statement(st: Node): boolean {
		// labels belong to the statement right after them, not to statements nested in it
		if (st.type !== 'LabeledStatement' && st.type !== 'ForOfStatement') this.label_start = null;
		switch (st.type) {
			case 'ExpressionStatement': {
				const e = get(st, 'expression');
				if (e) this.walk_expr(e);
				return false;
			}
			case 'VariableDeclaration': {
				if (flag(st, 'declare')) return false;
				const kind = text(st, 'kind');
				if (this.using && (kind === 'await using' || kind === 'using'))
					this.rewrite_using(st, this.using);
				this.walk_var_decl(st);
				return false;
			}
			case 'FunctionDeclaration': {
				if (!get(st, 'body')) return false;
				const id = get(st, 'id');
				if (id) this.declare(text(id, 'name'));
				this.walk_function(st, id ? text(id, 'name') : 'default', this.scope_block ?? this.block);
				return false;
			}
			case 'ClassDeclaration': {
				if (flag(st, 'declare')) return false;
				const id = get(st, 'id');
				if (id) this.declare(text(id, 'name'));
				this.walk_class(st, id ? text(id, 'name') : 'default');
				return false;
			}
			case 'ReturnStatement': {
				const a = get(st, 'argument');
				const f = this.fn;
				if (a && f.framed && f.meta.async && f.meta.generator) {
					// An async generator awaits the value it returns, an await the code does not spell
					// out: the frame is suspended around it (catch and finally blocks resume it).
					const { R, r } = this.n;
					this.as_arg(a, () => `${R}.suspend(${r},`);
					this.op('await', st.start);
				}
				if (a) this.walk_expr(a);
				return true;
			}
			case 'ThrowStatement': {
				const a = get(st, 'argument');
				if (a) this.walk_expr(a);
				this.op('throw', st.start);
				return true;
			}
			case 'BreakStatement':
			case 'ContinueStatement':
				return true;
			case 'BlockStatement':
				return this.walk_statements(list(st, 'body'), false);
			case 'IfStatement': {
				const test = get(st, 'test')!;
				this.walk_expr(test);
				this.op('branch', test.start);
				this.walk_branch(get(st, 'consequent')!);
				const alt = get(st, 'alternate');
				if (alt) this.walk_branch(alt);
				return true;
			}
			case 'ForStatement': {
				const init = get(st, 'init');
				if (init) {
					if (init.type === 'VariableDeclaration') this.walk_var_decl(init);
					else this.walk_expr(init);
				}
				const test = get(st, 'test');
				if (test) {
					const b = this.expr_block(test);
					this.op('branch', test.start, 1, b);
				}
				const update = get(st, 'update');
				if (update) this.expr_block(update);
				this.walk_branch(get(st, 'body')!, this.cap_check());
				return true;
			}
			case 'WhileStatement': {
				const test = get(st, 'test')!;
				const b = this.expr_block(test);
				this.op('branch', test.start, 1, b);
				this.walk_branch(get(st, 'body')!, this.cap_check());
				return true;
			}
			case 'DoWhileStatement': {
				this.walk_branch(get(st, 'body')!, this.cap_check());
				const test = get(st, 'test')!;
				const b = this.expr_block(test);
				this.op('branch', test.start, 1, b);
				return true;
			}
			case 'ForInStatement':
			case 'ForOfStatement':
				this.walk_for_in_of(st, this.take_label());
				return true;
			case 'SwitchStatement': {
				this.walk_expr(get(st, 'discriminant')!);
				const prev = this.block;
				for (const c of nodes(st, 'cases')) {
					const test = get(c, 'test');
					if (test) {
						const b = this.expr_block(test);
						this.op('compare', test.start, 1, b);
					}
					const cons = nodes(c, 'consequent');
					if (cons.length > 0) {
						this.start_block_at(cons[0].start, cons[0].start, undefined, 'case');
						this.walk_statements(cons, false, false);
					}
					this.block = prev;
				}
				return true;
			}
			case 'TryStatement': {
				this.walk_branch(get(st, 'block')!);
				const handler = get(st, 'handler');
				if (handler) {
					const param = get(handler, 'param');
					this.walk_branch(get(handler, 'body')!, this.resume_prefix(), () => {
						if (param) this.walk_pattern(param, 'declare');
					});
				}
				const fin = get(st, 'finalizer');
				if (fin) this.walk_branch(fin, this.resume_prefix());
				return true;
			}
			case 'LabeledStatement':
				// `break label` lands right after the statement: the code there is a block of its own
				this.label_start ??= st.start;
				this.walk_statement(get(st, 'body')!);
				this.label_start = null;
				return true;
			case 'WithStatement':
				this.walk_expr(get(st, 'object')!);
				return this.walk_statement(get(st, 'body')!);
			case 'ExportNamedDeclaration': {
				const d = get(st, 'declaration');
				return d ? this.walk_statement(d) : false;
			}
			case 'ExportDefaultDeclaration': {
				const d = get(st, 'declaration')!;
				if (d.type === 'FunctionDeclaration' || d.type === 'FunctionExpression') {
					if (!get(d, 'body')) return false;
					const id = get(d, 'id');
					if (id) this.declare(text(id, 'name'));
					this.walk_function(d, id ? text(id, 'name') : 'default', this.scope_block ?? this.block);
				} else if (d.type === 'ClassDeclaration' || d.type === 'ClassExpression') {
					const id = get(d, 'id');
					if (id) this.declare(text(id, 'name'));
					this.walk_class(d, id ? text(id, 'name') : 'default');
				} else if (!d.type.startsWith('TS')) {
					this.walk_expr(d, named('default'));
				}
				return false;
			}
			case 'TSExportAssignment': {
				const e = get(st, 'expression');
				if (e) this.walk_expr(e);
				return false;
			}
			case 'ImportDeclaration':
			case 'ExportAllDeclaration':
			case 'EmptyStatement':
			case 'DebuggerStatement':
				return false;
			default:
				if (st.type.startsWith('TS')) return false;
				this.walk_any(st);
				return false;
		}
	}

	walk_var_decl(decl: Node): void {
		for (const d of nodes(decl, 'declarations')) {
			const id = get(d, 'id')!;
			const init = get(d, 'init');
			this.walk_pattern(id, 'declare');
			if (init) {
				this.walk_expr(init, id.type === 'Identifier' ? named(text(id, 'name')) : undefined);
				this.op('assign', d.start);
			}
		}
	}

	/** `label_start`: where the labels in front of the loop start (the loop's own start if none). */
	walk_for_in_of(st: Node, label_start: number | null = null): void {
		const of = st.type === 'ForOfStatement';
		const right = get(st, 'right')!;
		const left = get(st, 'left')!;
		const f = this.fn;
		const is_await = flag(st, 'await') && f.framed && f.meta.async;
		// Outer edits are created before inner ones (see the edit-order note at the top): the
		// resume after the loop must land outside braces the body may get.
		if (is_await) {
			// The loop leaves with the frame suspended: its iterator's return() is awaited when the
			// body breaks, returns or throws. Every way out (a `break` to an outer label too) passes
			// the finally, which resumes it; the labels stay on the loop (`continue label`).
			const { R, r } = this.n;
			this.open(label_start ?? st.start, () => 'try{');
			this.close(st.end, () => `}finally{${R}.resume_if(${r})}`);
			this.as_arg(right, () => `${R}.for_await(${r},`);
		}
		this.walk_expr(right);
		if (of) this.op('iter_init', right.start);
		const body = get(st, 'body')!;
		const resume = is_await ? this.resume_prefix() : undefined;
		const cap = this.cap_check();
		this.walk_branch(
			body,
			() => (resume ? resume() : '') + cap(),
			() => {
				// `for (await using x of xs)`: x is disposed (awaited) after each iteration's body.
				if (of && is_using(left) && this.suspends()) {
					const id = get(nodes(left, 'declarations')[0], 'id')!;
					const block = body.type === 'BlockStatement';
					const awaited = is_await_using(left);
					// the scope's first statement registers the loop variable
					this.dispose_scope(
						block ? body.start + 1 : body.start,
						block ? body.end - 1 : body.end,
						(u) => `${u}.use(${text(id, 'name')},${awaited});`
					);
					this.edits.push({ pos: left.start, end: id.start, open: true, text: () => 'const ' });
					if (awaited) this.op('await', left.start);
				}
				// The iterator protocol step of each iteration is a hidden cost of the body block.
				this.op(of ? 'iter_step' : 'forin_step', left.start);
				if (left.type === 'VariableDeclaration') {
					for (const d of nodes(left, 'declarations')) this.walk_pattern(get(d, 'id')!, 'declare');
				} else {
					this.walk_pattern(left, 'assign');
				}
			}
		);
	}

	// ---------------------------------------------------------------- functions

	walk_function(node: Node, name: string, site_block: BlockRec = this.block, slot = false): FnRec {
		const parent_fn = this.fn;
		const prev_block = this.block;
		const prev_scope = this.scope_block;
		const is_arrow = node.type === 'ArrowFunctionExpression';
		const is_async = flag(node, 'async');
		const is_generator = flag(node, 'generator');
		const closure = this.site('closure', node.start, 0, false, true, site_block);

		const path = this.name_path(name, node, slot);
		const f = this.new_fn(path, 'function', node, {
			async: is_async,
			generator: is_generator,
			arrow: is_arrow,
			framed: true
		});
		closure.closure_of = f;
		this.fn = f;
		this.naming.push({ path, used: new Map() });
		const own_id = get(node, 'id');
		if (own_id && node.type === 'FunctionExpression') this.declare(text(own_id, 'name'));

		const body = get(node, 'body')!;
		const entry = this.new_block(body.start, 'entry');
		this.block = entry;
		this.scope_block = entry;

		const prologue: Array<() => string> = [];
		const { R, d, r } = this.n;
		for (const p of nodes(node, 'params')) {
			if (p.type === 'TSParameterProperty') {
				const inner = get(p, 'parameter');
				if (inner) this.walk_pattern(inner, 'declare');
				continue;
			}
			if (p.type === 'RestElement') {
				const arg = get(p, 'argument')!;
				const rest = this.site('rest', p.start, 0, true);
				if (arg.type === 'Identifier') {
					const nm = text(arg, 'name');
					prologue.push(() => `${R}.rest(${d},${rest.index},${nm}.length);`);
				}
			}
			this.walk_pattern(p, 'declare');
		}
		if (is_async && !is_generator) {
			this.site('promise', node.start, PROMISE + ASYNC_FUNCTION_OBJECT, false);
		}
		const gen_site = is_generator ? this.site('generator', node.start, 0, false) : null;
		if (!is_arrow) {
			// Materialised only when the function already reads `arguments` (decided in finalize).
			const args_site = this.site('arguments', node.start, 0, true, false);
			args_site.arguments_of = f;
			prologue.push(() =>
				f.uses_arguments ? `${R}.args(${d},${args_site.index},arguments.length);` : ''
			);
		}

		const framed_async = is_async || is_generator;
		const enter = framed_async ? 'enter_async' : 'enter';
		const exit = framed_async ? 'exit_async' : 'exit';
		const fid = `${this.n.f}+${f.index}`;
		const head = () =>
			`const ${r}=${R}.${enter}(${fid});try{` +
			this.counter_stmt(entry) +
			prologue.map((p) => p()).join('');
		const tail = () => `}finally{${R}.${exit}(${r})}`;

		if (body.type === 'BlockStatement') {
			const stmts = nodes(body, 'body');
			let first = 0;
			while (first < stmts.length && typeof stmts[first].directive === 'string') first++;
			const at = first > 0 ? stmts[first - 1].end : body.start + 1;
			if (at >= body.end - 1) {
				// An empty body (`() => {}`): head and tail share one position, and closing text
				// would land before opening text there.
				this.open(at, () => head() + tail());
			} else {
				this.open(at, head);
				this.close(body.end - 1, tail);
			}
			this.walk_statements(stmts.slice(first), false);
		} else {
			const arrow = find_token(this.code, '=>', arrow_search_start(node));
			this.open(arrow + 2, () => '{' + head() + 'return(');
			this.close(node.end, () => ')' + tail() + '}');
			this.walk_expr(body);
		}

		if (gen_site) gen_site.meta.bytes = generator_bytes(f.declared.size);

		this.naming.pop();
		this.fn = parent_fn;
		this.block = prev_block;
		this.scope_block = prev_scope;
		return f;
	}

	walk_class(node: Node, name: string, slot = false): void {
		const sup = get(node, 'superClass');
		if (sup) this.walk_expr(sup);
		this.site('class', node.start, CLASS, false);
		const path = this.name_path(name, node, slot);
		this.naming.push({ path, used: new Map() });
		const body = get(node, 'body')!;
		let fields_fn: FnRec | null = null;
		let field_count = 0;
		let ctor_fields = 0;
		for (const m of nodes(body, 'body')) {
			const computed = flag(m, 'computed');
			const key = get(m, 'key');
			if (computed && key) this.walk_expr(key);
			const is_static = flag(m, 'static');
			if (m.type === 'MethodDefinition') {
				const value = get(m, 'value');
				if (!value || !get(value, 'body')) continue;
				const kind = text(m, 'kind');
				let nm = kind === 'constructor' ? 'constructor' : this.key_name(key, computed);
				if (kind === 'get' || kind === 'set') nm = `${kind} ${nm}`;
				if (is_static) nm = `static ${nm}`;
				this.walk_function(value, nm);
				if (kind === 'constructor') ctor_fields = count_this_writes(get(value, 'body')!);
			} else if (m.type === 'PropertyDefinition' || m.type === 'AccessorProperty') {
				if (flag(m, 'declare')) continue;
				const value = get(m, 'value');
				const nm = this.key_name(key, computed);
				if (!is_static) field_count++;
				if (!value) continue;
				if (is_static) {
					// evaluated once, when the class is defined: part of the enclosing block
					this.walk_expr(value, named(nm));
					continue;
				}
				// Instance field initialisers run on every construction: one pseudo-function per class.
				if (!fields_fn)
					fields_fn = this.new_fn(`${path} > <fields>`, 'fields', node, { framed: false });
				const prev_fn = this.fn;
				const prev_block = this.block;
				this.fn = fields_fn;
				this.expr_block(value, named(nm), computed ? null : nm);
				this.fn = prev_fn;
				this.block = prev_block;
			} else if (m.type === 'StaticBlock') {
				const prev = this.block;
				const brace = find_token(this.code, '{', m.start);
				this.start_block_at(brace + 1, m.start, undefined, 'static');
				this.walk_statements(list(m, 'body'), false);
				this.block = prev;
			}
		}
		if (name) this.class_fields.set(name, field_count + ctor_fields);
		this.naming.pop();
	}

	// ---------------------------------------------------------------- patterns

	walk_pattern(node: Node, mode: 'declare' | 'assign'): void {
		switch (node.type) {
			case 'Identifier':
				if (mode === 'declare') this.declare(text(node, 'name'));
				else this.ref(text(node, 'name'));
				return;
			case 'ObjectPattern':
				for (const p of nodes(node, 'properties')) {
					if (p.type === 'RestElement') {
						this.site('object', p.start, object_bytes(0), false);
						this.walk_pattern(get(p, 'argument')!, mode);
						continue;
					}
					const key = get(p, 'key');
					if (flag(p, 'computed') && key) this.walk_expr(key);
					this.op('prop_read', p.start);
					this.walk_pattern(get(p, 'value')!, mode);
				}
				return;
			case 'ArrayPattern': {
				this.op('iter_init', node.start);
				for (const e of list(node, 'elements')) {
					if (!e) continue;
					this.op('iter_step', e.start);
					if (e.type === 'RestElement') this.site('array', e.start, array_bytes(0), false);
					this.walk_pattern(e, mode);
				}
				return;
			}
			case 'AssignmentPattern': {
				const left = get(node, 'left')!;
				this.walk_pattern(left, mode);
				this.op('compare', node.start);
				const name = left.type === 'Identifier' ? text(left, 'name') : undefined;
				this.expr_block(get(node, 'right')!, name === undefined ? undefined : named(name), name);
				return;
			}
			case 'RestElement':
				this.walk_pattern(get(node, 'argument')!, mode);
				return;
			case 'MemberExpression':
				this.walk_expr(get(node, 'object')!);
				if (flag(node, 'computed')) this.walk_expr(get(node, 'property')!);
				this.op('prop_write', node.start);
				return;
			default:
				if (TS_EXPRESSION_WRAPPERS.has(node.type)) {
					this.walk_pattern(get(node, 'expression')!, mode);
					return;
				}
				this.walk_any(node);
		}
	}

	// ---------------------------------------------------------------- expressions

	alloc_site(kind: SiteKind, offset: number, bytes: number, dynamic: boolean): SiteRec {
		return this.site(kind, offset, bytes, dynamic);
	}

	walk_expr(node: Node, hint?: Hint): void {
		switch (node.type) {
			case 'Identifier':
				this.ref(text(node, 'name'));
				return;
			case 'Literal':
				if (node.regex) this.alloc_site('regexp', node.start, REGEXP, false);
				return;
			case 'ThisExpression':
			case 'Super':
			case 'MetaProperty':
			case 'PrivateIdentifier':
				return;
			case 'TemplateLiteral':
				this.walk_template(node, true);
				return;
			case 'TaggedTemplateExpression':
				this.walk_expr(get(node, 'tag')!);
				this.walk_template(get(node, 'quasi')!, false);
				this.op('call', node.start);
				return;
			case 'ArrayExpression':
				this.walk_array(node);
				return;
			case 'ObjectExpression':
				this.walk_object(node, hint);
				return;
			case 'FunctionExpression':
			case 'ArrowFunctionExpression': {
				const id = get(node, 'id');
				const h = hint ?? (id ? named(text(id, 'name')) : { name: '<anonymous>', slot: true });
				this.walk_function(node, h.name, this.block, h.slot);
				return;
			}
			case 'ClassExpression': {
				const id = get(node, 'id');
				const h = hint ?? (id ? named(text(id, 'name')) : { name: '<class>', slot: true });
				this.walk_class(node, h.name, h.slot);
				return;
			}
			case 'CallExpression': {
				const plan = this.plan_bsite(node, false);
				this.walk_expr(get(node, 'callee')!);
				this.walk_call_tail(node, plan);
				return;
			}
			case 'NewExpression': {
				const callee = get(node, 'callee')!;
				this.walk_expr(callee);
				this.walk_args(node, this.callee_name(callee));
				this.op('new', node.start);
				const site = this.alloc_site('new', node.start, object_bytes(0), false);
				site.new_name = callee.type === 'Identifier' ? text(callee, 'name') : null;
				return;
			}
			case 'MemberExpression':
				this.walk_expr(get(node, 'object')!);
				if (flag(node, 'computed')) this.walk_expr(get(node, 'property')!);
				this.op('prop_read', get(node, 'property')!.start);
				return;
			case 'ChainExpression':
				this.walk_chain(node);
				return;
			case 'AssignmentExpression':
				this.walk_assign(node);
				return;
			case 'UpdateExpression': {
				const arg = get(node, 'argument')!;
				if (arg.type === 'MemberExpression') {
					this.walk_expr(get(arg, 'object')!);
					if (flag(arg, 'computed')) this.walk_expr(get(arg, 'property')!);
					this.op('prop_read', arg.start);
					this.op('prop_write', arg.start);
				} else {
					this.walk_pattern(arg, 'assign');
				}
				this.op('update', node.start);
				return;
			}
			case 'UnaryExpression': {
				const arg = get(node, 'argument')!;
				if (text(node, 'operator') === 'delete' && arg.type === 'MemberExpression') {
					this.walk_expr(get(arg, 'object')!);
					if (flag(arg, 'computed')) this.walk_expr(get(arg, 'property')!);
					this.op('prop_write', node.start);
				} else {
					this.walk_expr(arg);
				}
				this.op('unary', node.start);
				return;
			}
			case 'BinaryExpression':
				this.walk_binary(node, false);
				return;
			case 'LogicalExpression':
				this.walk_expr(get(node, 'left')!);
				this.op('logical', node.start);
				this.expr_block(get(node, 'right')!, hint);
				return;
			case 'ConditionalExpression':
				this.walk_expr(get(node, 'test')!);
				this.op('branch', node.start);
				this.expr_block(get(node, 'consequent')!, hint);
				this.expr_block(get(node, 'alternate')!, hint);
				return;
			case 'SequenceExpression':
				for (const e of nodes(node, 'expressions')) this.walk_expr(e);
				return;
			case 'AwaitExpression':
				this.walk_await(node);
				return;
			case 'YieldExpression':
				this.walk_yield(node);
				return;
			case 'ImportExpression':
				this.walk_expr(get(node, 'source')!);
				this.op('call', node.start);
				return;
			default:
				if (TS_EXPRESSION_WRAPPERS.has(node.type)) {
					this.walk_expr(get(node, 'expression')!, hint);
					return;
				}
				if (node.type.startsWith('TS')) return;
				this.walk_any(node);
		}
	}

	walk_any(node: Node): void {
		for (const key in node) {
			if (SKIP_KEYS.has(key)) continue;
			const v = node[key];
			if (Array.isArray(v)) {
				for (const x of v) {
					if (x && typeof x === 'object' && 'type' in x) this.walk_expr(x as Node);
				}
			} else if (v && typeof v === 'object' && 'type' in v) {
				this.walk_expr(v as Node);
			}
		}
	}

	walk_template(node: Node, allocates: boolean): void {
		const exprs = nodes(node, 'expressions');
		for (const e of exprs) this.walk_expr(e);
		if (exprs.length === 0) return;
		this.op('template', node.start, exprs.length);
		if (!allocates) return;
		const s = this.alloc_site('string', node.start, 0, true);
		this.open(node.start, () => `${this.n.R}.str(${this.n.d},${s.index},`);
		this.close(node.end, () => ')');
	}

	walk_array(node: Node): void {
		const elements = list(node, 'elements');
		let fixed = 0;
		let has_spread = false;
		for (const e of elements) {
			if (e && e.type === 'SpreadElement') has_spread = true;
			else fixed++;
		}
		const site = this.alloc_site(
			has_spread ? 'spread_array' : 'array',
			node.start,
			array_bytes(fixed),
			has_spread
		);
		for (const e of elements) {
			if (!e) continue;
			if (e.type === 'SpreadElement') {
				const arg = get(e, 'argument')!;
				// The wrapper's edits before the argument's own (outer first at a shared position).
				this.as_arg(arg, () => `${this.n.R}.spread_iter(${this.n.d},${site.index},`);
				this.walk_expr(arg);
				this.op('iter_init', e.start);
			} else {
				this.walk_expr(e);
			}
		}
	}

	walk_object(node: Node, hint?: Hint): void {
		const props = nodes(node, 'properties');
		let fixed = 0;
		let has_spread = false;
		for (const p of props) {
			if (p.type === 'SpreadElement') has_spread = true;
			else fixed++;
		}
		const site = this.alloc_site(
			has_spread ? 'spread_object' : 'object',
			node.start,
			object_bytes(fixed),
			has_spread
		);
		const pushed = hint !== undefined;
		if (hint !== undefined)
			this.naming.push({ path: this.name_path(hint.name, node, hint.slot), used: new Map() });
		for (const p of props) {
			if (p.type === 'SpreadElement') {
				const arg = get(p, 'argument')!;
				this.as_arg(arg, () => `${this.n.R}.spread_obj(${this.n.d},${site.index},`);
				this.walk_expr(arg);
				continue;
			}
			const computed = flag(p, 'computed');
			const key = get(p, 'key');
			if (computed && key) this.walk_expr(key);
			const value = get(p, 'value')!;
			const kind = text(p, 'kind');
			let nm = this.key_name(key, computed);
			if (kind === 'get' || kind === 'set') nm = `${kind} ${nm}`;
			this.walk_expr(value, named(nm));
		}
		if (pushed) this.naming.pop();
	}

	walk_args(call: Node, callee: string): void {
		const args = list(call, 'arguments');
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			if (!a) continue;
			if (a.type === 'SpreadElement') {
				const arg = get(a, 'argument')!;
				let s: SiteRec | null = null;
				this.as_arg(arg, () => `${this.n.R}.spread_iter(${this.n.d},${s!.index},`);
				this.walk_expr(arg);
				this.op('iter_init', a.start);
				s = this.site('spread_args', a.start, 0, true, false);
			} else {
				this.walk_expr(a, { name: `${callee}:${i}`, slot: true });
			}
		}
	}

	/**
	 * A call that may reach a priced built-in (`x.slice()`, `structuredClone(v)`,
	 * `Array.prototype.map.call(xs, f)`): its built-in name and the receiver the call runs on (the
	 * function itself for `f()` and `f.call()`). The receiver is wrapped in `R.rcv(k, ...)` here,
	 * before anything inside it is walked, so the edit encloses the receiver's own edits. Where
	 * wrapping it would change what the code does (an optional link inside it or on the call, an
	 * `await` in the arguments that lets other calls of the same site interleave, `super`), the
	 * site is announced with `site_any` and the wrapper checks its caller instead.
	 */
	plan_bsite(call: Node, in_chain: boolean): BsitePlan | null {
		const callee = get(call, 'callee')!;
		let name: string | null = null;
		let recv: Node | null = null;
		if (callee.type === 'Identifier') {
			name = text(callee, 'name');
			recv = callee;
		} else if (callee.type === 'MemberExpression' && !flag(callee, 'computed')) {
			name = this.callee_name(callee);
			recv = get(callee, 'object');
			if ((name === 'call' || name === 'apply') && recv) {
				const inner =
					recv.type === 'Identifier' ||
					(recv.type === 'MemberExpression' && !flag(recv, 'computed'))
						? this.callee_name(recv)
						: null;
				if (inner !== null && this.builtin_names.has(inner)) name = inner;
			}
		}
		if (name === null || !this.builtin_names.has(name)) return null;
		let any = recv === null || recv.type === 'Super';
		if (!any && in_chain && (flag(call, 'optional') || has_optional_link(recv!))) any = true;
		if (!any && nodes(call, 'arguments').some(contains_suspend)) any = true;
		const plan: BsitePlan = { name, any, k: -1, recv: any ? null : recv };
		// In a chain the caller wraps the receivers, ordered with the chain's other wrappers.
		if (!in_chain) this.wrap_receiver(plan);
		return plan;
	}

	/** `R.rcv(k, receiver)`: the edit plan_bsite describes (nothing for a `site_any` site). */
	wrap_receiver(plan: BsitePlan): void {
		if (plan.recv === null) return;
		const base = this.n.b;
		this.as_arg(plan.recv, () => `${this.n.R}.rcv(${base}+${plan.k},`);
	}

	/** Everything of a call except its callee: built-in site marking, arguments, `.bind`. */
	walk_call_tail(call: Node, plan: BsitePlan | null): void {
		const callee = get(call, 'callee')!;
		const name = this.callee_name(callee);
		const args = nodes(call, 'arguments');
		const is_member = callee.type === 'MemberExpression' && !flag(callee, 'computed');
		if (plan) {
			const at = this.pos.original(callee.end);
			const k = this.bsites.length;
			plan.k = k;
			this.bsites.push({
				fn: this.fn.index,
				block: this.block.id,
				line: at.line,
				col: at.col,
				name: plan.name
			});
			const base = this.n.b;
			const R = this.n.R;
			const url = plan.any ? `,${this.self_url()}` : '';
			if (args.length === 0) {
				const fn = plan.any ? 'site_any_zero' : 'site_zero';
				this.add_zero_arg(call, () => `...${R}.${fn}(${base}+${k}${url})`);
			} else {
				// The site is set after every argument is evaluated, right before the call.
				const last = args[args.length - 1];
				const target = last.type === 'SpreadElement' ? get(last, 'argument')! : last;
				const fn = plan.any ? 'site_any' : 'site_last';
				this.as_arg(target, () => `${R}.${fn}(${base}+${k}${url},`);
			}
		}
		if (is_member && name === 'bind') {
			this.alloc_site('bound', call.start, bound_bytes(Math.max(0, args.length - 1)), false);
		}
		this.walk_args(call, name);
		this.op('call', callee.end);
	}

	walk_chain(chain: Node): void {
		const links: Node[] = [];
		let cur = get(chain, 'expression')!;
		while (cur.type === 'MemberExpression' || cur.type === 'CallExpression') {
			links.push(cur);
			cur = cur.type === 'MemberExpression' ? get(cur, 'object')! : get(cur, 'callee')!;
		}
		const plans = new Map<Node, BsitePlan | null>();
		for (const link of links)
			if (link.type === 'CallExpression') plans.set(link, this.plan_bsite(link, true));
		links.reverse();
		const prev = this.block;
		const { R, c } = this.n;
		// A `?.` member link wraps its object in `R.opt(...)`, and a built-in call's receiver is
		// wrapped in `R.rcv(...)`. Every one of those starts where the chain does, so they are
		// created outermost (longest) first (see the edit-order note at the top), before the chain's
		// head, which may be a chain of its own (`(a?.b)?.c`). On one node, `rcv` goes outside.
		// The blocks are made below, in the order the links run.
		const opt_blocks = new Map<Node, BlockRec>();
		const wraps: Array<{ end: number; rank: number; make: () => void }> = [];
		for (const link of links) {
			if (link.type === 'MemberExpression' && flag(link, 'optional')) {
				const obj = get(link, 'object')!;
				wraps.push({
					end: obj.end,
					rank: 1,
					make: () =>
						this.as_arg(obj, () => {
							const b = opt_blocks.get(link)!;
							return `${R}.opt(${c},${b.id},${this.price(b)},`;
						})
				});
			}
			const plan = plans.get(link);
			if (plan && plan.recv) {
				const p = plan;
				wraps.push({ end: p.recv!.end, rank: 0, make: () => this.wrap_receiver(p) });
			}
		}
		wraps.sort((a, b) => b.end - a.end || a.rank - b.rank);
		for (const w of wraps) w.make();
		this.walk_expr(cur);
		for (const link of links) {
			if (flag(link, 'optional')) {
				this.op('compare', link.start);
				const inner =
					link.type === 'MemberExpression' ? get(link, 'object')! : get(link, 'callee')!;
				const b = this.new_block(link.start, 'optional');
				b.origin.start = find_token(this.code, '?.', inner.end);
				b.origin.end = link.end;
				if (link.type === 'MemberExpression') {
					opt_blocks.set(link, b);
				} else {
					const args = nodes(link, 'arguments');
					if (args.length > 0) {
						const a0 = args[0].type === 'SpreadElement' ? get(args[0], 'argument')! : args[0];
						this.open(a0.start, () => `(${this.counter_expr(b)},`);
						this.close(a0.end, () => ')');
					} else {
						this.add_zero_arg(link, () => `...${R}.z(${c},${b.id},${this.price(b)})`);
					}
				}
				this.block = b;
			}
			if (link.type === 'MemberExpression') {
				if (flag(link, 'computed')) this.walk_expr(get(link, 'property')!);
				this.op('prop_read', get(link, 'property')!.start);
			} else {
				this.walk_call_tail(link, plans.get(link) ?? null);
			}
		}
		this.block = prev;
	}

	walk_assign(node: Node): void {
		const op = text(node, 'operator');
		const left = get(node, 'left')!;
		const right = get(node, 'right')!;
		let hint: Hint | undefined;
		if (left.type === 'Identifier') hint = named(text(left, 'name'));
		else if (left.type === 'MemberExpression' && !flag(left, 'computed'))
			hint = named(text(get(left, 'property')!, 'name'));
		if (left.type === 'MemberExpression') {
			this.walk_expr(get(left, 'object')!);
			if (flag(left, 'computed')) this.walk_expr(get(left, 'property')!);
			if (op !== '=') this.op('prop_read', left.start);
			this.op('prop_write', get(left, 'property')!.start);
		} else {
			this.walk_pattern(left, 'assign');
		}
		this.op('assign', node.start);
		if (op === '&&=' || op === '||=' || op === '??=') {
			this.op('logical', node.start);
			this.expr_block(right, hint, left.type === 'Identifier' ? hint!.name : null);
			return;
		}
		if (op === '+=' && is_string_expr(right)) {
			this.op('concat', node.start);
			const s = this.alloc_site('string', node.start, 0, true);
			this.open(node.start, () => `${this.n.R}.str(${this.n.d},${s.index},`);
			this.close(node.end, () => ')');
		} else if (op !== '=') {
			this.op('arith', node.start);
		}
		this.walk_expr(right, hint);
	}

	walk_binary(node: Node, inside_concat: boolean): void {
		const op = text(node, 'operator');
		const left = get(node, 'left')!;
		const right = get(node, 'right')!;
		const concat = op === '+' && is_string_expr(node);
		if (concat && !inside_concat) {
			const s = this.alloc_site('string', node.start, 0, true);
			this.open(node.start, () => `${this.n.R}.str(${this.n.d},${s.index},`);
			this.close(node.end, () => ')');
		}
		for (const side of [left, right]) {
			if (concat && side.type === 'BinaryExpression' && text(side, 'operator') === '+')
				this.walk_binary(side, true);
			else if (side.type !== 'PrivateIdentifier') this.walk_expr(side);
		}
		if (concat) this.op('concat', node.start);
		else if (ARITH.has(op)) this.op('arith', node.start);
		else this.op('compare', node.start);
	}

	walk_await(node: Node): void {
		const f = this.fn;
		if (f.framed && f.meta.async) {
			const { R, r } = this.n;
			this.open(node.start, () => `${R}.resume(${r},`);
			this.open(node.start + 5, () => ` ${R}.suspend(${r},`);
			this.close(node.end, () => '))');
		}
		this.walk_expr(get(node, 'argument')!);
		this.op('await', node.start);
	}

	walk_yield(node: Node): void {
		const arg = get(node, 'argument');
		const f = this.fn;
		if (f.framed && f.meta.generator) {
			const { R, r } = this.n;
			this.open(node.start, () => `${R}.resume(${r},`);
			if (arg) {
				let at = node.start + 5;
				if (flag(node, 'delegate')) at = find_token(this.code, '*', at) + 1;
				this.open(at, () => ` ${R}.suspend(${r},`);
				this.close(node.end, () => '))');
			} else {
				this.close(node.end, () => ` ${R}.suspend(${r},undefined))`);
			}
		}
		if (arg) this.walk_expr(arg);
		this.op('yield', node.start);
	}

	// ---------------------------------------------------------------- finalize

	finalize(): ModuleMeta {
		for (const s of this.sites) {
			if (s.closure_of) s.meta.bytes = closure_bytes(captured(s.closure_of));
			if (s.meta.kind === 'new') {
				const known = s.new_name ? KNOWN_CONSTRUCTORS[s.new_name] : undefined;
				const fields = s.new_name ? this.class_fields.get(s.new_name) : undefined;
				s.meta.bytes = known ?? object_bytes(fields ?? 0);
			}
			if (s.arguments_of && s.arguments_of.uses_arguments && !s.meta.alloc) {
				s.meta.alloc = true;
				this.op_at_line('alloc', s.meta.line, 1, s.block);
			}
			if (s.meta.alloc && s.meta.bytes > 0) {
				this.op_at_line('alloc_word', s.meta.line, s.meta.bytes / 4, s.block);
			}
		}
		const blocks: BlockMeta[] = this.blocks.map((b) => {
			const line_ops: number[] = [];
			for (const [key, n] of b.line_ops)
				if (n !== 0) line_ops.push(Math.floor(key / 64), key % 64, n);
			return {
				fn: b.fn.index,
				index: b.index,
				line: b.line,
				col: b.col,
				price: this.price(b),
				ops: b.ops,
				line_ops
			};
		});
		return {
			schema: META_SCHEMA,
			id: this.opts.id,
			file: this.pos.source ?? this.opts.filename,
			prices_hash: this.opts.prices_hash,
			functions: this.fns.map((f) => f.meta),
			blocks,
			sites: this.sites.map((s) => s.meta),
			bsites: this.bsites
		};
	}
}

/** Variables a closure reads from an enclosing function scope (module scope costs no context). */
function captured(f: FnRec): number {
	let n = 0;
	const free = free_refs(f);
	for (const name of free) {
		let a = f.parent;
		while (a && a.meta.kind !== 'top') {
			if (a.declared.has(name)) {
				n++;
				break;
			}
			a = a.parent;
		}
	}
	return n;
}

const free_cache = new WeakMap<FnRec, Set<string>>();

function free_refs(f: FnRec): Set<string> {
	const hit = free_cache.get(f);
	if (hit) return hit;
	const out = new Set<string>();
	for (const name of f.refs) if (!f.declared.has(name)) out.add(name);
	free_cache.set(f, out);
	return out;
}

/** True when an optional link (`?.`) inside this member/call chain can skip the rest of it. */
function has_optional_link(node: Node): boolean {
	let cur: Node | null = node;
	while (cur && (cur.type === 'MemberExpression' || cur.type === 'CallExpression')) {
		if (flag(cur, 'optional')) return true;
		cur = cur.type === 'MemberExpression' ? get(cur, 'object') : get(cur, 'callee');
	}
	return false;
}

const FUNCTION_TYPES = new Set([
	'FunctionExpression',
	'FunctionDeclaration',
	'ArrowFunctionExpression',
	'ClassExpression',
	'ClassDeclaration'
]);

/** True when evaluating `node` can suspend its function (`await`, `yield`), nested functions aside. */
function contains_suspend(node: Node): boolean {
	if (node.type === 'AwaitExpression' || node.type === 'YieldExpression') return true;
	if (FUNCTION_TYPES.has(node.type)) return false;
	for (const key in node) {
		if (SKIP_KEYS.has(key)) continue;
		const v = node[key];
		if (Array.isArray(v)) {
			for (const x of v)
				if (x && typeof x === 'object' && 'type' in x && contains_suspend(x as Node)) return true;
		} else if (v && typeof v === 'object' && 'type' in v && contains_suspend(v as Node)) {
			return true;
		}
	}
	return false;
}

/** Keys of a node that are not its code: positions, raw text, and TypeScript-only modifiers. */
const SHAPE_SKIP = new Set([
	...SKIP_KEYS,
	'raw',
	'definite',
	'declare',
	'accessibility',
	'override',
	'readonly',
	'abstract'
]);

/** Nodes whose shape is asked for (the ones a path names): their hashes are kept for reuse. */
const SHAPED = new Set([
	'FunctionExpression',
	'FunctionDeclaration',
	'ArrowFunctionExpression',
	'ClassExpression',
	'ClassDeclaration',
	'ObjectExpression'
]);

const FNV_PRIME = 0x01000193;

/** The shape of a node type stripping removes: it is not there. */
const ABSENT = 0;

/** A node that is only a type: an interface, a `type`, `declare x`, an overload signature. */
function is_type_only(node: Node): boolean {
	if (node.type.startsWith('TS')) return true;
	if (flag(node, 'declare')) return true;
	const value = get(node, 'value');
	return node.type === 'MethodDefinition' && value !== null && value.type.startsWith('TS');
}

function mix_string(h: number, s: string): number {
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), FNV_PRIME);
	return Math.imul(h ^ 0xff, FNV_PRIME);
}

function mix_word(h: number, x: number): number {
	for (let i = 0; i < 4; i++) h = Math.imul(h ^ ((x >>> (i * 8)) & 0xff), FNV_PRIME);
	return h;
}

/**
 * A 32-bit FNV-1a hash of a node's syntax tree: node types, names, operators, literal values and
 * flags, nothing else. Whitespace, comments, parentheses, quotes, number spelling (`0x10` is `16`)
 * and TypeScript types are not in the tree, so they do not move it; type stripping and a
 * TypeScript compile give the same hash as the source. `?.` (`optional` on a member or call) is
 * code; `optional` on a parameter or property is a type.
 */
function shape_of(node: Node, memo: Map<Node, number>): number {
	while (TS_EXPRESSION_WRAPPERS.has(node.type)) node = get(node, 'expression')!;
	if (node.type === 'TSParameterProperty') return shape_of(get(node, 'parameter')!, memo);
	const kept = memo.get(node);
	if (kept !== undefined) return kept;
	if (is_type_only(node)) return ABSENT;
	let h = mix_string(0x811c9dc5, node.type);
	const keeps_optional = node.type === 'MemberExpression' || node.type === 'CallExpression';
	for (const key of Object.keys(node)) {
		if (SHAPE_SKIP.has(key) || (key === 'optional' && !keeps_optional)) continue;
		h = mix_string(h, key);
		h = mix_value(h, node[key], memo);
	}
	if (SHAPED.has(node.type)) memo.set(node, h);
	return h;
}

function mix_value(h: number, v: unknown, memo: Map<Node, number>): number {
	if (v === null || v === undefined) return mix_string(h, String(v));
	if (Array.isArray(v)) {
		// what type stripping removes (a `type` statement, an overload) is not an element
		let n = 0;
		for (const x of v) {
			const s = x && typeof x === 'object' && 'type' in x ? shape_of(x as Node, memo) : null;
			if (s === ABSENT) continue;
			h = s === null ? mix_value(h, x, memo) : mix_word(h, s);
			n++;
		}
		return mix_word(h, n);
	}
	if (typeof v === 'object') {
		if ('type' in v) return mix_word(h, shape_of(v as Node, memo));
		// a plain object: a regex literal's `{ pattern, flags }`
		for (const [k, x] of Object.entries(v)) h = mix_value(mix_string(h, k), x, memo);
		return h;
	}
	return mix_string(h, `${typeof v}:${String(v)}`);
}

/** An anonymous function or class expression: the language may name it after where it is put. */
function is_anonymous_definition(node: Node): boolean {
	let n = node;
	while (TS_EXPRESSION_WRAPPERS.has(n.type)) n = get(n, 'expression')!;
	if (n.type === 'ArrowFunctionExpression') return true;
	return (n.type === 'FunctionExpression' || n.type === 'ClassExpression') && !get(n, 'id');
}

function is_string_expr(node: Node): boolean {
	if (node.type === 'Literal') return typeof node.value === 'string';
	if (node.type === 'TemplateLiteral') return true;
	if (node.type === 'BinaryExpression' && node.operator === '+') {
		return is_string_expr(get(node, 'left')!) || is_string_expr(get(node, 'right')!);
	}
	return false;
}

/** Distinct `this.x =` writes in a constructor body (not crossing into nested non-arrow functions). */
function count_this_writes(body: Node): number {
	const names = new Set<string>();
	const visit = (n: Node): void => {
		if (n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration') return;
		if (n.type === 'AssignmentExpression') {
			const left = get(n, 'left');
			if (
				left &&
				left.type === 'MemberExpression' &&
				!flag(left, 'computed') &&
				get(left, 'object')?.type === 'ThisExpression'
			) {
				names.add(text(get(left, 'property')!, 'name'));
			}
		}
		for (const key in n) {
			if (SKIP_KEYS.has(key)) continue;
			const v = n[key];
			if (Array.isArray(v)) {
				for (const x of v) if (x && typeof x === 'object' && 'type' in x) visit(x as Node);
			} else if (v && typeof v === 'object' && 'type' in v) visit(v as Node);
		}
	};
	visit(body);
	return names.size;
}

/** Top-level bindings that are not exported (spec 7). let/var become live getters. */
export function private_bindings(program: Node): Array<{ name: string; live: boolean }> {
	const out = new Map<string, boolean>();
	const exported = new Set<string>();
	const names_of = (p: Node | null, acc: string[]): void => {
		if (!p) return;
		switch (p.type) {
			case 'Identifier':
				acc.push(text(p, 'name'));
				return;
			case 'ObjectPattern':
				for (const q of nodes(p, 'properties')) {
					names_of(q.type === 'RestElement' ? get(q, 'argument') : get(q, 'value'), acc);
				}
				return;
			case 'ArrayPattern':
				for (const e of list(p, 'elements')) names_of(e, acc);
				return;
			case 'AssignmentPattern':
				names_of(get(p, 'left'), acc);
				return;
			case 'RestElement':
				names_of(get(p, 'argument'), acc);
				return;
		}
	};
	for (const st of nodes(program, 'body')) {
		if (st.type === 'FunctionDeclaration' && get(st, 'body') && get(st, 'id')) {
			out.set(text(get(st, 'id')!, 'name'), false);
		} else if (st.type === 'ClassDeclaration' && !flag(st, 'declare') && get(st, 'id')) {
			out.set(text(get(st, 'id')!, 'name'), false);
		} else if (st.type === 'VariableDeclaration' && !flag(st, 'declare')) {
			const live = text(st, 'kind') !== 'const';
			for (const d of nodes(st, 'declarations')) {
				const acc: string[] = [];
				names_of(get(d, 'id'), acc);
				for (const nm of acc) out.set(nm, live);
			}
		} else if (st.type === 'ExportNamedDeclaration' && !get(st, 'source')) {
			for (const s of nodes(st, 'specifiers')) {
				const local = get(s, 'local');
				if (local) exported.add(text(local, 'name'));
			}
		}
	}
	const res: Array<{ name: string; live: boolean }> = [];
	for (const [name, live] of out) if (!exported.has(name)) res.push({ name, live });
	return res;
}

function is_using(st: Node): boolean {
	if (st.type !== 'VariableDeclaration') return false;
	const kind = text(st, 'kind');
	return kind === 'using' || kind === 'await using';
}

function is_await_using(st: Node): boolean {
	return st.type === 'VariableDeclaration' && text(st, 'kind') === 'await using';
}

function lang_of(filename: string): 'js' | 'jsx' | 'ts' | 'tsx' {
	if (filename.endsWith('.tsx')) return 'tsx';
	if (filename.endsWith('.ts') || filename.endsWith('.mts') || filename.endsWith('.cts'))
		return 'ts';
	if (filename.endsWith('.jsx')) return 'jsx';
	return 'js';
}

export function instrument(code: string, opts: InstrumentOptions): InstrumentResult {
	const parsed = parseSync(opts.filename, code, {
		sourceType: opts.commonjs ? 'commonjs' : 'module',
		lang: opts.lang ?? lang_of(opts.filename),
		preserveParens: false
	});
	if (parsed.errors.length > 0) {
		throw new Error(`heisenbench: cannot parse ${opts.filename}: ${parsed.errors[0].message}`);
	}
	const program = parsed.program as unknown as Node;
	const ins = new Instrumenter(code, opts);
	ins.run(program);
	const meta = ins.finalize();
	ins.meta = meta;

	const s = new MagicString(code);
	for (const e of ins.edits) {
		if (e.end !== undefined) s.overwrite(e.pos, e.end, e.text(), { contentOnly: true });
		else if (e.open) s.appendRight(e.pos, e.text());
		else s.prependLeft(e.pos, e.text());
	}

	if ((opts.expose ?? true) && !opts.commonjs) {
		const bindings = private_bindings(program);
		if (!bindings.some((b) => b.name === '__heisenbench')) {
			const props = bindings.map((b) => (b.live ? `get ${b.name}(){return ${b.name}}` : b.name));
			s.append(`\nexport const __heisenbench={${props.join(',')}};\n`);
		}
	}

	let map = s.generateMap({
		hires: 'boundary',
		source: opts.filename,
		file: opts.filename,
		includeContent: true
	});
	if (opts.input_map) {
		const chained = remapping([map, opts.input_map] as Parameters<typeof remapping>[0], () => null);
		map = chained as unknown as typeof map;
	}
	return { code: s.toString(), map, meta, origins: ins.blocks.map((b) => b.origin) };
}
