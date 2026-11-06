import type { CaseReport, Report } from '../report.ts';
import type { UnstableFunction } from './stability.ts';

/*
 * An app report is an ordinary Abax report (so `abax diff` compares two of them as it compares
 * bench reports) whose cases are phases of real app scenarios, each tagged with what one unit of
 * it is: a server request, a prerendered page (built once), a page load, an interaction.
 */

export const APP_UNITS = ['request', 'prerender', 'page load', 'interaction'] as const;
export type AppUnit = (typeof APP_UNITS)[number];

export interface AppCaseInfo {
	scenario: string;
	side: 'server' | 'browser';
	unit: AppUnit;
	/** How many units the case's counts cover (requests made, interactions run). */
	units: number;
	/** What ran: `GET /product/4`, `sort`, `load /`. */
	label: string;
	/** Functions whose counts differed between the two runs of the self-check. */
	unstable_functions: UnstableFunction[];
	/** Response statuses of the counted requests (server cases). */
	statuses?: number[];
}

export interface AppCaseReport extends CaseReport {
	app: AppCaseInfo;
}

/** Every function of each loaded module, from the transform's metas: `[path, line, end_line, kind]`. */
export type LoadedModules = Record<string, Array<[string, number, number, string]>>;

export interface AppReport extends Report {
	cases: AppCaseReport[];
	app: {
		/** Packages the build counted (`ogygia`, `@ogygia/*`, `svelte`). */
		packages: string[];
		/** The ogygia that was installed: package -> version. */
		ogygia: Record<string, string>;
		scenarios: string[];
		/** Counted modules the runs loaded (server or page) and every function in them. */
		loaded: LoadedModules;
	};
}

/** Add the functions of `metas` to `into` (a module loaded on both sides keeps both sets). */
export function add_loaded(
	into: LoadedModules,
	metas: ReadonlyArray<{
		id: string;
		functions: ReadonlyArray<{ path: string; line: number; end_line: number; kind: string }>;
	}>
): void {
	for (const m of metas) {
		const list = (into[m.id] ??= []);
		const seen = new Set(list.map((f) => f[0]));
		for (const f of m.functions) {
			if (seen.has(f.path)) continue;
			seen.add(f.path);
			list.push([f.path, f.line, f.end_line, f.kind]);
		}
	}
}

/** `dashboard server request`: the key real-app weights are kept under. */
export function unit_key(info: Pick<AppCaseInfo, 'scenario' | 'side' | 'unit'>): string {
	return info.unit === 'request' || info.unit === 'prerender'
		? `${info.scenario} server ${info.unit}`
		: `${info.scenario} ${info.unit}`;
}

export function is_app_case(c: CaseReport): c is AppCaseReport {
	return typeof (c as Partial<AppCaseReport>).app === 'object';
}
