import type { BlockOrigin } from '../src/transform/instrument.ts';
import type { SiteMeta } from '../src/meta.ts';
import { children, parse } from './ast.ts';
import type { Node } from './ast.ts';

/*
 * The probed program: the plain program with a V8-visible counter at every place the oracles read
 * a count, so V8 counts each one exactly and independently of the transform.
 *
 * V8's block coverage alone is not enough: the code after a jump or branch is a "continuation"
 * that V8 records as a start position only, and it ends that range where the next nested range
 * starts; code after a nested range then reads as the enclosing function's count. So:
 *
 *   statement blocks   `if(__P){}else{}` before the statement (inside the braces of a body, at the
 *                      top of a function, module or static block)
 *   expression blocks  `(__P?(expr):0)`
 *   allocations        the allocating expression wrapped the same way; a declaration (function,
 *                      class) gets a statement counter where it is made
 *   optional chains    V8's own `?.` range (it has an explicit end)
 *   calls              V8's function ranges (explicit too)
 *
 * Each counter has two arms because V8 leaves out a range whose count equals its parent's, and
 * leaves out every range of code it compiled away as dead (`if (true) throw` makes what follows
 * dead). The first arm's range is the count; when it is missing, the second arm's range (always
 * 0, so present unless the parent is 0 too) says the code was live and the count is the parent's;
 * when both are missing, the code never ran.
 *
 * `__P` is a global `true`, so every wrapped expression keeps its value. An anonymous function or
 * class in a position that names it (`x = () => {}` names it `x`) is wrapped as
 * `(__P?({"x": fn}["x"]):0)`, which names it the same way. The probe oracle checks the probed
 * program still does what the plain one does.
 */

/**
 * Where V8's ranges of a counter start: its first arm, and its second (-1: a range of V8's own).
 * `guard`: a counter around the code holding V8's own range (an optional chain); when that code
 * never ran, the range never existed.
 */
export interface Anchor {
	hit: number;
	miss: number;
	guard?: Anchor;
}

type Role = 'hit' | 'miss';

export interface Probed {
	code: string;
	/** Per block (null: no counter for it). */
	blocks: Array<Anchor | null>;
	/** Per allocation site (null: no reference for this site). */
	sites: Array<Anchor | null>;
	/** An original offset in the probed code. */
	map: (pos: number) => number;
}

interface Edit {
	pos: number;
	text: string;
	/** 0 close, 1 statement insert, 2 open. */
	order: number;
	/** Opens: outer (longer) first; closes: inner first. Name-keeping wraps are innermost. */
	extent: number;
	/** Anchors set by this text: `[role, offset in text]`. */
	marks: Array<[Role, number]>;
	anchor: { kind: 'block' | 'site' | 'guard'; index: number } | null;
}

const STMT = 'if(__P){}else{}';
const STMT_MARKS: Edit['marks'] = [
	['hit', 7],
	['miss', 9]
];

const FUNCTION_TYPES = new Set([
	'FunctionExpression',
	'ArrowFunctionExpression',
	'ClassExpression'
]);

/** Anonymous function and class definitions that a naming position names: start -> name. */
function named_positions(program: Node): Map<number, string | null> {
	const out = new Map<number, string | null>();
	const anon = (n: Node | null): n is Node =>
		!!n && FUNCTION_TYPES.has(n.type) && (n.type === 'ArrowFunctionExpression' || !n.id);
	const key_name = (key: Node | null, computed: boolean): string | null => {
		if (!key || computed) return null;
		if (key.type === 'Identifier') return key.name as string;
		if (key.type === 'PrivateIdentifier') return '#' + (key.name as string);
		if (key.type === 'Literal') return String(key.value);
		return null;
	};
	const visit = (n: Node): void => {
		const get = (k: string): Node | null => (n[k] as Node | null) ?? null;
		if (n.type === 'VariableDeclarator') {
			const id = get('id');
			const init = get('init');
			if (anon(init) && id?.type === 'Identifier') out.set(init.start, id.name as string);
		} else if (n.type === 'AssignmentExpression') {
			const left = get('left');
			const right = get('right');
			if (
				anon(right) &&
				left?.type === 'Identifier' &&
				['=', '||=', '&&=', '??='].includes(n.operator as string)
			)
				out.set(right.start, left.name as string);
		} else if (n.type === 'AssignmentPattern') {
			const left = get('left');
			const right = get('right');
			if (anon(right) && left?.type === 'Identifier') out.set(right.start, left.name as string);
		} else if (n.type === 'Property' && n.kind === 'init' && n.method !== true) {
			const value = get('value');
			if (anon(value)) out.set(value.start, key_name(get('key'), n.computed === true));
		} else if (n.type === 'PropertyDefinition') {
			const value = get('value');
			if (anon(value)) out.set(value.start, key_name(get('key'), n.computed === true));
		} else if (n.type === 'ExportDefaultDeclaration') {
			const d = get('declaration');
			if (anon(d)) out.set(d.start, 'default');
		}
		for (const c of children(n)) visit(c);
	};
	visit(program);
	return out;
}

