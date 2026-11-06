import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sep } from 'node:path';
import {
	VIRTUAL_PREFIX,
	compile_svelte,
	inline_map,
	is_svelte_module,
	is_ts,
	module_id,
	strip_types,
	transform
} from '../transform/index.ts';
import { load_prices } from '../prices.ts';

export interface LoaderConfig {
	/** Report paths are relative to this directory. */
	root: string;
	/**
	 * Instrument dependencies too: true for every package in node_modules, or a list of package
	 * names. Default false.
	 */
	deps?: boolean | string[];
	/** Path substrings that are never instrumented. Default: bench files (`.bench.`). */
	exclude?: string[];
	/** Svelte output for .svelte files. Default 'server'. */
	svelte?: 'server' | 'client';
	/** Append the `__abax` export of private bindings. Default true. */
	expose?: boolean;
}

const ABAX_DIR = fileURLToPath(new URL('../', import.meta.url));
/** Query parameter of a fresh module graph (`?abax_gen=3`). */
export const GENERATION = 'abax_gen=';
const EXTENSIONS = ['.js', '.mjs', '.ts', '.mts', '.svelte'];

function package_name(path: string): string | null {
	const marker = `${sep}node_modules${sep}`;
	const at = path.lastIndexOf(marker);
	if (at === -1) return null;
	const rest = path.slice(at + marker.length).split(sep);
	return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
}

/** What both loader flavours (registerHooks in-thread, module.register off-thread) share. */
export class LoaderCore {
	config: LoaderConfig;
	virtual = new Map<string, string>();
	prices = load_prices();

	constructor(config: LoaderConfig) {
		this.config = config;
	}

	should_instrument(url: string): boolean {
		if (!url.startsWith('file:')) return false;
		const path = fileURLToPath(url);
		if (path.startsWith(ABAX_DIR)) return false;
		if (path.endsWith('.d.ts')) return false;
		if (!EXTENSIONS.some((e) => path.endsWith(e))) return false;
		for (const x of this.config.exclude ?? ['.bench.']) if (path.includes(x)) return false;
		const pkg = package_name(path);
		if (pkg !== null) {
			const deps = this.config.deps ?? false;
			if (deps === false) return false;
			if (Array.isArray(deps) && !deps.includes(pkg)) return false;
		}
		return true;
	}

	is_virtual(specifier: string): boolean {
		return specifier.startsWith(VIRTUAL_PREFIX);
	}

	/**
	 * Fresh module state (fresh.ts): a module imported with `?abax_gen=N` passes the same query to
	 * every file it imports, so the whole graph is a new copy with its own module state. Abax's own
	 * files and Node built-ins stay shared. The counter modules are keyed by file, not URL: every
	 * copy of a file counts into the same counters.
	 */
	with_generation(url: string, parent: string | undefined): string {
		if (!parent || !url.startsWith('file:')) return url;
		const q = parent.indexOf('?');
		const at = q === -1 ? -1 : parent.indexOf(GENERATION, q);
		if (at === -1 || url.includes(GENERATION)) return url;
		if (fileURLToPath(url).startsWith(ABAX_DIR)) return url;
		const end = parent.indexOf('&', at);
		const gen = parent.slice(at, end === -1 ? undefined : end);
		return url + (url.includes('?') ? '&' : '?') + gen;
	}

	virtual_source(url: string): string {
		const src = this.virtual.get(url);
		if (src === undefined) throw new Error(`abax: unknown counter module ${url}`);
		return src;
	}

	/** True when the load hook must read the file itself (the default loader rejects .svelte). */
	needs_own_read(url: string): boolean {
		return url.startsWith('file:') && fileURLToPath(url).endsWith('.svelte');
	}

	read(url: string): string {
		return readFileSync(fileURLToPath(url), 'utf8');
	}

	/** Instrument loaded source. Returns null when the module stays as it is (CommonJS, JSON...). */
	instrument(url: string, source: string, format: string | null | undefined): string | null {
		const filename = fileURLToPath(url);
		// Fresh copies of a module (with_generation) load the same file again: transform it once.
		const cached = this.#done.get(filename);
		if (cached && cached.source === source && cached.format === format) return cached.code;
		const code = this.#instrument(filename, source, format);
		this.#done.set(filename, { source, format, code });
		return code;
	}

	#done = new Map<
		string,
		{ source: string; format: string | null | undefined; code: string | null }
	>();

	#instrument(filename: string, source: string, format: string | null | undefined): string | null {
		let code = source;
		let input_map = null;
		if (is_svelte_module(filename)) {
			const out = compile_svelte(source, filename, this.config.svelte ?? 'server');
			code = out.code;
			input_map = out.map;
		} else if (format === 'module-typescript' || (format == null && is_ts(filename))) {
			code = strip_types(source);
		} else if (format !== 'module') {
			return null;
		}
		const r = transform(code, {
			filename,
			id: module_id(filename, this.config.root),
			input_map,
			expose: this.config.expose,
			prices: this.prices
		});
		this.virtual.set(r.specifier, r.virtual);
		return r.code + inline_map(r.map);
	}
}
