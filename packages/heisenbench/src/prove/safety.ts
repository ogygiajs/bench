import { parseSync } from 'oxc-parser';

/*
 * The first wall around a candidate's code (the second is the child process it runs in, see
 * child.ts and index.ts): a candidate may compute, nothing more. Its source is refused when it
 * names a way out of the counting runtime:
 *
 *   - a global that reaches the process, a module loader, the network or the global object
 *     (`process`, `require`, `fetch`, `globalThis`, `self` ...), read as a variable that nothing
 *     in the candidate declares (a local `frames` is the candidate's own and passes)
 *   - code made from strings (`eval`, `Function`)
 *   - an import, a dynamic `import()`, `import.meta`
 *   - the `constructor` / `__proto__` chain that reaches the Function constructor from any value,
 *     as a property name, or as a string used as a key (`x['constructor']`,
 *     `Reflect.get(x, 'constructor')`)
 *   - `with` and `debugger`
 *
 * What passes, because it reaches nothing: a name the candidate declares itself, in a scope that
 * holds the reference; `typeof window`; a property of the global object that is not itself a way
 * out (`globalThis.trustedTypes`, but never `globalThis.process` or `globalThis[k]`); a class
 * method's `this.constructor` (its own class); a string that names a property but is no key
 * (`k === '__proto__'`, a guard against prototype pollution). A property of an object (`x.self`,
 * `{ module: 1 }`) is not a global and passes.
 *
 * It cannot see a name built at run time (`x['con' + 'structor']`); for that the child's
 * permissions hold (no network, no writes, no child processes, reads only under the project).
 */

interface Node {
	type: string;
	[key: string]: unknown;
}

/** Global names a candidate may not read. */
export const FORBIDDEN_NAMES: ReadonlySet<string> = new Set([
	'process',
	'require',
	'module',
	'exports',
	'globalThis',
	'global',
	'window',
	'self',
	'frames',
	'eval',
	'Function',
	'fetch',
	'XMLHttpRequest',
	'WebSocket',
	'EventSource',
	'navigator',
	'importScripts',
	'Deno',
	'Bun',
	'WebAssembly',
	'SharedArrayBuffer',
	'Atomics',
	'__dirname',
	'__filename'
]);

/** The names of the global object: a property of one that is not a way out may be read. */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set([
	'globalThis',
	'global',
	'window',
	'self',
	'frames'
]);

/**
 * Property names a candidate may not use: they reach the Function constructor or change the
 * prototype chain. (`caller` and `callee` throw in a module, which is strict code, so data that
 * names them, a call graph's `edge.caller`, passes.)
 */
export const FORBIDDEN_PROPERTIES: ReadonlySet<string> = new Set([
	'constructor',
	'__proto__',
	'__defineGetter__',
	'__defineSetter__',
	'__lookupGetter__',
	'__lookupSetter__'
]);

/** Node types a candidate may not have. */
const FORBIDDEN_NODES: Record<string, string> = {
	ImportExpression: 'a dynamic import()',
	ImportDeclaration: 'an import',
	ExportAllDeclaration: 'a re-export',
	MetaProperty: 'import.meta or new.target',
	WithStatement: 'a with statement',
	DebuggerStatement: 'a debugger statement'
};

/** Subtrees that are types only: they never run. */
const TYPE_ONLY = new Set([
	'TSTypeAnnotation',
	'TSTypeAliasDeclaration',
	'TSInterfaceDeclaration',
	'TSTypeParameterDeclaration',
	'TSTypeParameterInstantiation',
	'TSDeclareFunction'
]);

/** Expressions that only say a type: `x as T`, `x!`, `(x)` are `x`. */
const TYPE_WRAPPERS = new Set([
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSNonNullExpression',
	'TSTypeAssertion',
	'ParenthesizedExpression'
]);

/** Callees whose arguments name a property to read or define (`Reflect.get(x, 'constructor')`). */
const KEYED_CALLEES: ReadonlySet<string> = new Set(['Reflect', 'Object']);

const FUNCTION_NODES = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression'
]);

function children(n: Node): Node[] {
	const out: Node[] = [];
	for (const [k, v] of Object.entries(n)) {
		if (k === 'type' || k === 'start' || k === 'end') continue;
		if (Array.isArray(v)) {
			for (const x of v)
				if (x && typeof x === 'object' && typeof (x as Node).type === 'string') out.push(x as Node);
		} else if (v && typeof v === 'object' && typeof (v as Node).type === 'string') {
			out.push(v as Node);
		}
	}
	return out;
}

function unwrap(n: Node): Node {
	while (TYPE_WRAPPERS.has(n.type) && n.expression) n = n.expression as Node;
	return n;
}

