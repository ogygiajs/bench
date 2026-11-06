import { tmpdir } from 'node:os';
import { build_case_report } from '../report.ts';
import type { CaseReport } from '../report.ts';
import { run_session } from './browser.ts';
import type { BrowserSession, PwBrowser, SessionResult } from './browser.ts';
import { CountedServer } from './server.ts';
import type { AppRequest } from './server.ts';
import { runtime_for } from './snapshot.ts';
import { unstable_functions } from './stability.ts';
import type { CountedBuild } from './build.ts';
import type { AppCaseReport, AppUnit } from './types.ts';

/*
 * One scenario on a counted build (spec 8): the server's requests counted inside the measuring
 * window, then the browser session under virtual time, each run twice for the self-check.
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
	/** Environment the app needs (secrets for signing). */
	env?: Record<string, string>;
}

export interface ScenarioRun {
	cases: AppCaseReport[];
	/** True when every phase counted the same on both runs. */
	stable: boolean;
	errors: string[];
}

function failed_case(name: string, error: string, app: AppCaseReport['app']): AppCaseReport {
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
		const rt = runtimes[p.runtime];
		if (!rt) return build_case_report(runtime_for([]), p.snap, info);
		return build_case_report(rt, p.snap, info);
	});
}

export async function run_scenario(
	scenario: CountedScenario,
	build: CountedBuild,
	browser: PwBrowser | null,
	log: (line: string) => void = () => {}
): Promise<ScenarioRun> {
	const errors: string[] = [];
	const cases: AppCaseReport[] = [];
	const repeat = scenario.repeat ?? 5;
	const server = await CountedServer.start({
		server_dir: build.server_dir,
		static_dirs: build.static_dirs,
		env: scenario.env,
		cwd: build.dir
	});
	try {
		const origin = 'http://127.0.0.1';
		const results = await server.count(
			scenario.server.map((r) => ({ name: r.label, requests: r.requests, repeat })),
			origin,
			tmpdir()
		);
		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			const route = scenario.server[i];
			const app = {
				scenario: scenario.name,
				side: 'server' as const,
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
			if (bad.length > 0) errors.push(`${name}: answered ${bad.join(', ')}`);
			cases.push({ ...r.report, name, app });
			log(
				`${r.report.stable ? 'ok      ' : 'UNSTABLE'} ${name}  ${Math.round(r.report.totals.steps / app.units)} steps per ${route.unit}`
			);
		}

		if (scenario.browser && browser) {
			const base = await server.listen();
			const a = await run_session(browser, base, scenario.browser);
			const b = await run_session(browser, base, scenario.browser);
			await server.close_http();
			errors.push(...a.errors.map((e) => `${scenario.name} › browser: ${e}`));
			const ra = phase_reports(a);
			const rb = phase_reports(b);
			for (let i = 0; i < ra.length; i++) {
				const phase = a.phases[i];
				const unstable = rb[i] ? unstable_functions(ra[i], rb[i]) : [];
				const stable =
					unstable.length === 0 &&
					rb[i] !== undefined &&
					Math.abs(ra[i].totals.steps - rb[i].totals.steps) < 1e-6;
				const name = `${scenario.name} › browser › ${phase.name}`;
				cases.push({
					...ra[i],
					name,
					stable,
					app: {
						scenario: scenario.name,
						side: 'browser',
						unit: phase.unit,
						units: 1,
						label: phase.name,
						unstable_functions: unstable
					}
				});
				log(`${stable ? 'ok      ' : 'UNSTABLE'} ${name}  ${Math.round(ra[i].totals.steps)} steps`);
			}
		}
	} finally {
		await server.stop();
	}
	return { cases, stable: cases.every((c) => c.stable && !c.error), errors };
}
