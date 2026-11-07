import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import type { SourceMapInput } from '@jridgewell/trace-mapping';
import type { AsyncFrame, Runtime } from '../src/runtime/index.ts';
import { fn_starting_near, index_ast, offset_of } from './ast.ts';
import type { AstIndex } from './ast.ts';
import type { Loaded } from './lab.ts';

/*
 * The call-graph reference (oracle 3), kept apart from the runtime's own bookkeeping:
 *
 * - Callers come from V8: at every function entry the reference takes a stack trace and walks it
 *   to the first frame that is running program code inside a function body. That function is the
 *   caller (the module body, or no program frame at all, is the root). Frames V8 shows for code
 *   that is not in a body yet (default parameters, field initialisers, a constructor before its
 *   body) and `await`ing frames (`at async f`, not running) are passed over.
 * - Inclusive steps come from a frame model of its own: a frame knows the frame it was called
 *   from (its parent) and the frame that was running when it was last resumed (its outer). Between
 *   two events (entry, exit, suspension, resumption) the steps counted so far go to every distinct
 *   function on the current frame's parent chain, once.
 *
 * The runtime's entry points are wrapped while the counted run is in its window; the wrappers call
 * through to the real ones, so the counts are untouched.
 */

interface RefFrame {
	fid: number;
	parent: RefFrame | null;
	outer: RefFrame | null;
	running: boolean;
}

export const ROOT = '<root>';

export class Reference {
	rt: Runtime;
	l: Loaded;
	/** `caller -> callee` (function ids `module > path`) -> count, from V8's stacks. */
	edges = new Map<string, number>();
	/** fid -> inclusive steps, from the frame model. */
	incl = new Map<number, number>();
	/** Same edges seen by the frame model (a cross-check of the model, not of the runtime). */
	model_edges = new Map<string, number>();
	#cur: RefFrame | null = null;
	#last = 0;
	#frames = new WeakMap<AsyncFrame, RefFrame>();
	#saved: Record<string, unknown> = {};
	#busy = 0;
	#map: TraceMap;
	/** The instrumented code's own functions (V8 reports positions in it). */
	#gen: AstIndex;
	/** Function start offset (original code) -> heisenbench function id. */
	#id_at = new Map<number, string>();
	#ids: string[];
	#base = 0;
	#url: string;
	#stack_limit = 10;

	constructor(rt: Runtime, l: Loaded) {
		this.rt = rt;
		this.l = l;
		this.#map = new TraceMap(l.inst.map as unknown as SourceMapInput);
		this.#gen = index_ast(l.inst.code);
		this.#url = l.inst_url;
		const lines = l.ast.lines;
		for (const f of l.inst.meta.functions) {
			if (f.kind !== 'function') continue;
			this.#id_at.set(offset_of(lines, f.line, f.col), `${l.module_id} > ${f.path}`);
		}
		this.#ids = [];
	}

	/** fid -> id, for fids of this module (others are not program code). */
	id_of(fid: number): string | null {
		const m = this.rt.modules.find((x) => x.meta.id === this.l.module_id);
		if (!m) return null;
		const i = fid - m.f;
		if (i < 0 || i >= m.meta.functions.length) return null;
		return `${this.l.module_id} > ${m.meta.functions[i].path}`;
	}

