// Counted runs of the ogygia apps (Abax, spec 8): a counted build of each scenario's installed
// ogygia app, its server counted per request, its page counted per load and interaction.
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	app_report,
	counted_build,
	installed_versions,
	launch_browser,
	run_scenario
} from '@bench/abax/app';
import type { AppCaseReport, AppReport, LoadedModules, PwBrowser } from '@bench/abax/app';
import { APP_DIRS, SCENARIOS, base_dir } from './scenarios.ts';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** What a counted build instruments: ogygia's packages and the Svelte runtime they drive. */
export const DEFAULT_PACKAGES = ['ogygia', '@ogygia/*', 'svelte'];

export interface CountOptions {
	scenarios: string[];
	/** `pr`: the app as installed (`ogygia`); `base`: its base twin (`ogygia-base`). */
	side?: 'pr' | 'base';
	packages?: string[];
	/** Module id -> replacement file (a planted change; see the answer key). */
	overlay?: Record<string, string>;
	/** Where the counted copies are built (default: a directory under the OS temp dir). */
	work?: string;
	browser?: boolean;
	sha?: string | null;
	log?: (line: string) => void;
}

export async function count_apps(
	o: CountOptions
): Promise<{ report: AppReport; errors: string[] }> {
	const log = o.log ?? ((l: string) => console.log(l));
	const packages = o.packages ?? DEFAULT_PACKAGES;
	const work = resolve(o.work ?? join(tmpdir(), 'abax-apps'));
	const cases: AppCaseReport[] = [];
	const loaded: LoadedModules = {};
	const errors: string[] = [];
	let ogygia: Record<string, string> = {};
	let browser: PwBrowser | null = null;
	try {
		if (o.browser !== false) browser = await launch_browser();
		for (const name of o.scenarios) {
			const make = SCENARIOS[name];
			if (!make) throw new Error(`unknown scenario ${name} (${Object.keys(SCENARIOS).join(', ')})`);
			const rel = o.side === 'base' ? base_dir(APP_DIRS[name]) : APP_DIRS[name];
			const app_dir = join(ROOT, rel);
			if (!existsSync(join(app_dir, 'node_modules'))) {
				errors.push(`${name}: ${rel} is not installed (run build-all.ts first)`);
				continue;
			}
			log(`\n▸ ${name} (${rel})`);
			const scenario = make();
			const build = await counted_build({
				app_dir,
				// The same directory for both sides of a comparison: paths end up in strings the
				// app builds (asset names, ids), and a longer path would cost steps of its own.
				work_dir: join(work, name),
				packages,
				overlay: o.overlay,
				env: scenario.env
			});
			log(`  counted build ${(build.ms / 1000).toFixed(1)} s`);
			ogygia = { ...ogygia, ...installed_versions(app_dir, ['ogygia', '@ogygia/*']) };
			const run = await run_scenario(scenario, build, browser, (l) => log(`  ${l}`));
			cases.push(...run.cases);
			errors.push(...run.errors);
			for (const [id, fns] of Object.entries(run.loaded)) {
				const list = (loaded[id] ??= []);
				const seen = new Set(list.map((f) => f[0]));
				for (const f of fns) if (!seen.has(f[0])) list.push(f);
			}
		}
	} finally {
		await browser?.close();
	}
	return {
		report: app_report({ cases, loaded, packages, ogygia, sha: o.sha ?? null }),
		errors
	};
}

/** `--flag value` pairs and repeated flags (`--overlay a=b --overlay c=d`). */
export function parse_args(argv: string[]): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) continue;
		const eq = a.indexOf('=');
		const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
		const value =
			eq !== -1 ? a.slice(eq + 1) : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '';
		out.set(key, [...(out.get(key) ?? []), value]);
	}
	return out;
}

export function overlay_of(values: string[] | undefined): Record<string, string> | undefined {
	if (!values?.length) return undefined;
	const out: Record<string, string> = {};
	for (const v of values) {
		const at = v.indexOf('=');
		if (at === -1) throw new Error(`--overlay wants <module id>=<file>, got ${v}`);
		out[v.slice(0, at)] = resolve(v.slice(at + 1));
	}
	return out;
}
