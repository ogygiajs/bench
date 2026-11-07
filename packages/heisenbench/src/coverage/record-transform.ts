import MagicString from 'magic-string';
import { parseSync } from 'oxc-parser';
import { own_file } from '../own.ts';
import { find_token, instrument, private_bindings } from '../transform/instrument.ts';
import { load_prices } from '../prices.ts';

/*
 * The recording transform (spec 8, leftovers): functions no scenario reached get their inputs and
 * outputs recorded while another program (ogygia's own test suite) runs them.
 *
 *   function f(a, b) { BODY }
 *   ->
 *   function f(a, b) { const $r = R.enter(ID, arguments, this); try { BODY' }
 *     catch ($e) { R.fail($r, $e); throw $e } finally { R.exit($r) } }
 *
 * where every `return X` of the function itself becomes `return R.out($r, X)`. An arrow function has
 * no `arguments`: its parameters are passed instead (when they are plain names; an arrow with a
 * destructured or rest parameter is not recorded). Async functions, generators and functions that
 * read `new.target` are not recorded: their output is not a value at return.
 *
 * Function identity is the counting transform's (`Router > match`): the transform lists the module's
 * functions with their start positions, and this transform wraps the nodes that start there.
 * `export const __heisenbench_rec = { name: fn }` hands the top-level ones to a replay.
 */

const RECORDER = own_file('coverage/recorder');
import { INJECTED_CLOSE, INJECTED_OPEN } from './markers.ts';

interface Node {
	type: string;
	start: number;
	end: number;
	[key: string]: unknown;
}

function child_nodes(n: Node): Node[] {
	const out: Node[] = [];
	for (const [k, v] of Object.entries(n)) {
		if (k === 'type' || k === 'start' || k === 'end') continue;
		if (Array.isArray(v)) {
			for (const x of v) if (x && typeof x === 'object' && 'type' in x) out.push(x as Node);
		} else if (v && typeof v === 'object' && 'type' in v) {
			out.push(v as Node);
		}
	}
	return out;
}

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

export interface RecordTransformOptions {
	filename: string;
	/** Report identity of the module (`@ogygia/core/dist/x.js`). */
	id: string;
	/** Function paths to record (default: every function that can be recorded). */
	targets?: ReadonlySet<string>;
	/** Specifier the recorder runtime is imported from. */
	runtime?: string;
	/**
	 * Also export `__heisenbench`, the module's private top-level bindings, as the counting build
	 * does: a bench file that imports them loads on the recording build too.
	 */
	expose?: boolean;
}

export interface RecordTransformResult {
	code: string;
	map: ReturnType<MagicString['generateMap']>;
	/** `module > path` of each wrapped function. */
	wrapped: string[];
	/** Targets left as they are, with the reason. */
	skipped: Array<{ id: string; reason: string }>;
}

function line_starts(code: string): number[] {
	const starts = [0];
	for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) starts.push(i + 1);
	return starts;
}

function position(starts: number[], offset: number): string {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return `${lo + 1}:${offset - starts[lo]}`;
}

/** Statements of a function's own body, without descending into nested functions or classes. */
function own_nodes(body: Node, visit: (n: Node) => boolean): void {
	const stack = [body];
	while (stack.length > 0) {
		const n = stack.pop()!;
		if (!visit(n)) continue;
		for (const c of child_nodes(n)) {
			if (FUNCTIONS.has(c.type) || c.type === 'ClassDeclaration' || c.type === 'ClassExpression') {
				// arrows keep `this`/`new.target` of the outer function, but their returns are their own
				if (c.type === 'ArrowFunctionExpression') {
					own_arrow_scan(c, visit);
				}
				continue;
			}
			stack.push(c);
		}
	}
}

