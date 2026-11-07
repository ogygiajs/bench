import { builtinModules } from 'node:module';
import { runInNewContext } from 'node:vm';
import { parseSync } from 'oxc-parser';

/*
 * Inputs that hold functions, kept anyway (the recorder's clone, recorder.ts). structuredClone
 * refuses any function, so a call like `transform(source, { readFile: () => null, path })` (a
 * context of callbacks and a Node module) was "not cloneable" though nothing in it is state. Two
 * kinds of function values are kept, as a tagged plain object a clone and v8.serialize carry:
 *
 *   { [TAG]: 'fn', src }               a function that closes over nothing: every name it reads is
 *                                      its own (a parameter, a local) or a language global. Its
 *                                      source is the whole function, so evaluating it again gives
 *                                      a function that does the same.
 *   { [TAG]: 'module', name }          a Node built-in module (`node:path`), by name
 *   { [TAG]: 'member', name, key }     a function of one (`fs.readFileSync`)
 *
 * A function that reads anything else (an import, a closure variable, `this` of its outer scope)
 * still makes the input not cloneable. `revive` turns the tags back into values for a replay.
 */

const TAG = '__heisenbench_portable';

/** Calls one stand-in takes in one replay before it throws (see revive_one). */
export const STAND_IN_CALLS = 10_000;

type Tagged =
	| { [TAG]: 'fn'; src: string; method: boolean }
	| { [TAG]: 'module'; name: string }
	| { [TAG]: 'member'; name: string; key: string }
	| { [TAG]: 'stand-in'; name: string };

interface Node {
	type: string;
	[key: string]: unknown;
}

/** Names a portable function may read without closing over anything: the language's globals. */
let globals: Set<string> | null = null;

function global_names(): Set<string> {
	if (!globals) {
		globals = new Set(
			Object.getOwnPropertyNames(runInNewContext('globalThis') as Record<string, unknown>)
		);
		for (const n of [
			'undefined',
			'arguments',
			'console',
			'URL',
			'URLSearchParams',
			'TextEncoder',
			'TextDecoder',
			'structuredClone',
			'atob',
			'btoa',
			'Buffer'
		])
			globals.add(n);
	}
	return globals;
}

/** Node built-in module objects and their functions, by identity. */
let modules: { objects: Map<unknown, string>; members: Map<unknown, [string, string]> } | null =
	null;

function builtins(): NonNullable<typeof modules> {
	if (!modules) {
		const objects = new Map<unknown, string>();
		const members = new Map<unknown, [string, string]>();
		for (const short of [...builtinModules].sort()) {
			if (short.startsWith('_') || short.includes('/internal')) continue;
			const name = `node:${short}`;
			let mod: unknown;
			try {
				mod = process.getBuiltinModule(name);
			} catch {
				continue;
			}
			if (mod === null || (typeof mod !== 'object' && typeof mod !== 'function')) continue;
			if (!objects.has(mod)) objects.set(mod, name);
			for (const key of Object.keys(mod as object).sort()) {
				let v: unknown;
				try {
					v = (mod as Record<string, unknown>)[key];
				} catch {
					continue;
				}
				if (typeof v === 'function' && !members.has(v)) members.set(v, [name, key]);
			}
		}
		modules = { objects, members };
	}
	return modules;
}

/** Function text -> whether it closes over nothing (cached: tests pass the same callbacks often). */
const closed = new Map<string, { src: string; method: boolean } | null>();

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

/**
 * Whether the function `fn` (the expression of a parsed function) reads only its own names and the
 * language's globals. Names declared anywhere inside count as its own (a conservative shortcut: a
 * name read in one block and declared in a sibling block counts as bound; the replay then throws
 * and the sample reads as hidden state, never as reproduced by mistake).
 */
