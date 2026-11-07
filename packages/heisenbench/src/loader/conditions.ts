import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { OWN_DIR } from '../own.ts';

/*
 * `--conditions svelte,browser`: the export conditions a bundler resolves packages with, for the
 * code under test. Vite with vite-plugin-svelte resolves with `svelte`, a browser bundle with
 * `browser`; Node with neither, so a package's `exports` hand a bench another build than the app
 * gets (a Svelte library's `lib/node` instead of the `lib/browser` that SvelteKit renders).
 *
 * `node --conditions` would apply them to Heisenbench's own imports as well, and those must stay
 * Node's: its parser has a `browser` build that does not run in Node. So the conditions are added
 * here, to every import except the ones Heisenbench's own files make, and the ones the packages
 * those load make in turn (a dependency of Heisenbench's is its own too). A package both load is
 * Heisenbench's when Heisenbench loaded it first.
 *
 * The CLI sets HEISENBENCH_CONDITIONS and imports this module, in its process and, through
 * NODE_OPTIONS, in every process it starts (cli.ts `conditions`).
 */

export const CONDITIONS_ENV = 'HEISENBENCH_CONDITIONS';

const REGISTERED = Symbol.for('heisenbench.resolve.conditions');

/** `svelte, browser` -> ['svelte', 'browser']. */
export function parse_conditions(list: string | undefined): string[] {
	if (list === undefined) return [];
	return [
		...new Set(
			list
				.split(',')
				.map((c) => c.trim())
				.filter(Boolean)
		)
	];
}

/**
 * The conditions an import resolves with: `conditions` added to Node's, unless the importer is
 * one of Heisenbench's own modules or a module only they loaded (`own`, which grows as they load).
 */
export function conditions_for(
	parent: string | undefined,
	node: readonly string[],
	conditions: readonly string[],
	own: ReadonlySet<string>
): readonly string[] {
	if (is_own(parent, own)) return node;
	return [...node, ...conditions.filter((c) => !node.includes(c))];
}

function is_own(parent: string | undefined, own: ReadonlySet<string>): boolean {
	// the entry point (Heisenbench's CLI or a script of the user's) and non-file importers
	if (parent === undefined || !parent.startsWith('file:')) return true;
	if (own.has(strip_query(parent))) return true;
	return fileURLToPath(strip_query(parent)).startsWith(OWN_DIR);
}

function strip_query(url: string): string {
	const q = url.search(/[?#]/);
	return q === -1 ? url : url.slice(0, q);
}

/** Resolve every import of the code under test with `conditions` too, in this thread, once. */
export function register_conditions(conditions: readonly string[]): void {
	const g = globalThis as unknown as Record<symbol, boolean | undefined>;
	if (conditions.length === 0 || g[REGISTERED]) return;
	g[REGISTERED] = true;
	const own = new Set<string>();
	registerHooks({
		resolve(specifier, context, next) {
			const node = context.conditions ?? [];
			const with_ = conditions_for(context.parentURL, node, conditions, own);
			const r = next(specifier, with_ === node ? context : { ...context, conditions: [...with_] });
			// a package Heisenbench's code loads is its own too; a project file it loads (a bench
			// file, a preload) is the code under test
			if (with_ === node && r.url.startsWith('file:') && r.url.includes('/node_modules/'))
				own.add(strip_query(r.url));
			return r;
		}
	});
}

register_conditions(parse_conditions(process.env[CONDITIONS_ENV]));