	install(): void {
		const rt = this.rt as unknown as Record<string, (...a: unknown[]) => unknown>;
		const m = this.rt.modules.find((x) => x.meta.id === this.l.module_id);
		this.#base = m ? m.f : 0;
		this.#ids = m ? m.meta.functions.map((f) => `${this.l.module_id} > ${f.path}`) : [];
		this.#stack_limit = Error.stackTraceLimit;
		Error.stackTraceLimit = 200;
		this.#last = this.rt.s[0];
		const wrap = (
			name: string,
			fn: (orig: (...a: unknown[]) => unknown, args: unknown[]) => unknown
		): void => {
			const orig = rt[name];
			this.#saved[name] = orig;
			// always called as a method of the runtime: `this` is `rt`
			rt[name] = (...args: unknown[]): unknown => {
				if (this.#busy > 0) return Reflect.apply(orig, rt, args);
				this.#busy++;
				// the reference's own work (stack traces, maps) must not charge the program
				const r = this.rt;
				const bdepth = r.bdepth;
				const site = r.site;
				r.bdepth = r.depth;
				try {
					return fn((...a) => Reflect.apply(orig, rt, a), args);
				} finally {
					r.bdepth = bdepth;
					r.site = site;
					this.#busy--;
				}
			};
		};
		wrap('enter', (orig, [fid]) => {
			this.#on_enter(fid as number);
			const token = orig(fid);
			return { token, frame: this.#cur };
		});
		wrap('exit', (orig, [tok]) => {
			const t = tok as { token: number; frame: RefFrame };
			this.#tick();
			this.#cur = t.frame.outer;
			return orig(t.token);
		});
		wrap('enter_async', (orig, [fid]) => {
			this.#on_enter(fid as number);
			const fr = orig(fid) as AsyncFrame;
			this.#frames.set(fr, this.#cur!);
			return fr;
		});
		wrap('suspend', (orig, [fr, v]) => {
			this.#suspend(fr as AsyncFrame);
			return orig(fr, v);
		});
		wrap('resume', (orig, [fr, v]) => {
			this.#resume(fr as AsyncFrame);
			return orig(fr, v);
		});
		wrap('exit_async', (orig, [fr]) => {
			const f = this.#frames.get(fr as AsyncFrame);
			if (f) {
				if (!f.running) this.#resume(fr as AsyncFrame);
				this.#tick();
				this.#cur = f.outer;
				f.running = false;
			}
			return orig(fr);
		});
	}

	uninstall(): void {
		this.#tick();
		const rt = this.rt as unknown as Record<string, unknown>;
		for (const k of Object.keys(this.#saved)) rt[k] = this.#saved[k];
		this.#saved = {};
		Error.stackTraceLimit = this.#stack_limit;
	}

	#tick(): void {
		const now = this.rt.s[0];
		const delta = now - this.#last;
		this.#last = now;
		if (delta === 0) return;
		const seen = new Set<number>();
		for (let f = this.#cur; f; f = f.parent) {
			if (seen.has(f.fid)) continue;
			seen.add(f.fid);
			this.incl.set(f.fid, (this.incl.get(f.fid) ?? 0) + delta);
		}
	}

	#on_enter(fid: number): void {
		if (this.#ids.length === 0) {
			// installed before the import that registers the module
			const m = this.rt.modules.find((x) => x.meta.id === this.l.module_id);
			if (m) {
				this.#base = m.f;
				this.#ids = m.meta.functions.map((f) => `${this.l.module_id} > ${f.path}`);
			}
		}
		this.#tick();
		const callee = this.#ids[fid - this.#base] ?? `fid ${fid}`;
		const caller = this.#caller_from_stack();
		const k = `${caller} -> ${callee}`;
		this.edges.set(k, (this.edges.get(k) ?? 0) + 1);
		const model_caller = this.#cur
			? (this.#ids[this.#cur.fid - this.#base] ?? `fid ${this.#cur.fid}`)
			: ROOT;
		const mk = `${model_caller} -> ${callee}`;
		this.model_edges.set(mk, (this.model_edges.get(mk) ?? 0) + 1);
		const f: RefFrame = { fid, parent: this.#cur, outer: this.#cur, running: true };
		this.#cur = f;
	}

	#suspend(fr: AsyncFrame): void {
		const f = this.#frames.get(fr);
		this.#tick();
		if (!f || !f.running) return;
		f.running = false;
		this.#cur = f.outer;
	}

	#resume(fr: AsyncFrame): void {
		const f = this.#frames.get(fr);
		this.#tick();
		if (!f || f.running) return;
		f.outer = this.#cur;
		f.running = true;
		this.#cur = f;
	}

	/** The function running the call, from V8's stack: see the note at the top. */
	#caller_from_stack(): string {
		// V8's call sites: the position each frame is at, and where its function starts (a frame
		// can be at a position inside a nested function's text: a `using` disposal at block end)
		const prepare = Error.prepareStackTrace;
		Error.prepareStackTrace = (_e, sites) => sites;
		const holder: { stack?: unknown } = {};
		Error.captureStackTrace(holder);
		// read before putting it back: the stack is prepared on first read
		const sites = (holder.stack ?? []) as NodeJS.CallSite[];
		Error.prepareStackTrace = prepare;
		let seen_callee = false;
		for (const site of sites) {
			if (site.isAsync()) continue;
			const file = site.getFileName() ?? '';
			const q = file.indexOf('?');
			if ((q === -1 ? file : file.slice(0, q)) !== this.#url) continue;
			if (!seen_callee) {
				seen_callee = true;
				continue;
			}
			// Found in the code V8 runs (code the transform inserted maps to no source position);
			// only the function's start, which is source text, is mapped back.
			const ix = this.#gen;
			const pos = offset_of(ix.lines, site.getLineNumber() ?? 1, (site.getColumnNumber() ?? 1) - 1);
			const fn_pos = offset_of(
				ix.lines,
				site.getEnclosingLineNumber() ?? 1,
				(site.getEnclosingColumnNumber() ?? 1) - 1
			);
			const f = fn_starting_near(ix, fn_pos);
			if (!f) return ROOT;
			// inside a class body, outside any of its methods: an initialiser frame
			const cls = ix.classes.find(([s, e]) => s <= pos && pos < e);
			if (cls && f.start < cls[0]) continue;
			if (pos < f.body_start || pos >= f.body_end) continue;
			return this.#id_of_generated(f.start);
		}
		return ROOT;
	}

	#id_of_generated(start: number): string {
		const lines = this.#gen.lines;
		let line = 0;
		while (line + 1 < lines.length && lines[line + 1] <= start) line++;
		const o = originalPositionFor(this.#map, { line: line + 1, column: start - lines[line] });
		if (o.line == null) return `? generated ${start}`;
		const at = offset_of(this.l.ast.lines, o.line, o.column ?? 0);
		return this.#id_at.get(at) ?? `? ${at}`;
	}
}

/** Heisenbench's edges of one module, `caller -> callee` like the reference. */
export function heisenbench_edges(
	edges: Array<{ from: string; to: string; count: number }>,
	module_id: string
): Map<string, number> {
	const out = new Map<string, number>();
	for (const e of edges) {
		if (!e.to.startsWith(module_id + ' > ')) continue;
		out.set(`${e.from} -> ${e.to}`, e.count);
	}
	return out;
}

export function diff_maps(a: Map<string, number>, b: Map<string, number>, eps = 0): string | null {
	const keys = new Set([...a.keys(), ...b.keys()]);
	for (const k of [...keys].sort()) {
		const x = a.get(k) ?? 0;
		const y = b.get(k) ?? 0;
		if (Math.abs(x - y) > eps) return `${k}: ${x} vs ${y}`;
	}
	return null;
}