const parents = new WeakMap<Node, Node | null>();

function parent_of(n: Node | null | undefined): Node | null {
	return n ? (parents.get(n) ?? null) : null;
}

/** Nodes by start offset, for finding a site's node. */
function nodes_at(program: Node): Map<number, Node[]> {
	const out = new Map<number, Node[]>();
	const visit = (n: Node, parent: Node | null): void => {
		parents.set(n, parent);
		const list = out.get(n.start) ?? [];
		list.push(n);
		out.set(n.start, list);
		for (const c of children(n)) visit(c, n);
	};
	visit(program, null);
	return out;
}

const SITE_NODES: Record<string, (n: Node) => boolean> = {
	object: (n) => n.type === 'ObjectExpression',
	spread_object: (n) => n.type === 'ObjectExpression',
	array: (n) => n.type === 'ArrayExpression',
	spread_array: (n) => n.type === 'ArrayExpression',
	new: (n) => n.type === 'NewExpression',
	regexp: (n) => n.type === 'Literal' && !!n.regex,
	string: (n) =>
		n.type === 'TemplateLiteral' ||
		(n.type === 'BinaryExpression' && n.operator === '+') ||
		(n.type === 'AssignmentExpression' && n.operator === '+='),
	bound: (n) => n.type === 'CallExpression',
	closure: (n) => FUNCTION_TYPES.has(n.type) || n.type === 'FunctionDeclaration',
	class: (n) => n.type === 'ClassExpression' || n.type === 'ClassDeclaration'
};