function closes_over_nothing(fn: Node): boolean {
	const declared = new Set<string>();
	const read = new Set<string>();
	let outer_this = false;
	const bind = (n: Node | null | undefined): void => {
		if (!n) return;
		if (n.type === 'Identifier') declared.add(n.name as string);
		else if (n.type === 'ObjectPattern') {
			for (const p of n.properties as Node[]) {
				if (p.type === 'RestElement') bind(p.argument as Node);
				else {
					if (p.computed) ref(p.key as Node, true);
					bind(p.value as Node);
				}
			}
		} else if (n.type === 'ArrayPattern') for (const e of n.elements as Node[]) bind(e);
		else if (n.type === 'RestElement') bind(n.argument as Node);
		else if (n.type === 'AssignmentPattern') {
			bind(n.left as Node);
			ref(n.right as Node, true);
		} else ref(n, true);
	};
	const ref = (n: Node | null | undefined, own_this: boolean): void => {
		if (!n) return;
		switch (n.type) {
			case 'Identifier':
				read.add(n.name as string);
				return;
			case 'ThisExpression':
			case 'Super':
				if (!own_this) outer_this = true;
				return;
			case 'MetaProperty':
			case 'BreakStatement':
			case 'ContinueStatement':
				return;
			case 'LabeledStatement':
				ref(n.body as Node, own_this);
				return;
			case 'VariableDeclarator':
				bind(n.id as Node);
				ref(n.init as Node, own_this);
				return;
			case 'FunctionDeclaration':
			case 'FunctionExpression':
			case 'ArrowFunctionExpression': {
				const own = n.type !== 'ArrowFunctionExpression' || own_this;
				if (n.id) bind(n.id as Node);
				for (const p of n.params as Node[]) bind(p);
				ref(n.body as Node, own);
				return;
			}
			case 'ClassDeclaration':
			case 'ClassExpression':
				if (n.id) bind(n.id as Node);
				ref(n.superClass as Node, own_this);
				ref(n.body as Node, true);
				return;
			case 'CatchClause':
				bind(n.param as Node);
				ref(n.body as Node, own_this);
				return;
			case 'MemberExpression':
				ref(n.object as Node, own_this);
				if (n.computed) ref(n.property as Node, own_this);
				return;
			case 'Property':
			case 'MethodDefinition':
			case 'PropertyDefinition':
				if (n.computed) ref(n.key as Node, own_this);
				ref(n.value as Node, own_this);
				return;
			default:
				for (const c of child_nodes(n)) ref(c, own_this);
		}
	};
	// the function itself: an arrow's `this` is its outer scope's
	ref(fn, false);
	if (outer_this) return false;
	const g = global_names();
	for (const name of read) if (!declared.has(name) && !g.has(name)) return false;
	return true;
}

/** The parsed function of `text` (a function's toString), or null. */
function parse_function(text: string): { node: Node; method: boolean } | null {
	for (const [wrapped, method] of [
		[`(${text})`, false],
		[`({${text}})`, true]
	] as const) {
		let program: Node;
		try {
			const r = parseSync('fn.js', wrapped, { sourceType: 'script', lang: 'js' });
			if (r.errors.length > 0) continue;
			program = r.program as unknown as Node;
		} catch {
			continue;
		}
		const body = program.body as Node[];
		if (body.length !== 1 || body[0].type !== 'ExpressionStatement') continue;
		let e = body[0].expression as Node;
		while (e.type === 'ParenthesizedExpression') e = e.expression as Node;
		if (method) {
			const props = e.type === 'ObjectExpression' ? (e.properties as Node[]) : [];
			if (props.length !== 1 || props[0].type !== 'Property' || props[0].kind !== 'init') continue;
			e = props[0].value as Node;
		}
		if (e.type === 'FunctionExpression' || e.type === 'ArrowFunctionExpression')
			return { node: e, method };
	}
	return null;
}

function portable_function(fn: Function): Tagged | null {
	const m = builtins().members.get(fn);
	if (m) return { [TAG]: 'member', name: m[0], key: m[1] };
	let text: string;
	try {
		text = Function.prototype.toString.call(fn);
	} catch {
		return null;
	}
	let hit = closed.get(text);
	if (hit === undefined) {
		const parsed = parse_function(text);
		hit = parsed && closes_over_nothing(parsed.node) ? { src: text, method: parsed.method } : null;
		closed.set(text, hit);
	}
	return hit ? { [TAG]: 'fn', src: hit.src, method: hit.method } : null;
}

class NotPortable extends Error {}

function is_plain(v: object): boolean {
	const p = Object.getPrototypeOf(v);
	return p === Object.prototype || p === null;
}

/**
 * `v` with every function and Node module in it tagged, ready for structuredClone; throws
 * NotPortable at the first function that closes over something.
 */
function tag(v: unknown, seen: Map<unknown, unknown>): unknown {
	if (typeof v === 'function') {
		const mod = builtins().objects.get(v);
		if (mod) return { [TAG]: 'module', name: mod };
		const t = portable_function(v);
		if (t) return t;
		if (!stand_ins) throw new NotPortable();
		stand_ins.used = true;
		return { [TAG]: 'stand-in', name: typeof v.name === 'string' ? v.name : '' };
	}
	if (v === null || typeof v !== 'object') return v;
	const hit = seen.get(v);
	if (hit !== undefined) return hit;
	const mod = builtins().objects.get(v);
	if (mod) return { [TAG]: 'module', name: mod };
	if (Array.isArray(v)) {
		const out: unknown[] = [];
		seen.set(v, out);
		for (let i = 0; i < v.length; i++) out.push(tag(v[i], seen));
		return out;
	}
	if (v instanceof Map) {
		const out = new Map();
		seen.set(v, out);
		for (const [k, x] of v) out.set(tag(k, seen), tag(x, seen));
		return out;
	}
	if (v instanceof Set) {
		const out = new Set();
		seen.set(v, out);
		for (const x of v) out.add(tag(x, seen));
		return out;
	}
	if (is_plain(v)) {
		const out: Record<string, unknown> = {};
		seen.set(v, out);
		for (const k of Object.keys(v)) out[k] = tag((v as Record<string, unknown>)[k], seen);
		return out;
	}
	// Dates, regular expressions, typed arrays, errors, class instances: structuredClone's own
	// rules (a class instance becomes a plain object of its own fields, a function field fails).
	return v;
}

