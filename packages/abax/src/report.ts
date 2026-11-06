import { EDGE_KEY_SHIFT } from './runtime/index.ts';
import type { Runtime, Snapshot } from './runtime/index.ts';
import { op_price_vector } from './prices.ts';
import type { EngineReport } from './engine/types.ts';
import type { GrowthReport } from './growth/index.ts';
import type { SearchReport } from './search/index.ts';

/*
 * The report (JSON, versioned). One entry per bench case; inside, every function the case ran.
 *
 * Identity: a function is `module > path` (`router/match.ts > Router > match`); a block is its
 * function id plus the block index (`router/match.ts > Router > match > block 4`). Lines are
 * original source lines (TS, .svelte), and are what the PR vs base diff maps through git.
 *
 * self_steps     = sum(block count * block price) + dynamic costs (spread, strings, rest)
 *                  + priced built-in calls made by the function
 * inclusive_steps = every step run while the function was on the shadow stack (once if recursive)
 * allocations    = allocation sites executed (a site runs once per run of its block)
 * bytes          = estimated V8 bytes of those allocations (layout.ts)
 */

export const REPORT_SCHEMA = 'abax-report/1';

export interface BlockReport {
	/** Stable identity: `module > function path > block index`. */
	id: string;
	/** Block index inside the function. */
	index: number;
	line: number;
	count: number;
	price: number;
	steps: number;
}

export interface SiteReport {
	kind: string;
	line: number;
	count: number;
	bytes: number;
}

export interface BuiltinReport {
	name: string;
	/** 0 when the call shape gave no site (charged to the function, not a line). */
	line: number;
	calls: number;
	steps: number;
}

export interface LineReport {
	line: number;
	steps: number;
	allocations: number;
	bytes: number;
}

export interface FunctionReport {
	/** `module > path`. */
	id: string;
	module: string;
	path: string;
	kind: string;
	line: number;
	end_line: number;
	calls: number;
	self_steps: number;
	inclusive_steps: number;
	allocations: number;
	bytes: number;
	/** Block prices in order: the body's shape, for rename matching. */
	shape: number[];
	blocks: BlockReport[];
	sites: SiteReport[];
	builtins: BuiltinReport[];
	lines: LineReport[];
}

export interface EdgeReport {
	from: string;
	to: string;
	count: number;
}

export interface CaseReport {
	name: string;
	file: string;
	/** Both measured runs produced exactly the same counts. */
	stable: boolean;
	timers: number;
	runaway_timers: boolean;
	error: string | null;
	totals: { steps: number; allocations: number; bytes: number; calls: number };
	functions: FunctionReport[];
	edges: EdgeReport[];
}

export interface Report {
	schema: typeof REPORT_SCHEMA;
	prices: { version: number; hash: string };
	node: string;
	/** `prefix`: the run root relative to the git top level (module ids are relative to the root). */
	git: { sha: string | null; prefix: string };
	cases: CaseReport[];
	/** `abax health`: what V8 did with the uninstrumented code (spec 5). */
	engine?: EngineReport;
	/** `abax growth`: steps over scaled inputs and their curve class (spec 9). */
	growth?: GrowthReport;
	/** `abax search`: the slowest input of each case's size found (spec 9). */
	search?: SearchReport;
}

export const ROOT_ID = '<root>';

function round(n: number): number {
	return Math.round(n * 1e6) / 1e6;
}

/** Function ids of every fid the runtime knows. */
export function function_ids(rt: Runtime): string[] {
	const ids: string[] = [];
	for (const m of rt.modules) {
		for (const f of m.meta.functions) ids.push(`${m.meta.id} > ${f.path}`);
	}
	return ids;
}

