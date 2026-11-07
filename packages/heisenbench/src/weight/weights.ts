import { readFileSync, writeFileSync } from 'node:fs';
import type { AppReport } from '../app/types.ts';
import { is_app_case, unit_key } from '../app/types.ts';

/*
 * Real-app weights (spec 11): how often each function runs per unit of real work, from counted
 * app runs (spec 8). A unit is one server request, one prerendered page, one page load or one
 * interaction of a scenario (`dashboard server request`, `docs page load`).
 *
 * Per function and unit: calls, self steps and inclusive steps per unit. A change found by a bench
 * (steps per call) times the calls per unit is what the change costs the real app per unit.
 *
 * Functions are keyed by a canonical id that is the same for the installed package and for the
 * source it was built from: `@ogygia/core/dist/router/match.js > match` and
 * `packages/core/src/router/match.ts > match` are both `core/router/match > match`.
 */

export const WEIGHTS_SCHEMA = 'heisenbench-app-weights/1';

export interface UnitWeights {
	/** Steps of one unit (all counted functions). */
	steps: number;
	/** Units the numbers were averaged over. */
	units: number;
	side: 'server' | 'browser';
}

export interface FunctionWeight {
	/** Calls per unit. */
	calls: number;
	self_steps: number;
	inclusive_steps: number;
}

export interface AppWeights {
	schema: typeof WEIGHTS_SCHEMA;
	/** What the weights were counted on. */
	source: { sha: string | null; ogygia: Record<string, string>; scenarios: string[] };
	units: Record<string, UnitWeights>;
	/** canonical function id -> unit key -> weight. */
	functions: Record<string, Record<string, FunctionWeight>>;
}

const EXTENSIONS = ['.svelte.ts', '.svelte.js', '.ts', '.mts', '.js', '.mjs'];

/**
 * The canonical form of a module id: the package's own name (scope dropped), then the path inside
 * its source or build directory, without the extension (`.svelte` kept; `.svelte.ts` and its
 * built `.svelte.js` both become `.svelte`).
 */
export function canonical_module(id: string): string {
	const parts = id.split('/');
	let pkg: string;
	let rest: string[];
	if (parts[0] === 'packages' && parts.length > 2) {
		pkg = parts[1];
		rest = parts.slice(2);
	} else if (parts[0].startsWith('@') && parts.length > 2) {
		pkg = parts[1];
		rest = parts.slice(2);
	} else {
		pkg = parts[0];
		rest = parts.slice(1);
	}
	if (rest.length > 1 && (rest[0] === 'dist' || rest[0] === 'src')) rest = rest.slice(1);
	let path = rest.join('/');
	for (const ext of EXTENSIONS) {
		if (path.endsWith(ext)) {
			path = path.slice(0, -ext.length) + (ext.startsWith('.svelte') ? '.svelte' : '');
			break;
		}
	}
	return `${pkg}/${path}`;
}

export function canonical_function(module: string, path: string): string {
	return `${canonical_module(module)} > ${path}`;
}

function round(n: number): number {
	return Math.round(n * 1e4) / 1e4;
}

/** Weights from one or more app reports (each scenario's report, or one combined report). */
export function build_weights(reports: readonly AppReport[]): AppWeights {
	const units: Record<string, UnitWeights> = {};
	const sums = new Map<string, Map<string, FunctionWeight>>();
	const scenarios = new Set<string>();
	for (const r of reports) {
		for (const c of r.cases) {
			if (!is_app_case(c) || c.error) continue;
			scenarios.add(c.app.scenario);
			const key = unit_key(c.app);
			const u = (units[key] ??= { steps: 0, units: 0, side: c.app.side });
			u.steps += c.totals.steps;
			u.units += c.app.units;
			for (const f of c.functions) {
				const id = canonical_function(f.module, f.path);
				let per = sums.get(id);
				if (!per) sums.set(id, (per = new Map()));
				const w = per.get(key) ?? { calls: 0, self_steps: 0, inclusive_steps: 0 };
				w.calls += f.calls;
				w.self_steps += f.self_steps;
				w.inclusive_steps += f.inclusive_steps;
				per.set(key, w);
			}
		}
	}
	const functions: AppWeights['functions'] = {};
	for (const id of [...sums.keys()].sort()) {
		const per: Record<string, FunctionWeight> = {};
		for (const [key, w] of [...sums.get(id)!].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
			const n = units[key].units || 1;
			per[key] = {
				calls: round(w.calls / n),
				self_steps: round(w.self_steps / n),
				inclusive_steps: round(w.inclusive_steps / n)
			};
		}
		functions[id] = per;
	}
	for (const u of Object.values(units)) u.steps = round(u.steps / (u.units || 1));
	const first = reports[0];
	return {
		schema: WEIGHTS_SCHEMA,
		source: {
			sha: first?.git.sha ?? null,
			ogygia: first?.app.ogygia ?? {},
			scenarios: [...scenarios].sort()
		},
		units,
		functions
	};
}

export function load_app_weights(path: string): AppWeights {
	const w = JSON.parse(readFileSync(path, 'utf8')) as AppWeights;
	if (w.schema !== WEIGHTS_SCHEMA)
		throw new Error(`heisenbench: ${path} is not an app weights file`);
	return w;
}

export function write_app_weights(path: string, w: AppWeights): void {
	writeFileSync(path, JSON.stringify(w, null, '\t') + '\n');
}
