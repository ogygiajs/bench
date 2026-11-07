import { parseSync } from 'oxc-parser';

/*
 * The first wall around a candidate's code (the second is the child process it runs in, see
 * child.ts and index.ts): a candidate may compute, nothing more. Its source is refused when it
 * names a way out of the counting runtime:
 *
 *   - a global that reaches the process, a module loader, the network or the global object
 *     (`process`, `require`, `fetch`, `globalThis`, `self` ...), read as a variable
 *   - code made from strings (`eval`, `Function`)
 *   - an import, a dynamic `import()`, `import.meta`
 *   - the `constructor` / `__proto__` chain that reaches the Function constructor from any value,
 *     as a property name or as a string (`x['constructor']`)
 *   - `with` and `debugger`
 *
 * The check is syntactic and errs on the side of refusing: a local variable named `process` is
 * refused too. A property of an object (`x.self`, `{ module: 1 }`) is not a global and passes.
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

const FORBIDDEN_TEXT = new RegExp([...FORBIDDEN_PROPERTIES].join('|'));

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
	const visit = (n: Node): void => {
		if (why !== null || TYPE_ONLY.has(n.type)) return;
		const node = FORBIDDEN_NODES[n.type];
		if (node && !(o.allow_imports && n.type === 'ImportDeclaration')) {
			why = `it has ${node}`;
			return;
		}
		if (o.allow_imports && n.type === 'ImportDeclaration') return;
		switch (n.type) {
			case 'Identifier': {
				const name = n.name as string;
				if (FORBIDDEN_NAMES.has(name)) why = `it names \`${name}\``;
				else property(n);
				return;
			}
			case 'MemberExpression':
				visit(n.object as Node);
				if (n.computed) visit(n.property as Node);
				else property(n.property as Node);
				return;
			case 'Property':
			case 'MethodDefinition':
			case 'PropertyDefinition':
			case 'AccessorProperty':
				if (n.computed || n.shorthand) visit(n.key as Node);
				// a class's own constructor is a method, not a way to the Function constructor
				else if (n.kind !== 'constructor') property(n.key as Node);
				if (n.value) visit(n.value as Node);
				return;
			case 'Literal':
				if (typeof n.value === 'string' && FORBIDDEN_TEXT.test(n.value))
					why = `a string in it names \`${n.value.match(FORBIDDEN_TEXT)![0]}\``;
				return;
			case 'TemplateElement': {
				const text = (n.value as { cooked?: string | null }).cooked ?? '';
				if (FORBIDDEN_TEXT.test(text))
					why = `a string in it names \`${text.match(FORBIDDEN_TEXT)![0]}\``;
				return;
			}
		}
		for (const c of children(n)) visit(c);
	};
	visit(r.program as unknown as Node);
	return why;
}
