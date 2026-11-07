/**
 * Counted app runs (spec 8): counted builds of a SvelteKit app, its server counted per request,
 * its pages counted per load and per interaction under virtual time, as one app report.
 */
import { REPORT_SCHEMA } from '../report.ts';
import { SIZE_TERMS, load_prices } from '../prices.ts';
import { apply_estimates } from '../calibrate/estimate.ts';
import type { AppCaseReport, AppReport, LoadedModules } from './types.ts';

export { counted_build, installed_versions } from './build.ts';
export type { CountedBuild, CountedBuildOptions } from './build.ts';
export { counted_plugins } from './vite.ts';
export type { CountedPluginOptions } from './vite.ts';
export { run_scenario } from './run.ts';
export type { CountedScenario, ScenarioRun, ServerRoute } from './run.ts';
export { launch_browser } from './browser.ts';
export type { BrowserSession, BrowserStep, PageAction, PwBrowser } from './browser.ts';
export type { AppRequest } from './server.ts';
export { add_loaded, is_app_case, unit_key } from './types.ts';
export type { AppCaseInfo, AppCaseReport, AppReport, AppUnit, LoadedModules } from './types.ts';
export { render_app_diff } from './diff.ts';
export { overlay_diff } from './overlay.ts';
export type { FileDiff } from '../diff/git.ts';

/** One app report from the cases of every scenario run. */
export function app_report(o: {
	cases: AppCaseReport[];
	loaded: LoadedModules;
	packages: string[];
	ogygia: Record<string, string>;
	sha: string | null;
}): AppReport {
	const p = load_prices();
	const report: AppReport = {
		schema: REPORT_SCHEMA,
		prices: { version: p.prices.version, hash: p.hash },
		node: process.version,
		git: { sha: o.sha, prefix: '' },
		cases: o.cases,
		unit_terms: [...SIZE_TERMS],
		app: {
			packages: o.packages,
			ogygia: o.ogygia,
			scenarios: [...new Set(o.cases.map((c) => c.app.scenario))],
			loaded: o.loaded
		}
	};
	apply_estimates(report);
	return report;
}
