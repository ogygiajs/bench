import { tmpdir } from 'node:os';
import { build_case_report } from '../report.ts';
import type { CaseReport } from '../report.ts';
import { run_session } from './browser.ts';
import type { BrowserSession, PwBrowser, SessionResult } from './browser.ts';
import { CountedServer } from './server.ts';
import type { AppRequest, CountedServerCase } from './server.ts';
import { runtime_for } from './snapshot.ts';
import { static_file } from './static.ts';
import { unstable_functions } from './stability.ts';
import type { CountedBuild } from './build.ts';
import { add_loaded } from './types.ts';
import type { AppCaseInfo, AppCaseReport, AppUnit, LoadedModules } from './types.ts';

/*
 * One scenario on a counted build (spec 8).
 *
 * 1. The browser session, twice, each in a fresh context under virtual time (browser.ts), against
 *    the counted server on HTTP (not counted there). Each phase is a case; the two runs must count
 *    the same.
 * 2. The server, counted inside the measuring window: the scenario's routes, plus the requests the
 *    page itself made in the session (a server island, a chat stream), each list `repeat` times
 *    per measured run, after a warm-up run.
 */

export interface ServerRoute {
	/** `GET /product/4`. */
	label: string;
	requests: AppRequest[];
	/** `prerender`: a page built once (its server render is a build cost, not a request's). */
	unit: Extract<AppUnit, 'request' | 'prerender'>;
}

export interface CountedScenario {
	name: string;
	server: ServerRoute[];
	/** Times each route's requests are made per measured run (default 5). */
	repeat?: number;
	browser?: BrowserSession;
	/** Count the requests the page made in the session as one more server case (default true). */
	server_follow?: boolean;
	/** Headers every counted server request carries (a visitor's cookies). */
	headers?: Record<string, string>;
	/** Environment the app needs (secrets for signing). */
	env?: Record<string, string>;
}

export interface ScenarioRun {
	cases: AppCaseReport[];
	/** True when every phase counted the same on both runs. */
	stable: boolean;
	errors: string[];
	/** Counted modules the server and the page loaded, with their functions. */
	loaded: LoadedModules;
}

function failed_case(name: string, error: string, app: AppCaseInfo): AppCaseReport {
	return {
		name,
		file: '',
		stable: false,
		timers: 0,
		runaway_timers: false,
		error,
		totals: { steps: 0, allocations: 0, bytes: 0, calls: 0 },
		functions: [],
		edges: [],
		app
	};
}

function phase_reports(s: SessionResult): CaseReport[] {
	const runtimes = s.runtimes.map((metas) => runtime_for(metas));
	return s.phases.map((p) => {
		const info = { name: p.name, file: '', stable: true, timers: 0, runaway: false, error: null };
		return build_case_report(runtimes[p.runtime] ?? runtime_for([]), p.snap, info);
	});
}

function browser_cases(scenario: string, a: SessionResult, b: SessionResult): AppCaseReport[] {
	const ra = phase_reports(a);
	const rb = phase_reports(b);
	return ra.map((r, i) => {
		const phase = a.phases[i];
		const unstable = rb[i] ? unstable_functions(r, rb[i]) : [];
		const stable =
			rb[i] !== undefined &&
			unstable.length === 0 &&
			Math.abs(r.totals.steps - rb[i].totals.steps) < 1e-6;
		return {
			...r,
			name: `${scenario} › browser › ${phase.name}`,
			stable,
			app: {
				scenario,
				side: 'browser',
				unit: phase.unit,
				units: 1,
				label: phase.name,
				unstable_functions: unstable
			}
		};
	});
}

const per_unit = (c: AppCaseReport): string =>
	`${Math.round(c.totals.steps / Math.max(1, c.app.units)).toLocaleString('en-US')} steps per ${c.app.unit}`;

export async function run_scenario(
	scenario: CountedScenario,
	build: CountedBuild,
	browser: PwBrowser | null,
	log: (line: string) => void = () => {}
): Promise<ScenarioRun> {
	const errors: string[] = [];
	const cases: AppCaseReport[] = [];
	const loaded: LoadedModules = {};
	const repeat = scenario.repeat ?? 5;
	const with_headers = (r: AppRequest): AppRequest => ({
		...r,
		headers: { ...scenario.headers, ...r.headers }
	});
	const routes: ServerRoute[] = scenario.server.map((r) => ({
		...r,
		requests: r.requests.map(with_headers)
	}));
	const server = await CountedServer.start({
		server_dir: build.server_dir,
		static_dirs: build.static_dirs,
		env: scenario.env,
		cwd: build.dir
	});
	try {
		if (scenario.browser && browser) {
			const base = await server.listen();
			const a = await run_session(browser, base, scenario.browser);
			const b = await run_session(browser, base, scenario.browser);
			await server.close_http();
			for (const metas of a.runtimes) add_loaded(loaded, metas);
			errors.push(...a.errors.map((e) => `${scenario.name} › browser: ${e}`));
			for (const c of browser_cases(scenario.name, a, b)) {
				cases.push(c);
				log(`${c.stable ? 'ok      ' : 'UNSTABLE'} ${c.name}  ${per_unit(c)}`);
			}
			// The page's own requests that the app answers (a static file costs the app nothing).
			const follow = a.requests.filter(
				(r) => r.method !== 'GET' || !static_file(build.static_dirs, new URL(r.path, base).pathname)
			);
			if (scenario.server_follow !== false && follow.length > 0) {
				routes.push({
					label: `page view requests (${follow.length})`,
					unit: 'request',
					requests: follow.map(with_headers)
				});
			}
		}

		const counted: CountedServerCase[] = routes.map((r) => ({
			name: r.label,
			requests: r.requests,
			repeat
		}));
		const { results, loaded: server_loaded } = await server.count(
			counted,
			'http://127.0.0.1',
			tmpdir()
		);
		for (const [id, fns] of Object.entries(server_loaded)) {
			add_loaded(loaded, [
				{
					id,
					functions: fns.map(([path, line, end_line, kind]) => ({ path, line, end_line, kind }))
				}
			]);
		}
		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			const route = routes[i];
			const app: AppCaseInfo = {
				scenario: scenario.name,
				side: 'server',
				unit: route.unit,
				units: repeat * (route.unit === 'request' ? route.requests.length : 1),
				label: route.label,
				unstable_functions: r.unstable ?? [],
				statuses: r.statuses
			};
			const name = `${scenario.name} › server › ${route.label}`;
			if (!r.report) {
				errors.push(`${name}: ${r.error}`);
				cases.push(failed_case(name, r.error ?? 'failed', app));
				continue;
			}
			const bad = (r.statuses ?? []).filter((s) => s >= 400);
			if (bad.length > 0) errors.push(`${name}: answered ${[...new Set(bad)].join(', ')}`);
			const c: AppCaseReport = { ...r.report, name, app };
			cases.push(c);
			log(`${c.stable ? 'ok      ' : 'UNSTABLE'} ${name}  ${per_unit(c)}`);
		}
	} finally {
		await server.stop();
	}
	return { cases, stable: cases.every((c) => c.stable && !c.error), errors, loaded };
}
