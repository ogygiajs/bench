import { readFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { fileURLToPath } from 'node:url';
import { getHeapSnapshot, getHeapStatistics } from 'node:v8';
import { parseSync } from 'oxc-parser';
import type { BenchCase } from '../bench.ts';
import { Attributor } from './attribute.ts';
import { executed_code } from './plain.ts';
import { Snapshot } from './snapshot.ts';
import type { RawSnapshot, Step } from './snapshot.ts';

/*
 * Leaks (spec 4). On the plain build, in a child with --expose-gc:
 *
 * 1. Warm up one round, then `rounds` rounds of `calls` calls. After each round, two full GCs and
 *    the used heap size. The slope of heap over calls (least squares) is the retained bytes per
 *    call. A case grows when the slope is at least `min_bytes_per_call` and the heap went up in all
 *    but at most one round (one-off caches filled by the first rounds do not make a trend).
 * 2. Only when it grows: heap snapshot A, `confirm` more rounds, GC, snapshot B. Objects alive in B
 *    with ids above A's largest id were allocated by the confirm rounds and are still held. They
 *    are grouped by type (constructor name, `Function`, `string`...); the largest group is the top
 *    retained type. It is a leak when that group holds at least one object per 4 confirm calls.
 * 3. For one object of that type: the shortest strong retainer chain from the GC roots. Walking it
 *    back from the object, the first context variable (a `let`/`const` a closure or the module
 *    keeps alive) names the variable; a closure holding that context gives the module and
 *    function, and the variable's declaration gives the source line.
 */

export interface LeakOptions {
	/** Measured rounds (default 6). */
	rounds?: number;
	/** Calls per round (default 1000). */
	calls?: number;
	/** Confirm rounds between the two snapshots (default 2). */
	confirm?: number;
	/** Retained bytes per call below this are not growth (default 4). */
	min_bytes_per_call?: number;
}

export interface LeakSource {
	module: string;
	/** Function whose closure keeps the variable alive (`<top>` for a module variable). */
	function: string;
	variable: string;
	/** Line of the variable's declaration (original source). */
	line: number;
}

export interface LeakResult {
	leaked: boolean;
	calls: number;
	/** Used heap after each measured round (after GC). */
	heap: number[];
	bytes_per_call: number;
	grows: boolean;
	retained: { type: string; count: number; bytes: number; per_call: number } | null;
	chain: Step[] | null;
	source: LeakSource | null;
}

const gc = (globalThis as { gc?: () => void }).gc;

function used_heap(): number {
	gc!();
	gc!();
	return getHeapStatistics().used_heap_size;
}

async function round(c: BenchCase, calls: number): Promise<void> {
	for (let i = 0; i < calls; i++) {
		const ctx = c.setup ? await c.setup() : undefined;
		await c.fn(ctx);
		if (c.teardown) await c.teardown(ctx);
	}
}

function slope(ys: number[], step: number): number {
	const n = ys.length;
	if (n < 2) return 0;
	const mx = ((n - 1) * step) / 2;
	const my = ys.reduce((a, b) => a + b, 0) / n;
	let num = 0;
	let den = 0;
	for (let i = 0; i < n; i++) {
		num += (i * step - mx) * (ys[i] - my);
		den += (i * step - mx) ** 2;
	}
	return num / den;
}

async function snapshot_text(): Promise<string> {
	const chunks: string[] = [];
	for await (const chunk of getHeapSnapshot()) chunks.push(String(chunk));
	return chunks.join('');
}

async function take_snapshot(): Promise<Snapshot> {
	return new Snapshot(JSON.parse(await snapshot_text()) as RawSnapshot);
}

/**
 * The largest node id of a snapshot, read off the text without parsing it: parsing would create
 * thousands of strings and arrays that are still in the heap (internalized) when the second
 * snapshot is taken, and would look like a leak.
 */
async function snapshot_max_id(): Promise<number> {
	const text = await snapshot_text();
	const meta_at = text.indexOf('"node_fields"');
	const fields_end = text.indexOf(']', meta_at);
	const fields = text.slice(text.indexOf('[', meta_at) + 1, fields_end).split(',');
	const nf = fields.length;
	const id_field = fields.findIndex((f) => f.trim() === '"id"');
	let i = text.indexOf('[', text.indexOf('"nodes"')) + 1;
	let field = 0;
	let value = 0;
	let max = 0;
	for (; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		if (ch >= 48 && ch <= 57) {
			value = value * 10 + (ch - 48);
		} else if (ch === 44 || ch === 93) {
			if (field === id_field && value > max) max = value;
			field = (field + 1) % nf;
			value = 0;
			if (ch === 93) break;
		}
	}
	return max;
}

export async function find_leaks(
	c: BenchCase,
	root: string,
	o: LeakOptions = {}
): Promise<LeakResult> {
	if (!gc) throw new Error('abax: leak checks need --expose-gc');
	const rounds = o.rounds ?? 6;
	const calls = o.calls ?? 1000;
	const confirm = o.confirm ?? 2;
	const min = o.min_bytes_per_call ?? 4;

	await round(c, calls);
	const heap: number[] = [used_heap()];
	for (let r = 0; r < rounds; r++) {
		await round(c, calls);
		heap.push(used_heap());
	}
	let ups = 0;
	for (let i = 1; i < heap.length; i++) if (heap[i] > heap[i - 1]) ups++;
	const per_call = slope(heap, calls);
	const grows = per_call >= min && ups >= heap.length - 2;
	const result: LeakResult = {
		leaked: false,
		calls,
		heap,
		bytes_per_call: Math.round(per_call * 100) / 100,
		grows,
		retained: null,
		chain: null,
		source: null
	};
	if (!grows) return result;

	const max_id = await snapshot_max_id();
	gc();
	await round(c, calls * confirm);
	gc();
	gc();

	const session = new Session();
	session.connect();
	const scripts = new Map<number, string>();
	session.on('Debugger.scriptParsed', (m) => {
		scripts.set(Number(m.params.scriptId), m.params.url);
	});
	await session.post('Debugger.enable');
	const b = await take_snapshot();
	await session.post('Debugger.disable');
	session.disconnect();

	const groups = new Map<string, { count: number; bytes: number; nodes: number[] }>();
	for (let n = 0; n < b.node_count; n++) {
		if (b.id(n) <= max_id) continue;
		const t = b.type(n);
		if (t === 'hidden' || t === 'code' || t === 'synthetic' || t === 'object shape') continue;
		const k = b.kind(n);
		const g = groups.get(k);
		if (g) {
			g.count++;
			g.bytes += b.self_size(n);
			g.nodes.push(n);
		} else {
			groups.set(k, { count: 1, bytes: b.self_size(n), nodes: [n] });
		}
	}
	let top: [string, { count: number; bytes: number; nodes: number[] }] | null = null;
	for (const e of groups) if (!top || e[1].count > top[1].count) top = e;
	if (!top) return result;
	const confirm_calls = calls * confirm;
	result.retained = {
		type: top[0],
		count: top[1].count,
		bytes: top[1].bytes,
		per_call: Math.round((top[1].count / confirm_calls) * 1000) / 1000
	};
	result.leaked = top[1].count * 4 >= confirm_calls;
	if (!result.leaked) return result;
	// A few objects of the group, spread over the confirm rounds: the newest few can still be held
	// by the run that just ended (a pending microtask, a register). The chain that reaches a source
	// variable wins; otherwise the first chain found.
	const attributor = new Attributor(root);
	const list = top[1].nodes;
	for (const at of [0.5, 0.25, 0.75, 0.1, 0.9]) {
		const path = b.retainer_path(list[Math.floor(at * (list.length - 1))]);
		if (!path) continue;
		const source = source_of(b, path, scripts, attributor);
		if (!result.chain || source) {
			result.chain = path.steps;
			result.source = source;
		}
		if (source) break;
	}
	return result;
}

function source_of(
	snap: Snapshot,
	path: { nodes: number[]; steps: Step[] },
	scripts: Map<number, string>,
	attributor: Attributor
): LeakSource | null {
	for (let i = path.steps.length - 2; i >= 0; i--) {
		const step = path.steps[i];
		if (step.edge_type !== 'context') continue;
		const variable = step.edge;
		// Any closure holding the context names the module (the module's functions all share one).
		for (const fn of snap.closures_of(path.nodes[i])) {
			const loc = snap.location(fn);
			const url = loc ? scripts.get(loc.script) : undefined;
			if (!loc || !url || !attributor.wants(url)) continue;
			const src = SourceFile.of(url);
			if (!src) continue;
			const closure_at = Math.min(src.offset(loc.line, loc.col), src.code.length);
			// The function named is the one whose code reaches the variable (the code that keeps
			// adding to it): the first innermost function in the module that reads or writes it.
			const user = src.first_user(variable);
			const at = user ?? closure_at;
			const pos = src.position(at);
			const ref = attributor.at(url, pos.line0, pos.col0);
			if (!ref) continue;
			return {
				module: ref.module,
				function: user === null ? '<top>' : ref.path,
				variable,
				line: src.declaration_line(variable, at) ?? ref.line
			};
		}
	}
	return null;
}

interface AstNode {
	type: string;
	start: number;
	end: number;
	[key: string]: unknown;
}

const FUNCTION_TYPES = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression'
]);

