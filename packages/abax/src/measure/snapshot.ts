/*
 * A V8 heap snapshot (the .heapsnapshot JSON), read just enough for leak reports: node types and
 * names, ids, self sizes, edges, and the script locations of closures.
 *
 * Layout (from the snapshot's own meta): `nodes` is a flat array of node_fields per node
 * (type, name, id, self_size, edge_count, ...), `edges` a flat array of edge_fields per edge
 * (type, name_or_index, to_node), where to_node is an offset into `nodes`. A node's edges follow
 * its predecessor's in `edges`. `locations` holds (node offset, script id, line, column) for
 * closures.
 */

export interface RawSnapshot {
	snapshot: {
		meta: {
			node_fields: string[];
			node_types: [string[], ...unknown[]];
			edge_fields: string[];
			edge_types: [string[], ...unknown[]];
			location_fields?: string[];
		};
		node_count: number;
	};
	nodes: number[];
	edges: number[];
	strings: string[];
	locations?: number[];
}

export interface Step {
	/** Node type: object, closure, array, string, hidden, synthetic, ... */
	type: string;
	name: string;
	/** How the next node in the chain is held: edge type and name (property, context var...). */
	edge_type: string;
	edge: string;
}

/** Roots that hold an object only while some code runs (the leak check's own frames included). */
const TRANSIENT_ROOTS = new Set(['(Stack roots)', '(Handle scope)']);

export class Snapshot {
	readonly node_count: number;
	readonly #nf: number;
	readonly #ef: number;
	readonly #nodes: number[];
	readonly #edges: number[];
	readonly #strings: string[];
	readonly #node_types: string[];
	readonly #edge_types: string[];
	readonly #i_type: number;
	readonly #i_name: number;
	readonly #i_id: number;
	readonly #i_size: number;
	readonly #i_edges: number;
	readonly #e_type: number;
	readonly #e_name: number;
	readonly #e_to: number;
	/** First edge (index into edges / ef) of each node. */
	readonly #first_edge: Int32Array;
	readonly #locations = new Map<number, { script: number; line: number; col: number }>();