/** The names a binding pattern declares (`a`, `{ a, b: [c] }`, `...d`, `e = 1`). */
function pattern_names(p: Node | null | undefined, out: string[]): void {
	if (!p) return;
	switch (p.type) {
		case 'Identifier':
			out.push(p.name as string);
			return;
		case 'ObjectPattern':
			for (const prop of p.properties as Node[])
				pattern_names(prop.type === 'RestElement' ? prop : (prop.value as Node), out);
			return;
		case 'ArrayPattern':
			for (const e of p.elements as Array<Node | null>) pattern_names(e, out);
			return;
		case 'RestElement':
			pattern_names(p.argument as Node, out);
			return;
		case 'AssignmentPattern':
			pattern_names(p.left as Node, out);
			return;
		case 'TSParameterProperty':
			pattern_names(p.parameter as Node, out);
			return;
	}
}

/** `var` names declared in a function's body, not in the functions inside it. */
function var_names(n: Node, out: string[]): void {
	if (n.type === 'VariableDeclaration' && n.kind === 'var')
		for (const d of n.declarations as Node[]) pattern_names(d.id as Node, out);
	for (const c of children(n))
		if (!FUNCTION_NODES.has(c.type) && !TYPE_ONLY.has(c.type)) var_names(c, out);
}

/** Names a statement list declares in its own block: let, const, class, function, import. */
function lexical_names(body: readonly Node[], out: string[]): void {
	for (const raw of body) {
		const s =
			(raw.type === 'ExportNamedDeclaration' || raw.type === 'ExportDefaultDeclaration') &&
			raw.declaration
				? (raw.declaration as Node)
				: raw;
		if (s.type === 'VariableDeclaration' && s.kind !== 'var')
			for (const d of s.declarations as Node[]) pattern_names(d.id as Node, out);
		else if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id)
			out.push((s.id as Node).name as string);
		else if (s.type === 'TSEnumDeclaration' && s.id) out.push((s.id as Node).name as string);
		else if (s.type === 'ImportDeclaration')
			for (const sp of s.specifiers as Node[]) out.push((sp.local as Node).name as string);
	}
}

/** One scope's names, and the scope around it. */
class Scope {
	names: Set<string>;
	parent: Scope | null;
	constructor(names: string[], parent: Scope | null) {
		this.names = new Set(names);
		this.parent = parent;
	}
	has(name: string): boolean {
		return this.names.has(name) || (this.parent?.has(name) ?? false);
	}
}

/**
 * Why `source` may not run as a candidate, or null when it passes. `allow_imports`: imports are
 * checked elsewhere (splice.ts accepts only imports the original module has word for word).
 */
