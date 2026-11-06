import { Runtime, table } from '../runtime/index.ts';
import type { Snapshot, Table } from '../runtime/index.ts';
import type { ModuleMeta } from '../meta.ts';

/*
 * Counts that leave the process they were counted in (a page, a server child): a Snapshot as
 * plain JSON, the module metas registered so far, and the arithmetic the harness needs on them.
 *
 * Function and site ids are positions in the runtime's registration order, so a Runtime that
 * registers the same metas in the same order (`runtime_for`) reads the counts exactly; the report
 * is then built in Node with the usual build_case_report.
 */

export interface PageCounts {
	/** Module metas registered from `metas_from` on, in registration order. */
	metas: ModuleMeta[];
	metas_from: number;
	modules: Array<{ c: number[]; d: number[] }>;
	calls: number[];
	incl: number[];
	bsite_steps: number[];
	bsite_calls: number[];
	unsited: Table;
	unsited_calls: Table;
	bunits: Table;
	uunits: Table;
	edges: Table;
	steps: number;
}

const to_array = (a: Float64Array): number[] => Array.from(a);

export function serialize_snapshot(rt: Runtime, snap: Snapshot, metas_from = 0): PageCounts {
	const metas: ModuleMeta[] = [];
	for (let i = metas_from; i < rt.modules.length; i++) metas.push(rt.modules[i].meta);
	return {
		metas,
		metas_from,
		modules: snap.modules.map((m) => ({ c: to_array(m.c), d: to_array(m.d) })),
		calls: to_array(snap.calls),
		incl: to_array(snap.incl),
		bsite_steps: to_array(snap.bsite_steps),
		bsite_calls: to_array(snap.bsite_calls),
		unsited: snap.unsited,
		unsited_calls: snap.unsited_calls,
		bunits: snap.bunits,
		uunits: snap.uunits,
		edges: snap.edges,
		steps: snap.steps
	};
}

export function deserialize_snapshot(p: PageCounts): Snapshot {
	const f64 = (a: number[]) => Float64Array.from(a);
	return {
		modules: p.modules.map((m) => ({ c: f64(m.c), d: f64(m.d) })),
		calls: f64(p.calls),
		incl: f64(p.incl),
		bsite_steps: f64(p.bsite_steps),
		bsite_calls: f64(p.bsite_calls),
		unsited: { ...p.unsited },
		unsited_calls: { ...p.unsited_calls },
		bunits: { ...p.bunits },
		uunits: { ...p.uunits },
		edges: { ...p.edges },
		steps: p.steps
	};
}

/** A runtime that knows the same modules, in the same order, as the one that counted. */
export function runtime_for(metas: readonly ModuleMeta[]): Runtime {
	const rt = new Runtime();
	for (const m of metas) rt.module(m);
	return rt;
}

function minus(a: Float64Array, b: Float64Array | undefined): Float64Array {
	const out = a.slice();
	if (b) for (let i = 0; i < b.length && i < out.length; i++) out[i] -= b[i];
	return out;
}

function minus_table(a: Table, b: Table): Table {
	const out = table();
	for (const k of Object.keys(a)) {
		const v = a[k] - (b[k] ?? 0);
		if (v !== 0) out[k] = v;
	}
	return out;
}

/**
 * What ran between two cumulative readings of one runtime (`before` taken first). Modules that
 * registered after `before` count from zero.
 */
export function snapshot_delta(after: Snapshot, before: Snapshot): Snapshot {
	return {
		modules: after.modules.map((m, i) => ({
			c: minus(m.c, before.modules[i]?.c),
			d: minus(m.d, before.modules[i]?.d)
		})),
		calls: minus(after.calls, before.calls),
		incl: minus(after.incl, before.incl),
		bsite_steps: minus(after.bsite_steps, before.bsite_steps),
		bsite_calls: minus(after.bsite_calls, before.bsite_calls),
		unsited: minus_table(after.unsited, before.unsited),
		unsited_calls: minus_table(after.unsited_calls, before.unsited_calls),
		bunits: minus_table(after.bunits, before.bunits),
		uunits: minus_table(after.uunits, before.uunits),
		edges: minus_table(after.edges, before.edges),
		steps: after.steps - before.steps
	};
}

/** An empty reading (the state before anything ran). */
export function empty_snapshot(): Snapshot {
	const z = new Float64Array(0);
	return {
		modules: [],
		calls: z,
		incl: z,
		bsite_steps: z,
		bsite_calls: z,
		unsited: table(),
		unsited_calls: table(),
		bunits: table(),
		uunits: table(),
		edges: table(),
		steps: 0
	};
}