function walk(n: unknown, visit: (node: AstNode) => void): void {
	if (Array.isArray(n)) {
		for (const x of n) walk(x, visit);
		return;
	}
	if (n === null || typeof n !== 'object') return;
	const node = n as AstNode;
	if (typeof node.type === 'string') visit(node);
	for (const k in node) if (k !== 'parent') walk(node[k], visit);
}

/** A module's executed code, parsed once, for the questions a leak report asks of it. */
class SourceFile {
	static #cache = new Map<string, SourceFile | null>();
	code: string;
	program: unknown;

	constructor(code: string, program: unknown) {
		this.code = code;
		this.program = program;
	}

	static of(url: string): SourceFile | null {
		const key = url.split('?')[0];
		if (!SourceFile.#cache.has(key)) {
			let sf: SourceFile | null = null;
			try {
				const filename = fileURLToPath(key);
				const code = executed_code(filename, readFileSync(filename, 'utf8')).code;
				const lang = filename.endsWith('.ts') ? 'ts' : 'js';
				sf = new SourceFile(
					code,
					parseSync(filename, code, { sourceType: 'module', lang }).program
				);
			} catch {
				sf = null;
			}
			SourceFile.#cache.set(key, sf);
		}
		return SourceFile.#cache.get(key)!;
	}

