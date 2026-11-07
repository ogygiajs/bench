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
 * Leaks (spec 4). On the plain build, in a child with --expose-gc. Clean code moves the heap too:
 * V8 compiles and re-tiers it, fills inline caches and feedback vectors, and two full GCs leave a
 * few KB either way. Over 1,000 calls that reads as 2 to 20 B a call, up or down. So a leak needs
 * three kinds of evidence, each one clean code cannot give:
 *
 * 1. A/A noise. Three warm-up rounds of `calls` (N) calls (with a run of full GCs after the last
 *    two), then rounds of N, N, 2N and 4N calls, so the heap is read (after two full GCs) at N,
 *    2N, 4N and 8N calls. The first two rounds do the same work; the bytes their growth differs by
 *    is this case's noise. The case's floor is that noise spread over the 8N calls, or
 *    `min_bytes_per_call` when larger, and growth per call over the 8N calls must reach it.
 * 2. Growth linear in calls. A leak keeps about the same bytes per call from the start to 2N, 4N
 *    and 8N calls (a backing store that doubles makes it wobble, not drift); noise, a cache that
 *    fills once or code V8 compiles late does not. Each must be within a factor 2 of the 8N one,
 *    and the heap must already grow by the floor over the first N.
 * 3. A program variable that holds the new objects. Only when 1 and 2 hold: heap snapshot A,
 *    `confirm` more rounds of N, GC, snapshot B. Objects alive in B with ids above A's largest id
 *    were made by the confirm rounds and are still held. Each gets its shortest strong retainer
 *    chain from the GC roots, with engine holders (compiled code, feedback vectors, inline caches,
 *    hidden classes, allocation sites) retaining nothing. Walking the chain back from the object,
 *    the first context variable that a function of a source module keeps alive (a module `let` or
 *    `const`, or one a closure captured) is the owner. Objects with no such owner are the engine's
 *    or the harness's, never a leak. The owned objects are grouped by owner and type; the largest
 *    group is the top retained type, and it is a leak when it holds at least one object per 4
 *    confirm calls. The owner names the variable; the first function of the module that reads or
 *    writes it is the one named, and the variable's declaration gives the source line. (For a
 *    compiled .svelte file the line is a line of the compiled output.)
 *
 * A leak held only by a global property (`globalThis.x`) has no owner variable, so it is not
 * reported.
 */