export function build_case_report(
	rt: Runtime,
	snap: Snapshot,
	info: {
		name: string;
		file: string;
		stable: boolean;
		timers: number;
		runaway: boolean;
		error: string | null;
	}
): CaseReport {
	const prices = op_price_vector(rt.prices);
	const ids = function_ids(rt);
	const functions: FunctionReport[] = [];
	let total_allocs = 0;
	let total_bytes = 0;
	let total_calls = 0;

	// built-in charges with no site, per fid
	const unsited = new Map<number, BuiltinReport[]>();
	for (const key of Object.keys(snap.unsited)) {
		const k = Number(key);
		const fid = Math.floor(k / 256);
		const name = rt.names[k % 256] ?? '?';
		const list = unsited.get(fid) ?? [];
		list.push({
			name,
			line: 0,
			calls: snap.unsited_calls[key] ?? 0,
			steps: round(snap.unsited[key])
		});
		unsited.set(fid, list);
	}

	for (let mi = 0; mi < rt.modules.length && mi < snap.modules.length; mi++) {
		const mod = rt.modules[mi];
		const meta = mod.meta;
		const { c, d } = snap.modules[mi];
		const per_fn = meta.functions.map((f, i) => ({
			meta: f,
			fid: mod.f + i,
			self: 0,
			allocations: 0,
			bytes: 0,
			ran: false,
			blocks: [] as BlockReport[],
			sites: [] as SiteReport[],
			builtins: [] as BuiltinReport[],
			lines: new Map<number, LineReport>()
		}));
		const line_of = (fi: number, line: number): LineReport => {
			const lines = per_fn[fi].lines;
			let l = lines.get(line);
			if (!l) {
				l = { line, steps: 0, allocations: 0, bytes: 0 };
				lines.set(line, l);
			}
			return l;
		};
		for (let bi = 0; bi < meta.blocks.length; bi++) {
			const b = meta.blocks[bi];
			const count = c[bi];
			const f = per_fn[b.fn];
			f.blocks.push({
				id: `${ids[f.fid]} > block ${b.index}`,
				index: b.index,
				line: b.line,
				count,
				price: b.price,
				steps: round(count * b.price)
			});
			if (count === 0) continue;
			f.ran = true;
			f.self += count * b.price;
			for (let i = 0; i < b.line_ops.length; i += 3) {
				const steps = count * b.line_ops[i + 2] * prices[b.line_ops[i + 1]];
				if (steps !== 0) line_of(b.fn, b.line_ops[i]).steps += steps;
			}
		}
		for (let si = 0; si < meta.sites.length; si++) {
			const s = meta.sites[si];
			const count = c[s.block];
			const dyn_bytes = d[2 * si];
			const dyn_steps = d[2 * si + 1];
			if (count === 0 && dyn_steps === 0) continue;
			const f = per_fn[s.fn];
			f.self += dyn_steps;
			const l = line_of(s.fn, s.line);
			l.steps += dyn_steps;
			if (!s.alloc) continue;
			const bytes = count * s.bytes + dyn_bytes;
			f.allocations += count;
			f.bytes += bytes;
			l.allocations += count;
			l.bytes += bytes;
			f.sites.push({ kind: s.kind, line: s.line, count, bytes: round(bytes) });
		}
		for (let k = 0; k < meta.bsites.length; k++) {
			const steps = snap.bsite_steps[mod.b + k] ?? 0;
			if (steps === 0) continue;
			const bs = meta.bsites[k];
			const f = per_fn[bs.fn];
			f.self += steps;
			line_of(bs.fn, bs.line).steps += steps;
			f.builtins.push({
				name: bs.name,
				line: bs.line,
				calls: snap.bsite_calls[mod.b + k],
				steps: round(steps)
			});
		}
		for (const f of per_fn) {
			const extra = unsited.get(f.fid);
			if (extra) {
				for (const e of extra) f.self += e.steps;
				f.builtins.push(...extra);
			}
			const calls = snap.calls[f.fid] ?? 0;
			if (!f.ran && calls === 0 && !extra) continue;
			total_allocs += f.allocations;
			total_bytes += f.bytes;
			total_calls += calls;
			const lines = [...f.lines.values()]
				.filter((l) => l.steps !== 0 || l.allocations !== 0)
				.map((l) => ({
					line: l.line,
					steps: round(l.steps),
					allocations: l.allocations,
					bytes: round(l.bytes)
				}))
				.sort((a, b) => a.line - b.line);
			functions.push({
				id: ids[f.fid],
				module: meta.id,
				path: f.meta.path,
				kind: f.meta.kind,
				line: f.meta.line,
				end_line: f.meta.end_line,
				calls,
				self_steps: round(f.self),
				inclusive_steps: round(snap.incl[f.fid] ?? 0),
				allocations: f.allocations,
				bytes: round(f.bytes),
				shape: f.blocks.map((b) => b.price),
				blocks: f.blocks,
				sites: f.sites,
				builtins: f.builtins,
				lines
			});
		}
	}

	const edges: EdgeReport[] = [];
	for (const key of Object.keys(snap.edges)) {
		const k = Number(key);
		const caller = Math.floor(k / EDGE_KEY_SHIFT) - 1;
		const callee = k % EDGE_KEY_SHIFT;
		edges.push({
			from: caller < 0 ? ROOT_ID : ids[caller],
			to: ids[callee],
			count: snap.edges[key]
		});
	}
	edges.sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1));
	functions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	return {
		name: info.name,
		file: info.file,
		stable: info.stable,
		timers: info.timers,
		runaway_timers: info.runaway,
		error: info.error,
		totals: {
			steps: round(snap.steps),
			allocations: total_allocs,
			bytes: round(total_bytes),
			calls: total_calls
		},
		functions,
		edges
	};
}