	offset(line0: number, col0: number): number {
		let at = 0;
		for (let l = 0; l < line0; l++) at = this.code.indexOf('\n', at) + 1;
		return at + col0;
	}

	line_of(offset: number): number {
		let line = 1;
		for (let i = 0; i < offset; i++) if (this.code.charCodeAt(i) === 10) line++;
		return line;
	}

	/** Line of the declaration of `name` nearest before `at` (else the first one), 1-based. */
	declaration_line(name: string, at: number): number | null {
		let best = -1;
		let first = -1;
		walk(this.program, (node) => {
			const decl =
				node.type === 'VariableDeclarator' ||
				node.type === 'FunctionDeclaration' ||
				node.type === 'ClassDeclaration';
			const id = decl ? (node.id as { type: string; name: string } | null) : null;
			if (!id || id.type !== 'Identifier' || id.name !== name) return;
			if (first === -1) first = node.start;
			if (node.start <= at && node.start > best) best = node.start;
		});
		const pos = best !== -1 ? best : first;
		return pos === -1 ? null : this.line_of(pos);
	}

	position(offset: number): { line0: number; col0: number } {
		const line0 = this.line_of(offset) - 1;
		const start = this.code.lastIndexOf('\n', offset - 1) + 1;
		return { line0, col0: offset - start };
	}

	/**
	 * Start of the first function (in source order) whose own code names `name` outside a
	 * declaration of it, the innermost such function; null when only module code does.
	 */
	first_user(name: string): number | null {
		const fns: AstNode[] = [];
		walk(this.program, (node) => {
			if (FUNCTION_TYPES.has(node.type)) fns.push(node);
		});
		const declared = new Set<AstNode>();
		walk(this.program, (node) => {
			if (node.type === 'VariableDeclarator' || node.type === 'FunctionDeclaration') {
				const id = node.id as AstNode | null;
				if (id) declared.add(id);
			}
		});
		let best: AstNode | null = null;
		walk(this.program, (node) => {
			if (node.type !== 'Identifier' || node.name !== name || declared.has(node)) return;
			let inner: AstNode | null = null;
			for (const f of fns) {
				if (f.start <= node.start && f.end >= node.end && (!inner || f.start >= inner.start))
					inner = f;
			}
			if (inner && (!best || inner.start < best.start)) best = inner;
		});
		return best ? (best as AstNode).start : null;
	}
}
