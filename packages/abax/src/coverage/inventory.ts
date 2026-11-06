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

/**
 * Every function of the named packages installed in `app_dir`. `.svelte` files are compiled with
 * the app's own Svelte compiler.
 */
export function package_inventory(
	app_dir: string,
	packages: readonly string[],
	log: (line: string) => void = () => {}
): Inventory {
	const inv: Inventory = {};
	const prices = load_prices();
	let svelte: SvelteCompiler | null = null;
	const compiler = (): SvelteCompiler => {
		if (!svelte) {
			const req = createRequire(join(app_dir, 'package.json'));
			svelte = req('svelte/compiler') as SvelteCompiler;
		}
		return svelte;
	};
	for (const name of packages) {
		const dir = package_dir(app_dir, name);
		let real: string;
		try {
			real = statSync(dir).isDirectory() ? dir : '';
		} catch {
			continue;
		}
		if (!real) continue;
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
