import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	LEAST_UPPER_BOUND,
	TraceMap,
	originalPositionFor,
	sourceContentFor
} from '@jridgewell/trace-mapping';
import type { SourceMapInput } from '@jridgewell/trace-mapping';
import {
	compile_svelte,
	is_svelte_module,
	is_ts,
	module_id,
	transform,
	ts_to_js
} from '../transform/index.ts';
import { load_prices } from '../prices.ts';
import type { FunctionMeta } from '../meta.ts';
import { canonical_function } from './weights.ts';

/*
 * A profiler's frame -> the function Heisenbench counts (its canonical id, weights.ts).
 *
 * A frame is where V8 says a function starts: a script URL, a line and a column (V8 points at the
 * parameter list, `(`, or the arrow's first parameter), and a name. The frame's file is read on
 * this machine: when it was built (a bundled chunk, a package's `dist`), its source map (a
 * `sourceMappingURL` comment, inline or a file, or `<file>.map` beside it) takes the position back
 * to the file it was built from, read from the map's `sourcesContent` or from disk. That file is
 * then run through the counting transform, the same one `heisenbench run` uses, so the function
 * at the position gets the id a bench gives it: `Router > match`, or the place of an anonymous one
 * (`total > reduce:0`; weights are kept per place, without the shape hash).
 *
 * The function is the innermost one whose source starts at or before the position and ends on
 * the position's line or after it. A function V8 reports at its `class` keyword (a constructor)
 * is found by its name among the functions starting on that line.
 */

export interface Frame {
	/** Script URL (`file:///...`, or a path) as the profiler recorded it. */
	url: string;
	/** The function name V8 reported (`''` for an anonymous one). */
	name: string;
	/** 1-based line and 0-based column of the function's start in that script. */
	line: number;
	col: number;
}

export type Mapped = { id: string; module: string; path: string } | { id: null; reason: string };

export interface FrameMapperOptions {
	/** Module ids are relative to this directory (the app or repository root), as in a bench run. */
	root: string;
	/** `from=to` prefixes: a path recorded on another machine (`/srv/app`) read here (`./app`). */
	path_map?: ReadonlyArray<[string, string]>;
}

interface Table {
	id: string;
	functions: FunctionMeta[];
}

/** V8's own pseudo-frames: not code. `(garbage collector)` is engine work and stays a frame. */
export const PSEUDO_FRAMES = new Set(['(root)', '(program)', '(idle)']);

export class FrameMapper {
	#root: string;
	#path_map: ReadonlyArray<[string, string]>;
	#maps = new Map<string, { map: TraceMap; dir: string } | null>();
	#tables = new Map<string, Table | string>();
	#prices = load_prices();

	constructor(o: FrameMapperOptions) {
		this.#root = resolve(o.root);
		this.#path_map = o.path_map ?? [];
	}

	/** The file a frame's URL names on this machine, or null (node internals, eval, wasm). */
	file_of(url: string): string | null {
		if (url === '') return null;
		let path: string;
		if (url.startsWith('file://')) {
			try {
				path = fileURLToPath(url);
			} catch {
				return null;
			}
		} else if (url.startsWith('/') || /^[A-Za-z]:[\\/]/.test(url)) {
			path = url;
		} else if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
			return null;
		} else {
			path = resolve(this.#root, url);
		}
		for (const [from, to] of this.#path_map) {
			if (path === from || path.startsWith(from.endsWith(sep) ? from : from + sep)) {
				path = resolve(to) + path.slice(from.length);
				break;
			}
		}
		return path;
	}

