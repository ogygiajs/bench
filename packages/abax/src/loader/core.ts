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