export function probe(
	code: string,
	origins: BlockOrigin[],
	sites: SiteMeta[],
	lines: number[]
): Probed {
	const program = parse(code);
	const names = named_positions(program);
	const at = nodes_at(program);
	const edits: Edit[] = [];
	const insert = (pos: number, anchor: Edit['anchor']): void => {
		edits.push({ pos, text: STMT, order: 1, extent: 0, marks: STMT_MARKS, anchor });
	};
	/** Wrap `start..end` so V8 counts it; keeps an anonymous function's name. */
	const wrap = (start: number, end: number, anchor: Edit['anchor']): boolean => {
		const named = names.has(start);
		const name = names.get(start);
		if (named && name === null) return false;
		// twice the span, so a name-keeping wrap sits just inside a plain wrap of the same span
		const extent = (end - start) * 2 + 1;
		if (named) {
			const k = JSON.stringify(name);
			const close = `}[${k}]):0)`;
			edits.push({
				pos: start,
				text: `(__P?({${k}:`,
				order: 2,
				extent: extent - 1,
				marks: [['hit', 4]],
				anchor
			});
			edits.push({
				pos: end,
				text: close,
				order: 0,
				extent: extent - 1,
				marks: [['miss', close.length - 3]],
				anchor
			});
		} else {
			edits.push({ pos: start, text: '(__P?(', order: 2, extent, marks: [['hit', 4]], anchor });
			edits.push({ pos: end, text: '):0)', order: 0, extent, marks: [['miss', 1]], anchor });
		}
		return true;
	};
	/** Statement counter at the top of the statement list `container` starts. */
	const list_start = (container: Node): number => {
		if (container.type === 'Program') {
			const body = container.body as Node[];
			let i = 0;
			while (i < body.length && typeof body[i].directive === 'string') i++;
			return i < body.length ? body[i].start : container.end;
		}
		if (container.type === 'SwitchCase') {
			const cons = container.consequent as Node[];
			return cons.length > 0 ? cons[0].start : container.end;
		}
		// a block (`{`), a function body, a static block
		const body = container.body as Node[];
		let i = 0;
		while (i < body.length && typeof body[i].directive === 'string') i++;
		return i > 0 ? body[i - 1].end : code.indexOf('{', container.start) + 1;
	};

	const block_anchor: Array<Anchor | null> = Array.from({ length: origins.length }, () => null);
	const guards: Array<Anchor | undefined> = Array.from({ length: origins.length }, () => undefined);
	const fixed: Array<{ index: number; pos: number }> = [];
	for (let b = 0; b < origins.length; b++) {
		const o = origins[b];
		const a = { kind: 'block' as const, index: b };
		switch (o.kind) {
			case 'expr':
				wrap(o.start, o.end, a);
				break;
			case 'next':
			case 'case':
				insert(o.start, a);
				break;
			case 'top':
				insert(o.start, a);
				break;
			case 'body': {
				const n = (at.get(o.start) ?? []).find(
					(x) => x.start === o.start && x.type === 'BlockStatement'
				);
				if (n) insert(o.start + 1, a);
				else {
					const st = (at.get(o.start) ?? []).find(
						(x) => x.start === o.start && x.end > x.start && /Statement|Declaration/.test(x.type)
					);
					if (!st) break;
					const extent = (st.end - st.start) * 2 + 3;
					const marks = STMT_MARKS.map(([r, at]) => [r, at + 1] as [Role, number]);
					edits.push({ pos: o.start, text: '{' + STMT, order: 2, extent, marks, anchor: a });
					edits.push({ pos: st.end, text: '}', order: 0, extent, marks: [], anchor: null });
				}
				break;
			}
			case 'entry': {
				const n = (at.get(o.start) ?? []).find(
					(x) => x.type === 'BlockStatement' || x.type === 'FunctionBody'
				);
				if (n) insert(list_start(n), a);
				else fixed.push({ index: b, pos: o.start }); // an arrow's expression body: its calls
				break;
			}
			case 'static': {
				const n = (at.get(o.start) ?? []).find((x) => x.type === 'StaticBlock');
				if (n) insert(list_start(n), a);
				break;
			}
			case 'optional': {
				fixed.push({ index: b, pos: o.start });
				// the whole chain, counted: when it never ran V8 has no range for its `?.`
				let chain: Node | null = null;
				for (const list of at.values())
					for (const n of list)
						if (
							n.type === 'ChainExpression' &&
							n.start <= o.start &&
							o.start < n.end &&
							(!chain || n.start >= chain.start)
						)
							chain = n;
				if (chain) wrap(chain.start, chain.end, { kind: 'guard', index: b });
				break;
			}
		}
	}

	const site_anchor: Array<Anchor | null> = Array.from({ length: sites.length }, () => null);
	const site_fixed: Array<{ index: number; pos: number }> = [];
	for (let s = 0; s < sites.length; s++) {
		const site = sites[s];
		if (!site.alloc) continue;
		const start = (lines[site.line - 1] ?? 0) + site.col;
		const a = { kind: 'site' as const, index: s };
		if (site.kind === 'promise' || site.kind === 'arguments' || site.kind === 'rest') {
			// one per call: the function's own range
			const fn = (at.get(start) ?? []).find(
				(x) => FUNCTION_TYPES.has(x.type) || x.type === 'FunctionDeclaration'
			);
			if (fn && fn.generator !== true) site_fixed.push({ index: s, pos: start });
			continue;
		}
		const want = SITE_NODES[site.kind];
		if (!want) continue;
		const node = (at.get(start) ?? []).find(want);
		if (!node) continue;
		const parent = parent_of(node);
		if (node.type === 'FunctionDeclaration') {
			// hoisted: made when the statement list it is in starts
			let host = parent;
			if (host && host.type.startsWith('Export')) host = parent_of(host);
			if (host) insert(list_start(host), a);
		} else if (node.type === 'ClassDeclaration') {
			const host = parent && parent.type.startsWith('Export') ? parent : node;
			insert(host.start, a);
		} else if (
			parent &&
			(parent.type === 'MethodDefinition' ||
				(parent.type === 'Property' && (parent.method === true || parent.kind !== 'init')))
		) {
			// a method is made with the class or object literal holding it
			const holder = parent_of(parent);
			const owner = holder?.type === 'ClassBody' ? parent_of(holder) : holder;
			if (!owner) continue;
			if (owner.type === 'ClassDeclaration') {
				const outer = parent_of(owner);
				insert(outer && outer.type.startsWith('Export') ? outer.start : owner.start, a);
			} else wrap(owner.start, owner.end, a);
		} else wrap(node.start, node.end, a);
	}

	edits.sort(
		(x, y) =>
			x.pos - y.pos ||
			x.order - y.order ||
			(x.order === 2 ? y.extent - x.extent : x.extent - y.extent)
	);
	let out = '';
	let cur = 0;
	const shift: Array<[number, number]> = [];
	let added = 0;
	for (const e of edits) {
		out += code.slice(cur, e.pos);
		cur = e.pos;
		if (e.anchor) {
			let a: Anchor;
			if (e.anchor.kind === 'guard') a = guards[e.anchor.index] ??= { hit: -1, miss: -1 };
			else {
				const list = e.anchor.kind === 'block' ? block_anchor : site_anchor;
				a = list[e.anchor.index] ??= { hit: -1, miss: -1 };
			}
			for (const [role, at] of e.marks) a[role] = out.length + at;
		}
		out += e.text;
		added += e.text.length;
		shift.push([e.pos, added]);
	}
	out += code.slice(cur);
	const map = (pos: number): number => {
		let s = 0;
		for (const [p, n] of shift) {
			if (p > pos) break;
			s = n;
		}
		return pos + s;
	};
	for (const f of fixed)
		block_anchor[f.index] = { hit: map(f.pos), miss: -1, guard: guards[f.index] };
	for (const f of site_fixed) site_anchor[f.index] = { hit: map(f.pos), miss: -1 };
	return { code: out, blocks: block_anchor, sites: site_anchor, map };
}