	/** The source map of a built file, or null when it has none. */
	#map_of(file: string, code: string): { map: TraceMap; dir: string } | null {
		if (this.#maps.has(file)) return this.#maps.get(file)!;
		let found: { map: TraceMap; dir: string } | null = null;
		try {
			const m = /\/\/[#@] sourceMappingURL=([^\s'"]+)\s*$/.exec(code.slice(-4096));
			let raw: string | null = null;
			let at = file;
			if (m && m[1].startsWith('data:')) {
				const comma = m[1].indexOf(',');
				const data = m[1].slice(comma + 1);
				raw = /;base64/.test(m[1].slice(0, comma))
					? Buffer.from(data, 'base64').toString('utf8')
					: decodeURIComponent(data);
			} else {
				at = m ? resolve(dirname(file), decodeURIComponent(m[1])) : file + '.map';
				if (existsSync(at)) raw = readFileSync(at, 'utf8');
			}
			if (raw !== null)
				found = { map: new TraceMap(JSON.parse(raw) as SourceMapInput), dir: dirname(at) };
		} catch {
			found = null;
		}
		this.#maps.set(file, found);
		return found;
	}

	/** Every function of a source file as the counting transform names them (cached per file). */
	#table(file: string, source: string): Table | string {
		const hit = this.#tables.get(file);
		if (hit !== undefined) return hit;
		let out: Table | string;
		try {
			let code = source;
			let input_map: SourceMapInput | null = null;
			if (is_svelte_module(file)) {
				const c = compile_svelte(source, file, 'server');
				code = c.code;
				input_map = c.map;
			} else if (is_ts(file)) {
				const c = ts_to_js(source, file);
				code = c.code;
				input_map = c.map;
			}
			const id = module_id(file, this.#root);
			const r = transform(code, {
				filename: file.endsWith('.svelte') ? file + '.js' : file,
				id,
				input_map,
				prices: this.#prices
			});
			out = { id, functions: r.meta.functions };
		} catch (e) {
			out = `does not parse: ${(e as Error).message.split('\n')[0].slice(0, 120)}`;
		}
		this.#tables.set(file, out);
		return out;
	}

	/** The counted function a frame is in, or why there is none. */
	map(frame: Frame): Mapped {
		if (frame.name.startsWith('(') && frame.name.endsWith(')') && frame.url === '')
			return { id: null, reason: 'engine' };
		const file = this.file_of(frame.url);
		if (file === null)
			return { id: null, reason: frame.url.startsWith('node:') ? 'node internals' : 'no file' };
		let source: string;
		try {
			if (!statSync(file).isFile()) return { id: null, reason: 'no file' };
			source = readFileSync(file, 'utf8');
		} catch {
			return { id: null, reason: 'no file here' };
		}
		let at = { file, source, line: frame.line, col: frame.col };
		const sm = this.#map_of(file, source);
		if (sm) {
			// V8's position is the `(` of the parameters, which a minified map seldom marks: the
			// first mapped token at or after it (a parameter, the body) is inside the function
			let o = originalPositionFor(sm.map, {
				line: frame.line,
				column: frame.col,
				bias: LEAST_UPPER_BOUND
			});
			if (o.source == null || o.line == null)
				o = originalPositionFor(sm.map, { line: frame.line, column: frame.col });
			if (o.source == null || o.line == null) return { id: null, reason: 'not in the source map' };
			const src_file = o.source.startsWith('file://')
				? fileURLToPath(o.source)
				: isAbsolute(o.source)
					? o.source
					: resolve(sm.dir, o.source);
			const mapped_file = this.file_of(src_file) ?? src_file;
			const content =
				sourceContentFor(sm.map, o.source) ??
				(existsSync(mapped_file) ? readFileSync(mapped_file, 'utf8') : null);
			if (content === null) return { id: null, reason: 'source not here' };
			at = { file: mapped_file, source: content, line: o.line, col: o.column ?? 0 };
		}
		const t = this.#table(at.file, at.source);
		if (typeof t === 'string') return { id: null, reason: t };
		const fn = innermost(t.functions, at.line, at.col, frame.name);
		if (!fn) return { id: null, reason: 'no function there' };
		return { id: canonical_function(t.id, fn.path), module: t.id, path: fn.path };
	}

	/** A frame's file for a report line: relative to the root, a package path, or its last parts. */
	label(frame: Frame): string {
		const file = this.file_of(frame.url);
		const where =
			file === null
				? frame.url || '(native)'
				: file.includes(`${sep}node_modules${sep}`)
					? module_id(file, this.#root)
					: file.startsWith(this.#root + sep)
						? relative(this.#root, file).split(sep).join('/')
						: file.split(sep).slice(-2).join('/');
		return `${frame.name || '(anonymous)'} ${where}:${frame.line}`;
	}
}

/** The last segment of a function path, without its shape hash (`A > b~3fa9c2` -> `b`). */
function last_name(path: string): string {
	const i = path.lastIndexOf(' > ');
	const seg = i === -1 ? path : path.slice(i + 3);
	return seg.replace(/(?:~[0-9a-f]{6})?(?:#\d+)?$/, '');
}

/** The innermost function around a position (see the comment at the top). */
export function innermost(
	functions: readonly FunctionMeta[],
	line: number,
	col: number,
	name: string
): FunctionMeta | null {
	let best: FunctionMeta | null = null;
	for (const f of functions) {
		if (f.kind === 'top' || f.kind === 'fields') continue;
		const starts_before = f.line < line || (f.line === line && f.col <= col);
		if (!starts_before || f.end_line < line) continue;
		if (!best || f.line > best.line || (f.line === best.line && f.col > best.col)) best = f;
	}
	if (name !== '' && (!best || last_name(best.path) !== name)) {
		// `class A {` reported at its keyword: its constructor starts later
		const ctor = functions.find(
			(f) => f.path === `${name} > constructor` || f.path.endsWith(` > ${name} > constructor`)
		);
		if (ctor && (!best || ctor.line >= line)) return ctor;
	}
	return best ?? functions.find((f) => f.kind === 'top') ?? null;
}
