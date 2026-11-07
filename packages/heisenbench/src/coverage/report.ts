import { package_matches } from '../app/vite.ts';
import type { AppReport } from '../app/types.ts';
import { is_app_case, unit_key } from '../app/types.ts';
import { loaded_inventory } from './inventory.ts';
import { unversioned_module } from '../identity.ts';
import type { Inventory } from './inventory.ts';

/*
 * The coverage report (spec 8): every function of the packages under test, and whether the
 * counted scenario runs reached it.
 *
 *   reached     it ran (with its calls per unit of each scenario)
 *   loaded      its module was loaded by the server or a page, but the function never ran
 *   not loaded  no run loaded its module (build-time code, a feature no scenario uses)
 *
 * Module-level code (`<top>`) and class field initializers (`<fields>`) are not functions and are
 * left out. For a loaded module the functions
 * are the ones the counted build's transform listed (the code the app really ran); for the others
 * the package's own file, transformed the same way (inventory.ts).
 */

export const COVERAGE_SCHEMA = 'heisenbench-coverage/1';

export type CoverageStatus = 'reached' | 'loaded' | 'not loaded';

export interface CoverageFunction {
	id: string;
	package: string;
	module: string;
	path: string;
	line: number;
	/** Lines the function spans (its size, for ranking what is left). */
	size: number;
	status: CoverageStatus;
	/** Calls per unit (`dashboard server request` -> 3.2). */
	calls: Record<string, number>;
}

export interface PackageCoverage {
	functions: number;
	reached: number;
	loaded: number;
	not_loaded: number;
	/** reached / functions, in percent. */
	percent: number;
	/** reached / (functions in loaded modules), in percent. */
	percent_loaded: number;
}

export interface CoverageReport {
	schema: typeof COVERAGE_SCHEMA;
	packages: Record<string, PackageCoverage>;
	total: PackageCoverage;
	functions: CoverageFunction[];
}

function package_of_id(id: string): string {
	const parts = unversioned_module(id).split('/');
	return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

function pct(a: number, b: number): number {
	return b === 0 ? 0 : Math.round((a / b) * 1000) / 10;
}

function summary(list: CoverageFunction[]): PackageCoverage {
	const reached = list.filter((f) => f.status === 'reached').length;
	const loaded = list.filter((f) => f.status === 'loaded').length;
	return {
		functions: list.length,
		reached,
		loaded,
		not_loaded: list.length - reached - loaded,
		percent: pct(reached, list.length),
		percent_loaded: pct(reached, reached + loaded)
	};
}

export function build_coverage(
	reports: readonly AppReport[],
	packages: readonly string[],
	all: Inventory = {}
): CoverageReport {
	// calls per unit, per function id
	const calls = new Map<string, Record<string, number>>();
	const unit_count = new Map<string, number>();
	for (const r of reports) {
		for (const c of r.cases) {
			if (!is_app_case(c) || c.error) continue;
			const key = unit_key(c.app);
			unit_count.set(key, (unit_count.get(key) ?? 0) + c.app.units);
		}
	}
	for (const r of reports) {
		for (const c of r.cases) {
			if (!is_app_case(c) || c.error) continue;
			const key = unit_key(c.app);
			const n = unit_count.get(key) || 1;
			for (const f of c.functions) {
				if (f.calls === 0 && f.self_steps === 0) continue;
				const per = calls.get(f.id) ?? {};
				per[key] = Math.round(((per[key] ?? 0) + f.calls / n) * 1e4) / 1e4;
				calls.set(f.id, per);
			}
		}
	}
	const loaded: Inventory = {};
	for (const r of reports) {
		for (const [id, fns] of Object.entries(loaded_inventory(r.app.loaded))) {
			const list = (loaded[id] ??= []);
			const seen = new Set(list.map((f) => f.path));
			for (const f of fns) if (!seen.has(f.path)) list.push(f);
		}
	}
	const functions: CoverageFunction[] = [];
	const modules = new Set([...Object.keys(all), ...Object.keys(loaded)]);
	for (const module of [...modules].sort()) {
		const pkg = package_of_id(module);
		if (!package_matches(pkg, packages)) continue;
		const is_loaded = module in loaded;
		for (const f of (is_loaded ? loaded[module] : all[module]) ?? []) {
			if (f.kind === 'top' || f.kind === 'fields') continue;
			const id = `${module} > ${f.path}`;
			const c = calls.get(id);
			functions.push({
				id,
				package: pkg,
				module,
				path: f.path,
				line: f.line,
				size: Math.max(1, f.end_line - f.line + 1),
				status: c ? 'reached' : is_loaded ? 'loaded' : 'not loaded',
				calls: c ?? {}
			});
		}
	}
	const by_pkg = new Map<string, CoverageFunction[]>();
	for (const f of functions) by_pkg.set(f.package, [...(by_pkg.get(f.package) ?? []), f]);
	const pkgs: Record<string, PackageCoverage> = {};
	for (const [p, list] of [...by_pkg].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
		pkgs[p] = summary(list);
	return { schema: COVERAGE_SCHEMA, packages: pkgs, total: summary(functions), functions };
}

/** The short markdown summary: % per package, then the biggest functions nothing reached. */
export function render_coverage(r: CoverageReport, top = 20): string {
	const row = (name: string, p: PackageCoverage) =>
		`| ${name} | ${p.functions} | ${p.reached} | **${p.percent}%** | ${p.percent_loaded}% | ${p.loaded} | ${p.not_loaded} |`;
	const out = [
		'### Heisenbench: coverage of the app scenarios',
		'',
		'| Package | Functions | Reached | Reached % | % of loaded modules | Loaded, not run | Not loaded |',
		'| --- | ---: | ---: | ---: | ---: | ---: | ---: |'
	];
	for (const [p, c] of Object.entries(r.packages)) out.push(row(`\`${p}\``, c));
	out.push(row('all', r.total), '');
	const loaded = r.functions
		.filter((f) => f.status === 'loaded')
		.sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1))
		.slice(0, top);
	if (loaded.length > 0) {
		out.push(
			`Top ${loaded.length} unreached functions in loaded modules (largest first):`,
			'',
			'| Function | Lines |',
			'| --- | ---: |'
		);
		for (const f of loaded) out.push(`| \`${f.module}:${f.line} > ${f.path}\` | ${f.size} |`);
		out.push('');
	}
	const not_loaded = new Map<string, number>();
	for (const f of r.functions) {
		if (f.status === 'not loaded') not_loaded.set(f.module, (not_loaded.get(f.module) ?? 0) + 1);
	}
	const mods = [...not_loaded].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10);
	if (mods.length > 0) {
		out.push('Modules no scenario loaded (most functions first):', '');
		for (const [m, n] of mods) out.push(`- \`${m}\`: ${n} functions`);
		out.push('');
	}
	return out.join('\n');
}
