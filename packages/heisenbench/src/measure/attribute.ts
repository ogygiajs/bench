import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { module_id, module_specifier } from '../transform/index.ts';
import { instrument } from '../transform/instrument.ts';
import { load_prices } from '../prices.ts';
import type { FunctionMeta } from '../meta.ts';
import { executed_code, is_plain_source } from './plain.ts';

/*
 * From a script position V8 reports (heap profile call frames, snapshot closures) to the function
 * the counting report knows: the same module id and function path.
 *
 * V8 reports a function at the start of its parameter list (or its name), which lies inside the
 * function and before any nested function. The counting transform numbers functions on the very
 * code V8 runs (TS stripped to whitespace, .svelte compiled), so the function is the innermost one
 * whose start is at or before the position and whose last line is at or after it.
 */

export interface FunctionRef {
	/** `module > path`, the counting report's function id. */
	id: string;
	module: string;
	path: string;
	/** Original source line of the function. */
	line: number;
}

interface ModuleIndex {
	id: string;
	/** Functions in generated coordinates (line 1-based, col 0-based), plus their original line. */
	fns: Array<{ meta: FunctionMeta; line: number; col: number; end: number; orig_line: number }>;
}

export class Attributor {
	root: string;
	#modules = new Map<string, ModuleIndex | null>();
	#prices = load_prices();

	constructor(root: string) {
		this.root = root;
	}

	/** True for a script URL of a source module under the root (not a bench file, not a dep). */
	wants(url: string): boolean {
		if (!url.startsWith('file:')) return false;
		return is_plain_source(fileURLToPath(url), [this.root]);
	}

	#index(url: string): ModuleIndex | null {
		const q = url.indexOf('?');
		const key = q === -1 ? url : url.slice(0, q);
		if (this.#modules.has(key)) return this.#modules.get(key)!;
		let index: ModuleIndex | null = null;
		try {
			const filename = fileURLToPath(key);
			const { code, map } = executed_code(filename, readFileSync(filename, 'utf8'));
			const id = module_id(filename, this.root);
			const opts = {
				id,
				filename,
				prices: this.#prices.prices,
				prices_hash: this.#prices.hash,
				module_specifier: module_specifier(filename),
				expose: false
			};
			// Generated positions to match V8; original lines (through the map) for the report.
			const lang = map ? ('js' as const) : undefined;
			const gen = instrument(code, { ...opts, lang });
			const orig = map
				? instrument(code, { ...opts, input_map: map as never, lang }).meta.functions
				: gen.meta.functions;
			index = {
				id,
				fns: gen.meta.functions.map((f, i) => ({
					meta: f,
					line: f.line,
					col: f.col,
					end: f.end_line,
					orig_line: orig[i]?.line ?? f.line
				}))
			};
		} catch {
			index = null;
		}
		this.#modules.set(key, index);
		return index;
	}

	/** The function at a 0-based line/column V8 reported for a script URL, or null. */
	at(url: string, line0: number, col0: number): FunctionRef | null {
		const m = this.#index(url);
		if (!m) return null;
		const line = line0 + 1;
		let best: ModuleIndex['fns'][number] | null = null;
		for (const f of m.fns) {
			if (f.meta.kind === 'top' || f.line > line || f.end < line) continue;
			if (f.line === line && f.col > col0) continue;
			if (!best || f.line > best.line || (f.line === best.line && f.col > best.col)) best = f;
		}
		if (!best) {
			const top = m.fns.find((f) => f.meta.kind === 'top');
			if (!top) return null;
			best = top;
		}
		return {
			id: `${m.id} > ${best.meta.path}`,
			module: m.id,
			path: best.meta.path,
			line: best.orig_line
		};
	}
}
