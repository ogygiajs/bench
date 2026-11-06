import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import type { SourceMapInput } from '@jridgewell/trace-mapping';
import { module_id, transform } from '../transform/index.ts';
import { load_prices } from '../prices.ts';
import type { LoadedModules } from '../app/types.ts';

/*
 * The function inventory of installed packages (spec 8): every function of every module, nested
 * ones included, as the counting transform sees them. Modules the app runs loaded are already in
 * the app report (their metas); the rest (build-time code, features no scenario uses) are
 * transformed here, the same way, to list their functions. A `.svelte` file is listed as both its
 * server and its client compile (they hold different functions).
 */

export interface InventoryFunction {
	path: string;
	line: number;
	end_line: number;
	kind: string;
}

export type Inventory = Record<string, InventoryFunction[]>;

const SOURCE_EXT = ['.js', '.mjs', '.svelte'];

interface SvelteCompiler {
	compile(
		source: string,
		options: Record<string, unknown>
	): { js: { code: string; map: SourceMapInput } };
}

function* files_of(dir: string): Generator<string> {
	for (const e of readdirSync(dir)) {
		if (e === 'node_modules') continue;
		const p = join(dir, e);
		if (statSync(p).isDirectory()) yield* files_of(p);
		else if (SOURCE_EXT.some((x) => p.endsWith(x)) && !p.endsWith('.d.ts')) yield p;
	}
}

/** `@ogygia/core` -> its directory under an app's node_modules. */
function package_dir(app_dir: string, name: string): string {
	return join(app_dir, 'node_modules', ...name.split('/'));
}

function add(inv: Inventory, id: string, fns: InventoryFunction[]): void {
	const list = (inv[id] ??= []);
	const seen = new Set(list.map((f) => f.path));
	for (const f of fns) {
		if (seen.has(f.path)) continue;
		seen.add(f.path);
		list.push(f);
	}
}

function is_dir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The packages matching `patterns` (`ogygia`, `@ogygia/*`) installed in any of the apps: the
 * union, so a package only one scenario app installs is still listed.
 */
export function installed_packages(
	app_dirs: readonly string[],
	patterns: readonly string[]
): string[] {
	const out = new Set<string>();
	for (const app of app_dirs) {
		const nm = join(app, 'node_modules');
		for (const p of patterns) {
			if (p.endsWith('/*')) {
				const scope = p.slice(0, -2);
				const dir = join(nm, ...scope.split('/'));
				if (!is_dir(dir)) continue;
				for (const e of readdirSync(dir).sort()) if (is_dir(join(dir, e))) out.add(`${scope}/${e}`);
			} else if (is_dir(package_dir(app, p))) {
				out.add(p);
			}
		}
	}
	return [...out].sort();
}

/**
 * Every function of the named packages, from the first of `app_dirs` that installs each one.
 * `.svelte` files are compiled with that app's own Svelte compiler.
 */
export function package_inventory(
	app_dirs: string | readonly string[],
	packages: readonly string[],
	log: (line: string) => void = () => {}
): Inventory {
	const apps = typeof app_dirs === 'string' ? [app_dirs] : app_dirs;
	const inv: Inventory = {};
	const prices = load_prices();
	const compilers = new Map<string, SvelteCompiler>();
	for (const name of packages) {
		const app_dir = apps.find((a) => is_dir(package_dir(a, name)));
		if (app_dir === undefined) continue;
		const dir = package_dir(app_dir, name);
		const compiler = (): SvelteCompiler => {
			let c = compilers.get(app_dir);
			if (!c) {
				const req = createRequire(join(app_dir, 'package.json'));
				c = req('svelte/compiler') as SvelteCompiler;
				compilers.set(app_dir, c);
			}
			return c;
		};
		for (const file of files_of(dir)) {
			const id = module_id(file, app_dir + sep);
			const source = readFileSync(file, 'utf8');
			const variants: Array<{ code: string; map: SourceMapInput | null }> = [];
			try {
				if (file.endsWith('.svelte')) {
					for (const generate of ['server', 'client']) {
						const out = compiler().compile(source, {
							filename: file,
							generate,
							dev: false,
							experimental: { async: true }
						});
						variants.push({ code: out.js.code, map: out.js.map });
					}
				} else {
					variants.push({ code: source, map: null });
				}
				for (const v of variants) {
					const r = transform(v.code, {
						filename: file.endsWith('.svelte') ? file + '.js' : file,
						id,
						input_map: v.map,
						prices
					});
					add(
						inv,
						id,
						r.meta.functions.map((f) => ({
							path: f.path,
							line: f.line,
							end_line: f.end_line,
							kind: f.kind
						}))
					);
				}
			} catch (e) {
				log(`  inventory: ${id}: ${(e as Error).message.split('\n')[0]}`);
			}
		}
	}
	return inv;
}

/** The inventory of what the app runs loaded (from the app report). */
export function loaded_inventory(loaded: LoadedModules): Inventory {
	const inv: Inventory = {};
	for (const [id, fns] of Object.entries(loaded)) {
		add(
			inv,
			id,
			fns.map(([path, line, end_line, kind]) => ({ path, line, end_line, kind }))
		);
	}
	return inv;
}