	constructor(raw: RawSnapshot) {
		const m = raw.snapshot.meta;
		this.#nf = m.node_fields.length;
		this.#ef = m.edge_fields.length;
		this.#nodes = raw.nodes;
		this.#edges = raw.edges;
		this.#strings = raw.strings;
		this.#node_types = m.node_types[0];
		this.#edge_types = m.edge_types[0];
		this.#i_type = m.node_fields.indexOf('type');
		this.#i_name = m.node_fields.indexOf('name');
		this.#i_id = m.node_fields.indexOf('id');
		this.#i_size = m.node_fields.indexOf('self_size');
		this.#i_edges = m.node_fields.indexOf('edge_count');
		this.#e_type = m.edge_fields.indexOf('type');
		this.#e_name = m.edge_fields.indexOf('name_or_index');
		this.#e_to = m.edge_fields.indexOf('to_node');
		this.node_count = raw.nodes.length / this.#nf;
		this.#first_edge = new Int32Array(this.node_count + 1);
		let e = 0;
		for (let n = 0; n < this.node_count; n++) {
			this.#first_edge[n] = e;
			e += raw.nodes[n * this.#nf + this.#i_edges];
		}
		this.#first_edge[this.node_count] = e;
		const loc = raw.locations ?? [];
		const lf = m.location_fields?.length ?? 4;
		for (let i = 0; i + 3 < loc.length; i += lf) {
			this.#locations.set(loc[i] / this.#nf, {
				script: loc[i + 1],
				line: loc[i + 2],
				col: loc[i + 3]
			});
		}
	}

	type(n: number): string {
		return this.#node_types[this.#nodes[n * this.#nf + this.#i_type]];
	}

	name(n: number): string {
		return this.#strings[this.#nodes[n * this.#nf + this.#i_name]];
	}

	id(n: number): number {
		return this.#nodes[n * this.#nf + this.#i_id];
	}

	self_size(n: number): number {
		return this.#nodes[n * this.#nf + this.#i_size];
	}

	location(n: number): { script: number; line: number; col: number } | null {
		return this.#locations.get(n) ?? null;
	}

	/** Edges of node n as [edge type, edge name, target node]. */
	*edges(n: number): Generator<[string, string, number]> {
		const ef = this.#ef;
		for (let e = this.#first_edge[n]; e < this.#first_edge[n + 1]; e++) {
			const type = this.#edge_types[this.#edges[e * ef + this.#e_type]];
			const raw = this.#edges[e * ef + this.#e_name];
			const name = type === 'element' || type === 'hidden' ? String(raw) : this.#strings[raw];
			yield [type, name, this.#edges[e * ef + this.#e_to] / this.#nf];
		}
	}

	/** A readable type name: the constructor for objects, `Array`, `closure <name>`, `string`... */
	kind(n: number): string {
		const t = this.type(n);
		if (t === 'object' || t === 'native') return this.name(n);
		if (t === 'closure') return 'Function';
		if (t === 'array') return `(array) ${this.name(n)}`;
		if (t === 'concatenated string' || t === 'sliced string') return 'string';
		if (t === 'synthetic') return this.name(n);
		return `(${t})`;
	}

	/**
	 * A node that holds objects for the engine, not for the program: compiled code and what hangs
	 * off it (bytecode, constant pools, feedback vectors, inline caches), hidden classes and their
	 * descriptors, allocation sites. Clean code makes these hold a few new objects as V8 compiles
	 * and re-tiers it; a program never reads them.
	 */
	engine_holder(n: number): boolean {
		const t = this.type(n);
		if (t === 'code' || t === 'object shape') return true;
		const name = this.name(n);
		return name.startsWith('system / Feedback') || name.startsWith('system / AllocationSite');
	}

	/**
	 * Shortest strong paths from the root (node 0) to every node, as one tree (breadth first).
	 * Weak edges, the snapshot's own bookkeeping (shortcut edges), roots that hold an object only
	 * while some code runs, and engine holders (see `engine_holder`) retain nothing here.
	 * `order` lists the reached nodes parents first.
	 */
	retainer_tree(): RetainerTree {
		const parent = new Int32Array(this.node_count).fill(-1);
		const via = new Int32Array(this.node_count).fill(-1);
		const order = new Int32Array(this.node_count);
		const ef = this.#ef;
		parent[0] = 0;
		order[0] = 0;
		let head = 0;
		let tail = 1;
		while (head < tail) {
			const n = order[head++];
			if (this.type(n) === 'synthetic' && TRANSIENT_ROOTS.has(this.name(n))) continue;
			if (this.engine_holder(n)) continue;
			for (let e = this.#first_edge[n]; e < this.#first_edge[n + 1]; e++) {
				const type = this.#edge_types[this.#edges[e * ef + this.#e_type]];
				if (type === 'weak' || type === 'shortcut') continue;
				const to = this.#edges[e * ef + this.#e_to] / this.#nf;
				if (parent[to] !== -1) continue;
				parent[to] = n;
				via[to] = e;
				order[tail++] = to;
			}
		}
		return { parent, via, order: order.subarray(0, tail) };
	}

	/** Type and name of edge `e` (an index as `RetainerTree.via` holds). */
	edge(e: number): [string, string] {
		const ef = this.#ef;
		const type = this.#edge_types[this.#edges[e * ef + this.#e_type]];
		const raw = this.#edges[e * ef + this.#e_name];
		return [type, type === 'element' || type === 'hidden' ? String(raw) : this.#strings[raw]];
	}

	/** The path from the root to `target` in a retainer tree, as steps root -> ... -> target. */
	path(tree: RetainerTree, target: number): { nodes: number[]; steps: Step[] } | null {
		if (tree.parent[target] === -1) return null;
		const nodes: number[] = [];
		for (let n = target; n !== 0; n = tree.parent[n]) nodes.push(n);
		nodes.reverse();
		const steps: Step[] = [];
		for (let i = 0; i < nodes.length; i++) {
			const n = nodes[i];
			const nx = nodes[i + 1];
			const [edge_type, edge] = nx === undefined ? ['', ''] : this.edge(tree.via[nx]);
			steps.push({ type: this.type(n), name: this.kind(n), edge_type, edge });
		}
		return { nodes, steps };
	}

	/** Every context and the closures whose context it is (they keep its variables alive). */
	context_closures(): Map<number, number[]> {
		const out = new Map<number, number[]>();
		for (let n = 0; n < this.node_count; n++) {
			if (this.type(n) !== 'closure') continue;
			for (const [type, name, to] of this.edges(n)) {
				if (type !== 'internal' || name !== 'context') continue;
				const list = out.get(to);
				if (list) list.push(n);
				else out.set(to, [n]);
			}
		}
		return out;
	}
}

export interface RetainerTree {
	/** Parent of each node on its shortest strong path from the root; -1 when none reaches it. */
	parent: Int32Array;
	/** The edge from the parent (an index for `Snapshot.edge`), -1 for the root and unreached. */
	via: Int32Array;
	order: Int32Array;
}
