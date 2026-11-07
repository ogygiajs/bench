/** What the transform records about one module. The runtime receives it when the module loads. */

export const META_SCHEMA = 1;

export type FunctionKind = 'function' | 'top' | 'fields';

export interface FunctionMeta {
	/** Path inside the module: `Router > match`, `<top>`, `map:0`. Stable across line moves. */
	path: string;
	line: number;
	col: number;
	end_line: number;
	kind: FunctionKind;
	async: boolean;
	generator: boolean;
}

export interface BlockMeta {
	fn: number;
	/** Index of this block inside its function, in source order. Block identity = fn path + index. */
	index: number;
	line: number;
	col: number;
	/** Static price with the prices the module was transformed with. */
	price: number;
	/** Op counts, aligned with OP_KINDS. */
	ops: number[];
	/** Flat triples: original line, op kind index, count. */
	line_ops: number[];
}

export type SiteKind =
	| 'object'
	| 'array'
	| 'closure'
	| 'class'
	| 'new'
	| 'regexp'
	| 'string'
	| 'bound'
	| 'rest'
	| 'arguments'
	| 'promise'
	| 'generator'
	| 'spread_object'
	| 'spread_array'
	| 'spread_args';

export interface SiteMeta {
	fn: number;
	block: number;
	kind: SiteKind;
	line: number;
	col: number;
	/** Static part of the byte estimate (see layout.ts). Dynamic sites add bytes at run time. */
	bytes: number;
	/** True when the runtime adds bytes or steps for this site. */
	dynamic: boolean;
	/** False for sites that cost steps but allocate nothing (spread into call arguments). */
	alloc: boolean;
}

export interface BuiltinSiteMeta {
	fn: number;
	block: number;
	line: number;
	col: number;
	/** Call name (`sort`, `parse`, `get`). Only a wrapper of a built-in with this name charges it. */
	name: string;
}

export interface ModuleMeta {
	schema: number;
	/** Module identity in reports: path relative to the run root, or `pkg/path` for dependencies. */
	id: string;
	/** Original source file the lines refer to. */
	file: string;
	prices_hash: string;
	functions: FunctionMeta[];
	blocks: BlockMeta[];
	/** Indexed by the site number the instrumented code passes to the runtime. */
	sites: SiteMeta[];
	bsites: BuiltinSiteMeta[];
}
