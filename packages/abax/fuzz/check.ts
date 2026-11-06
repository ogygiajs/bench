import { createHash } from 'node:crypto';
import { same_counts } from '../src/runtime/index.ts';
import { count_of, same_trace } from './lab.ts';
import type { Counted, Lab, Loaded } from './lab.ts';
import { offset_of } from './ast.ts';
import { Reference, ROOT, abax_edges, diff_maps } from './callgraph.ts';

/*
 * The per-program oracles:
 *
 *   semantics    the instrumented program does what the plain one does: same logged values in
 *                the same order, same result or error (oracle 1)
 *   counts       every block's count equals V8's count for that code, every function's calls
 *                equal V8's (oracle 2)
 *   allocations  every allocation site's count equals V8's count at the allocation (oracle 4)
 *   callgraph    every caller -> callee edge equals the reference's (V8 stack traces), inclusive
 *                steps equal the reference's frame model (oracle 3)
 *   determinism  counted again on a fresh copy of the module: the same report (oracle 5)
 *   probe        (the fuzzer's own check) the probed program still does what the plain one does
 */

export type Oracle =
	| 'semantics'
	| 'counts'
	| 'allocations'
	| 'callgraph'
	| 'determinism'
	| 'probe'
	| 'diff'
	| 'maps'
	| 'runtime'
	| 'corpus'
	| 'crash';

export interface Failure {
	oracle: Oracle;
	detail: string;
}

export interface Checked {
	failures: Failure[];
	/** Hash of the counted report (compared across processes). */
	hash: string;
	/** Blocks and sites compared. */
	blocks: number;
	sites: number;
	/** Sites run fewer times than their block because an exception left the block midway. */
	cut_short: number;
}

export interface CheckOptions {
	/** Only these oracles (default all). */
	only?: Set<Oracle>;
	/**
	 * The program recurses until the stack overflows. Where it overflows depends on how big each
	 * frame is (instrumented or not, interpreted or optimized), so its counts differ from run to run
	 * by nature: only what it does (a RangeError surfacing the same) is checked.
	 */
	deep?: boolean;
}