/** Inside a nested arrow only `new.target` and `this` matter (they are the outer function's). */
function own_arrow_scan(arrow: Node, visit: (n: Node) => boolean): void {
	const stack = [arrow];
	while (stack.length > 0) {
		const n = stack.pop()!;
		if (n.type === 'MetaProperty' || n.type === 'ThisExpression') visit(n);
		for (const c of child_nodes(n)) {
			if (c.type === 'FunctionDeclaration' || c.type === 'FunctionExpression') continue;
			stack.push(c);
		}
	}
}

export function record_transform(code: string, o: RecordTransformOptions): RecordTransformResult {
	const metas = instrument(code, {
		id: o.id,
		filename: o.filename,
		prices: load_prices().prices,
		prices_hash: '',
		module_specifier: 'heisenbench:none',
		expose: false
	}).meta.functions;
	const by_pos = new Map<string, string>();
	for (const f of metas) if (f.kind === 'function') by_pos.set(`${f.line}:${f.col}`, f.path);

	const lang = o.filename.endsWith('.ts') ? 'ts' : 'js';
	const ast = parseSync(o.filename, code, { sourceType: 'module', lang })
		.program as unknown as Node;
	const s = new MagicString(code);
	const starts = line_starts(code);
	const wrapped: string[] = [];
	const skipped: Array<{ id: string; reason: string }> = [];
	const top_level = new Map<string, string>();
	let n = 0;

	const wrap = (fn: Node, path: string): void => {
		const id = `${o.id} > ${path}`;
		if (fn.async === true || fn.generator === true) {
			skipped.push({ id, reason: fn.async === true ? 'async' : 'generator' });
			return;
		}
		const body = fn.body as Node;
		const params = (fn.params as Node[]) ?? [];
		const is_arrow = fn.type === 'ArrowFunctionExpression';
		if (is_arrow && params.some((p) => p.type !== 'Identifier')) {
			skipped.push({ id, reason: 'destructured or rest parameter' });
			return;
		}
		const returns: Node[] = [];
		let new_target = false;
		let uses_this = false;
		if (body.type === 'BlockStatement') {
			own_nodes(body, (x) => {
				if (x.type === 'ReturnStatement') returns.push(x);
				if (x.type === 'MetaProperty') new_target = true;
				if (x.type === 'ThisExpression') uses_this = true;
				return true;
			});
		} else if (!is_arrow) {
			uses_this = true;
		}
		for (const p of params) {
			// a default value may read `this` too
			own_nodes(p, (x) => {
				if (x.type === 'ThisExpression') uses_this = true;
				return true;
			});
		}
		if (new_target) {
			skipped.push({ id, reason: 'reads new.target' });
			return;
		}
		const r = `$heisenbench_r${++n}`;
		const e = `$heisenbench_e${n}`;
		const args = is_arrow ? `[${params.map((p) => p.name as string).join(',')}]` : 'arguments';
		// `this` is an input only when the function reads it (a method called on a module
		// namespace or a class instance would otherwise make every call uncloneable).
		const self = !is_arrow && uses_this ? 'this' : 'undefined';
		// Every piece of injected code sits between INJECTED_OPEN and INJECTED_CLOSE, so the
		// recorder can give back a function's original source (recorder.ts `original_source`):
		// code that serializes a function with toString() (an inline script) still gets its own.
		const inj = (text: string) => INJECTED_OPEN + text + INJECTED_CLOSE;
		const head = `const ${r}=__heisenbench_rec.enter(${JSON.stringify(id)},${args},${self});try{`;
		const tail = `}catch(${e}){__heisenbench_rec.fail(${r},${e});throw ${e}}finally{__heisenbench_rec.exit(${r})}`;
		if (body.type === 'BlockStatement') {
			const stmts = (body.body as Node[]) ?? [];
			let first = 0;
			while (first < stmts.length && typeof stmts[first].directive === 'string') first++;
			const at = first > 0 ? stmts[first - 1].end : body.start + 1;
			s.appendLeft(at, inj(head));
			s.prependRight(body.end - 1, inj(tail));
			for (const ret of returns) {
				const arg = ret.argument as Node | null;
				if (arg) {
					s.appendLeft(arg.start, inj(`__heisenbench_rec.out(${r},`));
					s.prependRight(arg.end, inj(')'));
				} else {
					s.appendLeft(ret.start + 6, inj(` __heisenbench_rec.out(${r},undefined)`));
				}
			}
		} else {
			// After the `=>` (the body may start inside parentheses the parser leaves out).
			let from = fn.start;
			for (const p of params) from = Math.max(from, p.end);
			const rt = fn.returnType as Node | null;
			if (rt) from = Math.max(from, rt.end);
			const arrow = find_token(code, '=>', from) + 2;
			s.appendLeft(arrow, inj(`{${head}return __heisenbench_rec.out(${r},(`));
			s.prependRight(fn.end, inj(`))${tail}}`));
		}
		wrapped.push(id);
	};

	// A class constructor is not recorded: a derived one may not read `this` before `super()`, and
	// no replay can call a constructor without `new`.
	const constructors = new Set<Node>();
	const visit = (node: Node, depth: number): void => {
		if (node.type === 'MethodDefinition' && node.kind === 'constructor') {
			constructors.add(node.value as Node);
		}
		if (FUNCTIONS.has(node.type)) {
			const path = by_pos.get(position(starts, node.start));
			if (path !== undefined && (!o.targets || o.targets.has(path))) {
				if (constructors.has(node))
					skipped.push({ id: `${o.id} > ${path}`, reason: 'constructor' });
				else wrap(node, path);
			}
		}
		for (const c of child_nodes(node)) visit(c, depth + 1);
	};
	for (const st of (ast.body as Node[]) ?? []) {
		// top-level functions a replay can call by name
		const decl =
			st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration'
				? ((st.declaration as Node | null) ?? st)
				: st;
		if (decl.type === 'FunctionDeclaration' && decl.id) {
			const name = (decl.id as Node).name as string;
			const path = by_pos.get(position(starts, decl.start));
			if (path !== undefined) top_level.set(path, name);
		} else if (decl.type === 'VariableDeclaration') {
			for (const d of (decl.declarations as Node[]) ?? []) {
				const init = d.init as Node | null;
				const target = d.id as Node;
				if (!init || target.type !== 'Identifier' || !FUNCTIONS.has(init.type)) continue;
				const path = by_pos.get(position(starts, init.start));
				if (path !== undefined) top_level.set(path, target.name as string);
			}
		}
		visit(st, 0);
	}
	if (o.targets) {
		const done = new Set(wrapped);
		for (const t of o.targets) {
			const id = `${o.id} > ${t}`;
			if (!done.has(id) && !skipped.some((x) => x.id === id))
				skipped.push({ id, reason: 'not found' });
		}
	}
	s.prepend(
		`import { recorder as __heisenbench_rec } from ${JSON.stringify(o.runtime ?? RECORDER)};\n`
	);
	const fns = [...top_level]
		.filter(([path]) => wrapped.includes(`${o.id} > ${path}`))
		.map(([path, name]) => `${JSON.stringify(`${o.id} > ${path}`)}:${name}`);
	s.append(`\nexport const __heisenbench_rec_fns = {${fns.join(',')}};\n`);
	if (o.expose) {
		// what a bench file imports from the module's private bindings, as the counting build has it
		const bindings = private_bindings(ast as Parameters<typeof private_bindings>[0]);
		if (!bindings.some((b) => b.name === '__heisenbench')) {
			const props = bindings.map((b) => (b.live ? `get ${b.name}(){return ${b.name}}` : b.name));
			s.append(`export const __heisenbench={${props.join(',')}};\n`);
		}
	}
	return {
		code: s.toString(),
		map: s.generateMap({ hires: true, source: o.filename }),
		wrapped,
		skipped
	};
}