export function unsafe_reason(
	file: string,
	source: string,
	o: { allow_imports?: boolean } = {}
): string | null {
	const lang = /\.[cm]?tsx$/.test(file) ? 'tsx' : /\.[cm]?ts$/.test(file) ? 'ts' : 'js';
	const r = parseSync(file, source, { sourceType: 'module', lang });
	if (r.errors.length > 0) return `it does not parse: ${r.errors[0].message.split('\n')[0]}`;
	let why: string | null = null;
	const property = (key: Node): void => {
		const name = key.name as string | undefined;
		if (name !== undefined && FORBIDDEN_PROPERTIES.has(name))
			why ??= `it uses the property \`${name}\``;
	};
	/** A string used as a key: refused when it names a forbidden property. */
	const key_text = (k: Node): boolean => {
		const n = unwrap(k);
		const text =
			n.type === 'Literal' && typeof n.value === 'string'
				? n.value
				: n.type === 'TemplateLiteral' && (n.expressions as Node[]).length === 0
					? (((n.quasis as Node[])[0].value as { cooked?: string | null }).cooked ?? '')
					: null;
		if (text !== null && FORBIDDEN_PROPERTIES.has(text)) {
			why ??= `a string in it names \`${text}\` as a key`;
			return true;
		}
		return false;
	};
	const reference = (n: Node, scope: Scope): void => {
		const name = n.name as string;
		if (FORBIDDEN_NAMES.has(name) && !scope.has(name)) why ??= `it names \`${name}\``;
	};
	const visit = (n: Node, scope: Scope): void => {
		if (why !== null || TYPE_ONLY.has(n.type)) return;
		const node = FORBIDDEN_NODES[n.type];
		if (node && !(o.allow_imports && n.type === 'ImportDeclaration')) {
			why = `it has ${node}`;
			return;
		}
		if (n.type === 'ImportDeclaration') return;
		if (FUNCTION_NODES.has(n.type)) {
			const names: string[] = [];
			// a function expression's own name is visible inside it
			if (n.type !== 'FunctionDeclaration' && n.id) names.push((n.id as Node).name as string);
			for (const p of n.params as Node[]) pattern_names(p, names);
			const body = n.body as Node | null;
			if (body) {
				var_names(body, names);
				if (body.type === 'BlockStatement') lexical_names(body.body as Node[], names);
			}
			const inner = new Scope(names, scope);
			for (const p of n.params as Node[]) visit(p, inner);
			if (body) {
				if (body.type === 'BlockStatement') for (const s of body.body as Node[]) visit(s, inner);
				else visit(body, inner);
			}
			return;
		}
		switch (n.type) {
			case 'Program': {
				const names: string[] = [];
				var_names(n, names);
				lexical_names(n.body as Node[], names);
				const inner = new Scope(names, scope);
				for (const s of n.body as Node[]) visit(s, inner);
				return;
			}
			case 'BlockStatement':
			case 'StaticBlock': {
				const names: string[] = [];
				lexical_names(n.body as Node[], names);
				const inner = new Scope(names, scope);
				for (const s of n.body as Node[]) visit(s, inner);
				return;
			}
			case 'SwitchStatement': {
				visit(n.discriminant as Node, scope);
				const names: string[] = [];
				for (const c of n.cases as Node[]) lexical_names(c.consequent as Node[], names);
				const inner = new Scope(names, scope);
				for (const c of n.cases as Node[]) {
					if (c.test) visit(c.test as Node, inner);
					for (const s of c.consequent as Node[]) visit(s, inner);
				}
				return;
			}
			case 'ForStatement':
			case 'ForInStatement':
			case 'ForOfStatement': {
				const head = (n.init ?? n.left) as Node | null;
				const names: string[] = [];
				if (head?.type === 'VariableDeclaration' && head.kind !== 'var')
					for (const d of head.declarations as Node[]) pattern_names(d.id as Node, names);
				const inner = new Scope(names, scope);
				for (const c of children(n)) visit(c, inner);
				return;
			}
			case 'CatchClause': {
				const names: string[] = [];
				pattern_names(n.param as Node | null, names);
				const inner = new Scope(names, scope);
				if (n.param) visit(n.param as Node, inner);
				visit(n.body as Node, inner);
				return;
			}
			case 'ClassDeclaration':
			case 'ClassExpression': {
				// the class's own name is visible inside its body
				const names = n.id ? [(n.id as Node).name as string] : [];
				const inner = new Scope(names, scope);
				if (n.superClass) visit(n.superClass as Node, inner);
				visit(n.body as Node, inner);
				return;
			}
			case 'LabeledStatement':
				visit(n.body as Node, scope);
				return;
			case 'BreakStatement':
			case 'ContinueStatement':
				return;
			case 'Identifier':
				reference(n, scope);
				property(n);
				return;
			case 'UnaryExpression': {
				// `typeof window` says whether there is one; it reaches nothing
				const arg = unwrap(n.argument as Node);
				if (n.operator === 'typeof' && arg.type === 'Identifier') return;
				visit(n.argument as Node, scope);
				return;
			}
			case 'MemberExpression': {
				const object = unwrap(n.object as Node);
				const prop = n.property as Node;
				// a class method's `this.constructor`: its own class
				if (object.type === 'ThisExpression' && !n.computed && prop.name === 'constructor') return;
				if (
					object.type === 'Identifier' &&
					GLOBAL_OBJECTS.has(object.name as string) &&
					!scope.has(object.name as string)
				) {
					// a property of the global object: allowed when it is no way out itself
					const name = n.computed ? null : (prop.name as string);
					if (name === null) why ??= `it names \`${object.name as string}\` with a computed key`;
					else if (FORBIDDEN_NAMES.has(name) || FORBIDDEN_PROPERTIES.has(name))
						why ??= `it names \`${object.name as string}.${name}\``;
					return;
				}
				visit(n.object as Node, scope);
				if (n.computed) {
					if (!key_text(prop)) visit(prop, scope);
				} else property(prop);
				return;
			}
			case 'CallExpression':
			case 'NewExpression': {
				const callee = unwrap(n.callee as Node);
				const owner = callee.type === 'MemberExpression' ? unwrap(callee.object as Node) : null;
				visit(n.callee as Node, scope);
				const keyed =
					owner?.type === 'Identifier' &&
					KEYED_CALLEES.has(owner.name as string) &&
					!scope.has(owner.name as string);
				for (const a of n.arguments as Node[]) if (!(keyed && key_text(a))) visit(a, scope);
				return;
			}
			case 'Property':
			case 'MethodDefinition':
			case 'PropertyDefinition':
			case 'AccessorProperty':
				if (n.computed) {
					if (!key_text(n.key as Node)) visit(n.key as Node, scope);
				} else if (n.shorthand) visit(n.key as Node, scope);
				// a class's own constructor is a method, not a way to the Function constructor
				else if (n.kind !== 'constructor') property(n.key as Node);
				if (n.value && !n.shorthand) visit(n.value as Node, scope);
				return;
			case 'Literal':
			case 'TemplateElement':
				// a string that is no key reaches nothing (`k === '__proto__'` guards against it)
				return;
		}
		for (const c of children(n)) visit(c, scope);
	};
	visit(r.program as unknown as Node, new Scope([], null));
	return why;
}