export async function check_program(lab: Lab, l: Loaded, o: CheckOptions = {}): Promise<Checked> {
	const want = (x: Oracle): boolean => (!o.only || o.only.has(x)) && (!o.deep || x === 'semantics');
	const failures: Failure[] = [];
	const out: Checked = { failures, hash: '', blocks: 0, sites: 0, cut_short: 0 };

	const plain = await lab.plain(l);
	const ref = new Reference(lab.rt, l);
	if (want('callgraph')) lab.around = { before: () => ref.install(), after: () => ref.uninstall() };
	let a: Counted;
	try {
		a = await lab.counted(l);
	} finally {
		lab.around = {};
	}
	// the module's name is the order it was loaded in this process: not part of what is compared
	const report = JSON.stringify(a.report).split(l.module_id).join('p.mjs');
	out.hash = createHash('sha1').update(report).digest('hex').slice(0, 16);
	const sem = same_trace(plain, a.trace);
	if (sem) {
		failures.push({ oracle: 'semantics', detail: sem });
		return out;
	}

	if (want('determinism')) {
		const b = await lab.counted(l, true);
		const d = same_trace(plain, b.trace);
		if (d)
			failures.push({ oracle: 'determinism', detail: `second run differs in what it does: ${d}` });
		else if (
			!same_counts(a.snap, b.snap) ||
			JSON.stringify(a.report) !== JSON.stringify(b.report)
		) {
			failures.push({ oracle: 'determinism', detail: first_report_difference(a, b) });
		}
	}

	if (want('callgraph')) {
		const mine = abax_edges(a.report.edges, l.module_id);
		const e = diff_maps(mine, ref.edges);
		if (e) failures.push({ oracle: 'callgraph', detail: `edge ${e} (abax vs V8 stacks)` });
		else {
			const model = diff_maps(mine, ref.model_edges);
			if (model)
				failures.push({ oracle: 'callgraph', detail: `edge ${model} (abax vs frame model)` });
			const m = lab.module_of(l);
			for (let i = 0; i < m.meta.functions.length; i++) {
				const fid = m.f + i;
				const x = a.snap.incl[fid] ?? 0;
				const y = ref.incl.get(fid) ?? 0;
				if (Math.abs(x - y) > 1e-6 * Math.max(1, Math.abs(y))) {
					failures.push({
						oracle: 'callgraph',
						detail: `inclusive steps of ${m.meta.functions[i].path}: ${x} vs ${y} (frame model)`
					});
					break;
				}
			}
		}
	}

	if (o.deep || !(want('counts') || want('allocations') || want('probe'))) return out;
	const cov = await lab.coverage(l);
	const pt = same_trace(plain, cov.trace);
	if (pt) {
		failures.push({ oracle: 'probe', detail: `the probed program differs: ${pt}` });
		return out;
	}
	const m = a.module;
	const mi = lab.rt.modules.indexOf(m);
	const c = a.snap.modules[mi].c;
	const meta = m.meta;
	if (want('counts')) {
		for (let b = 0; b < meta.blocks.length; b++) {
			const anchor = l.probed.blocks[b];
			// an arrow's expression body has no counter of its own: its count is its calls (below)
			if (!anchor || (l.inst.origins[b].kind === 'entry' && anchor.miss < 0)) continue;
			const v8 = count_of(cov.ranges, anchor);
			out.blocks++;
			if (v8 === null || v8 !== c[b]) {
				const blk = meta.blocks[b];
				const fn = meta.functions[blk.fn];
				failures.push({
					oracle: 'counts',
					detail: `${fn.path} > block ${blk.index} (${l.inst.origins[b].kind}, line ${blk.line}:${blk.col}): abax ${c[b]}, V8 ${v8}`
				});
				break;
			}
		}
		for (let i = 0; i < meta.functions.length; i++) {
			const f = meta.functions[i];
			if (f.kind !== 'function' || f.generator) continue;
			const info = l.ast.fns.find((x) => x.start === offset_of(l.ast.lines, f.line, f.col));
			if (!info) {
				failures.push({ oracle: 'counts', detail: `${f.path}: no function at ${f.line}:${f.col}` });
				break;
			}
			// A call counts when the body starts (one whose parameters throw is not counted): V8's
			// count of the counter at the top of the body. An arrow's expression body has none: V8's
			// own range of the function, which starts at it (a method's at its key); a function V8
			// compiled away as dead code has none, and was never called.
			let v8: number | null = 0;
			const entry = meta.blocks.findIndex(
				(blk, bi) => blk.fn === i && l.inst.origins[bi].kind === 'entry'
			);
			const entry_anchor = entry >= 0 ? l.probed.blocks[entry] : null;
			if (entry_anchor && entry_anchor.miss >= 0) v8 = count_of(cov.ranges, entry_anchor);
			else {
				const lower = l.probed.map(l.ast.members.get(info.start) ?? info.start);
				const upper = l.probed.map(info.start);
				const body = l.probed.map(info.body_start);
				let best: { start: number; end: number; count: number } | null = null;
				for (const r of cov.fns)
					if (r.start <= body && body < r.end && (!best || r.start >= best.start)) best = r;
				if (best && best.start >= lower && best.start <= upper) v8 = best.count;
			}
			const calls = a.snap.calls[m.f + i];
			if (v8 !== calls) {
				failures.push({ oracle: 'counts', detail: `${f.path}: calls abax ${calls}, V8 ${v8}` });
				break;
			}
		}
	}
	if (want('allocations')) {
		for (let s = 0; s < meta.sites.length; s++) {
			const site = meta.sites[s];
			if (!site.alloc) continue;
			const pos = l.probed.sites[s];
			if (!pos) continue;
			out.sites++;
			const v8 = count_of(cov.ranges, pos);
			if (v8 !== c[site.block]) {
				// A block counts on entry: when an exception leaves it midway, what follows the throw is
				// counted as run (Abax's model, documented in the report). That is the only way V8 may see
				// fewer runs of the allocation than of its block's start.
				const block_anchor = l.probed.blocks[site.block];
				const v8_block = block_anchor ? count_of(cov.ranges, block_anchor) : null;
				if (v8 !== null && v8_block !== null && v8 < v8_block && c[site.block] === v8_block) {
					out.cut_short++;
					continue;
				}
				failures.push({
					oracle: 'allocations',
					detail: `${meta.functions[site.fn].path}: ${site.kind} at ${site.line}:${site.col}: abax ${c[site.block]}, V8 ${v8}`
				});
				break;
			}
		}
	}
	void ROOT;
	return out;
}

function first_report_difference(a: Counted, b: Counted): string {
	const fa = new Map(a.report.functions.map((f) => [f.id, f]));
	for (const f of b.report.functions) {
		const g = fa.get(f.id);
		if (!g) return `function ${f.id} only in the second run`;
		if (JSON.stringify(f) !== JSON.stringify(g)) {
			for (const k of Object.keys(f) as Array<keyof typeof f>) {
				if (JSON.stringify(f[k]) !== JSON.stringify(g[k]))
					return `${f.id}: ${String(k)} ${JSON.stringify(g[k]).slice(0, 200)} vs ${JSON.stringify(f[k]).slice(0, 200)}`;
			}
		}
	}
	if (a.report.functions.length !== b.report.functions.length) return 'function lists differ';
	return `totals ${JSON.stringify(a.report.totals)} vs ${JSON.stringify(b.report.totals)}, edges ${a.report.edges.length} vs ${b.report.edges.length}`;
}
