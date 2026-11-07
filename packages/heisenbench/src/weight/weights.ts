import { readFileSync, writeFileSync } from 'node:fs';
import type { AppReport } from '../app/types.ts';
import { is_app_case, unit_key } from '../app/types.ts';
import { context_path, unversioned_module } from '../identity.ts';

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
	/** Steps of one unit (all counted functions; 0 for a unit of real traffic, which is timed). */
	steps: number;
	/** Units the numbers were averaged over. */
	units: number;
	side: 'server' | 'browser';
	/** A unit of real traffic (weight/traffic.ts): measured in production, not counted. */
	traffic?: Traffic;
}

/** What a unit of real traffic was measured from. Only counts and times: no URL, no request data. */
export interface Traffic {
	/** Profiles imported, by format. */
	profiles: Record<string, number>;
	/** Requests the profiles covered. */
	requests: number;
	/** Summed recording windows. */
	window_ms: number;
	/** First and last moment recorded, when a profile says (ISO dates; a .cpuprofile does not). */
	start: string | null;
	end: string | null;
	/** Sampled CPU time of JavaScript and the engine (idle and the profiler's own frames left out). */
	sampled_ms: number;
	/** The part of it that mapped to a function Heisenbench counts. */
	mapped_ms: number;
	/** The frames with the most self time that did not map, and why. */
	unmatched: Array<{ frame: string; reason: string; self_ms: number }>;
}

export interface FunctionWeight {
	/** Calls per unit (for real traffic: counted calls, or 0 when the profiles only sampled). */
	calls: number;
	self_steps: number;
	inclusive_steps: number;
	/** Real traffic: measured self and total ns per unit, and the samples behind them. */
	self_ns?: number;
	total_ns?: number;
	samples?: number;
	/** Real traffic: `calls` were counted (V8 precise coverage, or a source that counts). */
	calls_counted?: boolean;
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
	const parts = unversioned_module(id).split('/');
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

/**
 * A function by its place (identity.ts `context_path`): the weights come from main and the changed
 * function from a PR, where its own edit gave it a new shape hash. Two callbacks in one place add up.
 */
export function canonical_function(module: string, path: string): string {
	return `${canonical_module(module)} > ${context_path(path)}`;
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

/**
 * One weights file from several (`--weights app-weights.json,real-weights.json`): the counted
 * scenarios' units and the real traffic's side by side. A unit two files both have keeps the
 * first file's numbers.
 */
export function merge_weights(list: readonly AppWeights[]): AppWeights {
	const out: AppWeights = {
		schema: WEIGHTS_SCHEMA,
		source: list[0]?.source ?? { sha: null, ogygia: {}, scenarios: [] },
		units: {},
		functions: {}
	};
	for (const w of list) {
		const fresh = Object.keys(w.units).filter((u) => !(u in out.units));
		for (const u of fresh) out.units[u] = w.units[u];
		for (const [id, per] of Object.entries(w.functions)) {
			for (const u of fresh) if (per[u]) (out.functions[id] ??= {})[u] = per[u];
		}
		out.source = {
			...out.source,
			scenarios: [...new Set([...out.source.scenarios, ...w.source.scenarios])].sort()
		};
	}
	return out;
}

/** `a.json,b.json`: each file's weights, merged. */
export function load_weights_list(paths: string): AppWeights {
	return merge_weights(
		paths
			.split(',')
			.filter(Boolean)
			.map((p) => load_app_weights(p))
	);
}

export function write_app_weights(path: string, w: AppWeights): void {
	writeFileSync(path, JSON.stringify(w, null, '\t') + '\n');
}
