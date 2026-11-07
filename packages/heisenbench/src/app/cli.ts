import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { UsageError } from '../usage.ts';
import { resolve } from 'node:path';
import type { DiffResult } from '../diff/index.ts';
import type { Report } from '../report.ts';
import type { AppReport } from './types.ts';
import { render_app_diff } from './diff.ts';
import { build_weights, load_weights_list, write_app_weights } from '../weight/weights.ts';
import { rank_findings, render_weighted } from '../weight/rank.ts';
import type { Ranking } from '../weight/rank.ts';
import { import_traffic } from '../weight/traffic.ts';
import { coverage_line } from '../weight/cost.ts';
import { build_coverage, render_coverage } from '../coverage/report.ts';
import { installed_packages, package_inventory } from '../coverage/inventory.ts';

/*
 * The app commands of the CLI (cli.ts hands them over):
 *
 *   heisenbench weights <app-report.json...> [--out app-weights.json]
 *   heisenbench weights import <profiles...> [--out real-weights.json] [--root dir] [--requests n]
 *                 [--path-map from=to,...] [--secret s]
 *   heisenbench coverage <app-report.json...> --app <installed app dir> [--packages ogygia,@ogygia/*]
 *                 [--out coverage.json] [--md coverage.md]
 *
 * and the extra sections of `heisenbench diff`: the real-app summary when both reports are app reports,
 * the weighted ranking with `--weights app-weights.json`.
 */

export const APP_USAGE = `heisenbench weights <app-report.json...> [--out app-weights.json]
heisenbench weights import <profiles...> [--out real-weights.json] [--root dir] [--requests n] [--path-map from=to,...] [--secret s]
heisenbench coverage <app-report.json...> --app <installed app dir> [--packages ogygia,@ogygia/*] [--out coverage.json] [--md coverage.md]
heisenbench diff ... [--weights app-weights.json[,real-weights.json]] [--requests-per-day n]   (ranks findings by real cost, else real-app weight; app reports also get a per-phase summary)`;

/** `/srv/app=./app,/x=/y` -> prefix pairs. */
function path_map(v: string | undefined): Array<[string, string]> {
	if (!v) return [];
	return v.split(',').map((pair) => {
		const eq = pair.indexOf('=');
		if (eq <= 0)
			throw new UsageError(`--path-map takes from=to pairs, not ${JSON.stringify(pair)}`);
		return [pair.slice(0, eq), pair.slice(eq + 1)];
	});
}

/** `heisenbench weights import`: production profiles -> real-traffic weights. */
async function import_command(files: string[], flags: Map<string, string>): Promise<number> {
	if (files.length === 0) throw new UsageError('which profiles? (none given)');
	const w = await import_traffic(files, {
		root: resolve(flags.get('root') ?? '.'),
		requests: flags.has('requests') ? Number(flags.get('requests')) : undefined,
		path_map: path_map(flags.get('path-map')),
		secret: flags.get('secret') ?? process.env.OGYGIA_PROFILER_SECRET
	});
	const out = flags.get('out') ?? 'real-weights.json';
	write_app_weights(out, w);
	const u = Object.values(w.units)[0];
	console.log(
		`${Object.keys(w.functions).length} functions from ${files.length} profile(s), ${u.units} requests over ${Math.round(u.traffic!.window_ms)} ms -> ${out}`
	);
	console.log(coverage_line(w));
	return 0;
}

const DEFAULT_PACKAGES = ['ogygia', '@ogygia/*'];

function read_app(path: string): AppReport {
	let r: AppReport;
	try {
		r = JSON.parse(readFileSync(path, 'utf8')) as AppReport;
	} catch {
		throw new UsageError(`${path} is not JSON`);
	}
	if (r === null || typeof r !== 'object' || !r.app)
		throw new UsageError(`${path} is not an app report (no "app" block)`);
	return r;
}

export function app_command(
	cmd: string | undefined,
	positional: string[],
	flags: Map<string, string>
): number | Promise<number> | null {
	if (cmd === 'weights' && positional[0] === 'import')
		return import_command(positional.slice(1), flags);
	if (cmd === 'weights') {
		if (positional.length === 0) {
			console.error(APP_USAGE);
			return 2;
		}
		const w = build_weights(positional.map(read_app));
		const out = flags.get('out') ?? 'app-weights.json';
		write_app_weights(out, w);
		const units = Object.entries(w.units)
			.map(([k, u]) => `  ${k}: ${Math.round(u.steps).toLocaleString('en-US')} steps per unit`)
			.join('\n');
		console.log(`${Object.keys(w.functions).length} functions weighted -> ${out}\n${units}`);
		return 0;
	}
	if (cmd === 'coverage') {
		const app = flags.get('app');
		if (!app) throw new UsageError('--app <app dir,app dir...> is required');
		for (const a of app.split(',').filter(Boolean)) {
			if (!existsSync(a)) throw new UsageError(`--app: no directory ${a}`);
		}
		const packages = flags.get('packages')?.split(',') ?? DEFAULT_PACKAGES;
		const reports = positional.map(read_app);
		// Every scenario app's installs (`--app a,b,c`), not only what one app has: a package
		// only the blog app installs is still listed.
		const apps = app
			.split(',')
			.filter(Boolean)
			.map((a) => resolve(a));
		const names = new Set<string>(installed_packages(apps, packages));
		for (const r of reports) for (const p of Object.keys(r.app.ogygia)) names.add(p);
		const concrete = [...names].filter((n) =>
			packages.some((p) => p === n || (p.endsWith('/*') && n.startsWith(p.slice(0, -1))))
		);
		const inventory = package_inventory(apps, concrete, (l) => console.error(l));
		const cov = build_coverage(reports, packages, inventory);
		writeFileSync(flags.get('out') ?? 'coverage.json', JSON.stringify(cov, null, '\t') + '\n');
		const md = render_coverage(cov);
		const md_out = flags.get('md');
		if (md_out) writeFileSync(md_out, md + '\n');
		else console.log(md);
		return 0;
	}
	return null;
}

/** `heisenbench diff --weights a.json[,b.json]`: every finding ranked (null without weights). */
export function diff_ranking(
	result: DiffResult,
	base: Report,
	pr: Report,
	flags: Map<string, string>
): Ranking | null {
	const weights = flags.get('weights');
	if (!weights) return null;
	const rpd = flags.get('requests-per-day');
	return rank_findings(result, base, pr, load_weights_list(weights), undefined, {
		requests_per_day: rpd === undefined ? undefined : Number(rpd)
	});
}

/** Extra sections of `heisenbench diff` (empty when none applies). */
export function app_diff_sections(
	result: DiffResult,
	base: Report,
	pr: Report,
	flags: Map<string, string>,
	ranking: Ranking | null = diff_ranking(result, base, pr, flags)
): string {
	const parts: string[] = [];
	const b = base as Partial<AppReport>;
	const p = pr as Partial<AppReport>;
	if (b.app && p.app) parts.push(render_app_diff(result, base as AppReport, pr as AppReport));
	if (ranking) parts.push(render_weighted(ranking.ranked, ranking.basis, ranking));
	return parts.join('\n');
}