export interface LeakOptions {
	/** Calls per round, N (default 1000). */
	calls?: number;
	/** Rounds of N calls between the two snapshots (default 2). */
	confirm?: number;
	/** Retained bytes per call below this are not growth, whatever the noise (default 4). */
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
	/** Used heap (after GC) at 0, N, 2N, 4N and 8N calls. */
	heap: number[];
	/** Retained bytes per call over all 8N calls. */
	bytes_per_call: number;
	/** Retained bytes per call from the start to N, 2N, 4N and 8N calls. */
	scales: Array<{ calls: number; bytes_per_call: number }>;
	/** This case's growth floor, B/call: its A/A noise over 8N calls, or the fixed floor. */
	threshold: number;
	/** Steps 1 and 2 hold: growth above the noise, linear in calls. */
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

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Full GCs before the first heap reading. */
const FLUSH_GCS = 12;

/** Calls before each heap reading, in units of N: the rounds are N, N, 2N and 4N calls. */
export const CHECKPOINTS = [0, 1, 2, 4, 8];

/**
 * Steps 1 and 2 from the used heap at each checkpoint: bytes per call at each scale, the case's
 * floor, and whether it grows.
 */
export function judge_growth(
	heap: number[],
	calls: number,
	min: number
): Pick<LeakResult, 'bytes_per_call' | 'scales' | 'threshold' | 'grows'> {
	// A/A: the first two rounds do the same work; what they differ by is this case's noise.
	const noise = Math.abs(heap[1] - heap[0] - (heap[2] - heap[1]));
	const total = CHECKPOINTS[CHECKPOINTS.length - 1] * calls;
	const threshold = Math.max(min, noise / total);
	const scales = CHECKPOINTS.slice(1).map((k, i) => ({
		calls: k * calls,
		bytes_per_call: (heap[i + 1] - heap[0]) / (k * calls)
	}));
	const per = scales.map((s) => s.bytes_per_call);
	const last = per[per.length - 1];
	// Already growing at N; from 2N on, within a factor 2 of the 8N rate. (The first N calls can
	// read far off: a hash table the earlier calls filled may double, or not, inside them.)
	const grows =
		last >= threshold && per[0] >= min && per.slice(1).every((p) => p * 2 >= last && p <= last * 2);
	return {
		bytes_per_call: round2(last),
		scales: scales.map((s) => ({ calls: s.calls, bytes_per_call: round2(s.bytes_per_call) })),
		threshold: round2(threshold),
		grows
	};
}

export async function find_leaks(
	c: BenchCase,
	root: string,
	o: LeakOptions = {}
): Promise<LeakResult> {
	if (!gc) throw new Error('abax: leak checks need --expose-gc');
	const calls = o.calls ?? 1000;
	const confirm = o.confirm ?? 2;
	const min = o.min_bytes_per_call ?? 4;

	// V8 drops the bytecode of functions that sat unused through several full GCs (what loading
	// the bench files ran): left to the measured rounds, that is a one-off drop of megabytes. Three
	// warm-up rounds, with a run of full GCs after the second and the third.
	for (let r = 0; r < 3; r++) {
		await round(c, calls);
		if (r > 0) for (let i = 0; i < FLUSH_GCS; i++) gc();
	}
	const heap: number[] = [used_heap()];
	for (let i = 1; i < CHECKPOINTS.length; i++) {
		await round(c, (CHECKPOINTS[i] - CHECKPOINTS[i - 1]) * calls);
		heap.push(used_heap());
	}
	const result: LeakResult = {
		leaked: false,
		calls,
		heap,
		...judge_growth(heap, calls, min),
		retained: null,
		chain: null,
		source: null
	};
	if (!result.grows) return result;

	const max_id = await snapshot_max_id();
	gc();
	const confirm_calls = calls * confirm;
	await round(c, confirm_calls);
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

	const owners = new Owners(b, scripts, new Attributor(root));
	const tree = b.retainer_tree();
	// The owner of each node: the source module's context variable nearest to it on its chain.
	const owner = new Int32Array(b.node_count).fill(-1);
	for (let i = 1; i < tree.order.length; i++) {
		const n = tree.order[i];
		const p = tree.parent[n];
		const [type, name] = b.edge(tree.via[n]);
		owner[n] = type === 'context' && owners.is_source_context(p) ? owners.id(p, name) : owner[p];
	}
	const groups = new Map<string, { owner: number; type: string; bytes: number; nodes: number[] }>();
	for (let n = 0; n < b.node_count; n++) {
		if (owner[n] === -1 || b.id(n) <= max_id) continue;
		const t = b.type(n);
		if (t === 'hidden' || t === 'code' || t === 'synthetic' || t === 'object shape') continue;
		const type = b.kind(n);
		const key = `${owner[n]}\0${type}`;
		const g = groups.get(key);
		if (g) {
			g.bytes += b.self_size(n);
			g.nodes.push(n);
		} else {
			groups.set(key, { owner: owner[n], type, bytes: b.self_size(n), nodes: [n] });
		}
	}
	let top: { owner: number; type: string; bytes: number; nodes: number[] } | null = null;
	for (const g of groups.values()) if (!top || g.nodes.length > top.nodes.length) top = g;
	if (!top) return result;
	const count = top.nodes.length;
	result.retained = {
		type: top.type,
		count,
		bytes: top.bytes,
		per_call: Math.round((count / confirm_calls) * 1000) / 1000
	};
	result.source = owners.source(top.owner);
	result.chain = b.path(tree, top.nodes[Math.floor((count - 1) / 2)])?.steps ?? null;
	result.leaked = result.source !== null && count * 4 >= confirm_calls;
	return result;
}

/** The context variables of source modules that hold objects, and where each is declared. */
class Owners {
	#snap: Snapshot;
	#scripts: Map<number, string>;
	#attributor: Attributor;
	#closures: Map<number, number[]>;
	#source_ctx = new Map<number, boolean>();
	#ids = new Map<string, number>();
	#vars: Array<{ ctx: number; variable: string }> = [];

	constructor(snap: Snapshot, scripts: Map<number, string>, attributor: Attributor) {
		this.#snap = snap;
		this.#scripts = scripts;
		this.#attributor = attributor;
		this.#closures = snap.context_closures();
	}

	#url(fn: number): string | null {
		const loc = this.#snap.location(fn);
		const url = loc ? this.#scripts.get(loc.script) : undefined;
		return url && this.#attributor.wants(url) ? url : null;
	}

	/** Whether a function of a source module (not a dependency, the bench file or Node) holds it. */
	is_source_context(ctx: number): boolean {
		let yes = this.#source_ctx.get(ctx);
		if (yes === undefined) {
			yes = (this.#closures.get(ctx) ?? []).some((fn) => this.#url(fn) !== null);
			this.#source_ctx.set(ctx, yes);
		}
		return yes;
	}

	id(ctx: number, variable: string): number {
		const key = `${ctx}\0${variable}`;
		let id = this.#ids.get(key);
		if (id === undefined) {
			id = this.#vars.length;
			this.#vars.push({ ctx, variable });
			this.#ids.set(key, id);
		}
		return id;
	}

	source(id: number): LeakSource | null {
		const { ctx, variable } = this.#vars[id];
		// Any closure holding the context names the module (the module's functions all share one).
		for (const fn of this.#closures.get(ctx) ?? []) {
			const url = this.#url(fn);
			const loc = this.#snap.location(fn);
			if (!url || !loc) continue;
			const src = SourceFile.of(url);
			if (!src) continue;
			const closure_at = Math.min(src.offset(loc.line, loc.col), src.code.length);
			// The function named is the one whose code reaches the variable (the code that keeps
			// adding to it): the first innermost function in the module that reads or writes it.
			const user = src.first_user(variable);
			const at = user ?? closure_at;
			const pos = src.position(at);
			const ref = this.#attributor.at(url, pos.line0, pos.col0);
			if (!ref) continue;
			return {
				module: ref.module,
				function: user === null ? '<top>' : ref.path,
				variable,
				line: src.declaration_line(variable, at) ?? ref.line
			};
		}
		return null;
	}
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