/** structuredClone, or the portable form of an input with functions in it; throws when neither. */
export function portable_clone(v: unknown): unknown {
	try {
		return structuredClone(v);
	} catch (e) {
		if (!(e instanceof Error) || e.name !== 'DataCloneError') throw e;
	}
	let tagged: unknown;
	try {
		tagged = tag(v, new Map());
	} catch (e) {
		if (e instanceof NotPortable)
			throw new DOMException('a function closes over state', 'DataCloneError');
		throw e;
	}
	return structuredClone(tagged);
}

/** Set while a clone may stand a function that closes over state in by a stand-in. */
let stand_ins: { used: boolean } | null = null;

/**
 * A clone like portable_clone, where a function that closes over state is kept as a stand-in
 * (`{ [TAG]: 'stand-in' }`, revived as a function that returns undefined) instead of failing the
 * clone. What it gives a replay is not the input the call had, so such a sample never stands for
 * the call's output (the gate's replay leaves it out); growth counts the work around the callback,
 * which is what it measures. `stand_ins` says whether any function was stood in.
 */
export function clone_with_stand_ins(v: unknown): { value: unknown; stand_ins: boolean } {
	const was = stand_ins;
	stand_ins = { used: false };
	try {
		const tagged = tag(v, new Map());
		return { value: structuredClone(tagged), stand_ins: stand_ins.used };
	} finally {
		stand_ins = was;
	}
}

function is_tagged(v: unknown): v is Tagged {
	return (
		v !== null &&
		typeof v === 'object' &&
		!Array.isArray(v) &&
		typeof (v as Record<string, unknown>)[TAG] === 'string'
	);
}

function revive_one(t: Tagged): unknown {
	if (t[TAG] === 'stand-in') {
		// A loop waiting on what the callback does (`while (frag.lastChild) frag.removeChild(...)`)
		// never ends with a stand-in: past STAND_IN_CALLS calls the replay is not the recorded call.
		let calls = 0;
		const named = {
			[t.name]: () => {
				if (++calls > STAND_IN_CALLS)
					throw new Error(`heisenbench: the stand-in for ${t.name || 'a callback'} ran away`);
				return undefined;
			}
		};
		return named[t.name];
	}
	if (t[TAG] === 'module') return process.getBuiltinModule(t.name);
	if (t[TAG] === 'member')
		return (process.getBuiltinModule(t.name) as Record<string, unknown>)[t.key];
	// oxlint-disable-next-line no-eval
	const made = (0, eval)(t.method ? `({${t.src}})` : `(${t.src})`) as unknown;
	return t.method ? Object.values(made as object)[0] : made;
}

/** A copy of a portable clone's value with its tags turned back into functions and modules. */
export function revive<T>(v: T, seen = new Map<unknown, unknown>()): T {
	if (v === null || typeof v !== 'object') return v;
	if (is_tagged(v)) return revive_one(v) as T;
	const hit = seen.get(v);
	if (hit !== undefined) return hit as T;
	if (Array.isArray(v)) {
		const out: unknown[] = [];
		seen.set(v, out);
		for (let i = 0; i < v.length; i++) out.push(revive(v[i], seen));
		return out as T;
	}
	if (v instanceof Map) {
		const out = new Map();
		seen.set(v, out);
		for (const [k, x] of v) out.set(revive(k, seen), revive(x, seen));
		return out as T;
	}
	if (v instanceof Set) {
		const out = new Set();
		seen.set(v, out);
		for (const x of v) out.add(revive(x, seen));
		return out as T;
	}
	if (is_plain(v)) {
		const out: Record<string, unknown> = {};
		seen.set(v, out);
		for (const k of Object.keys(v)) out[k] = revive((v as Record<string, unknown>)[k], seen);
		return out as T;
	}
	return v;
}

/** Whether a recorded value holds a function or module kept by its portable form. */
export function has_portable(v: unknown, seen = new Set<unknown>()): boolean {
	if (v === null || typeof v !== 'object' || seen.has(v)) return false;
	if (is_tagged(v)) return true;
	seen.add(v);
	const values =
		v instanceof Map ? [...v.keys(), ...v.values()] : v instanceof Set ? [...v] : Object.values(v);
	return values.some((x) => has_portable(x, seen));
}
