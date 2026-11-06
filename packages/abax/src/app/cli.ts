import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DiffResult } from '../diff/index.ts';
import type { Report } from '../report.ts';
import type { AppReport } from './types.ts';
import { render_app_diff } from './diff.ts';
import { build_weights, load_app_weights, write_app_weights } from '../weight/weights.ts';
import { rank_changes, render_weighted } from '../weight/rank.ts';
import { build_coverage, render_coverage } from '../coverage/report.ts';
import { package_inventory } from '../coverage/inventory.ts';

/*
 * The app commands of the CLI (cli.ts hands them over):
 *
 *   abax weights <app-report.json...> [--out app-weights.json]
 *   abax coverage <app-report.json...> --app <installed app dir> [--packages ogygia,@ogygia/*]
 *                 [--out coverage.json] [--md coverage.md]
 *
 * and the extra sections of `abax diff`: the real-app summary when both reports are app reports,
 * the weighted ranking with `--weights app-weights.json`.
 */

export const APP_USAGE = `abax weights <app-report.json...> [--out app-weights.json]
abax coverage <app-report.json...> --app <installed app dir> [--packages ogygia,@ogygia/*] [--out coverage.json] [--md coverage.md]
abax diff ... [--weights app-weights.json]   (ranks changes by real-app weight; app reports also get a per-phase summary)`;

const DEFAULT_PACKAGES = ['ogygia', '@ogygia/*'];

function read_app(path: string): AppReport {
	const r = JSON.parse(readFileSync(path, 'utf8')) as AppReport;
	if (!r.app) throw new Error(`abax: ${path} is not an app report (no "app" block)`);
	return r;
}

export function app_command(
	cmd: string | undefined,
	positional: string[],
	flags: Map<string, string>
): number | null {
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
		if (positional.length === 0 || !app) {
			console.error(APP_USAGE);
			return 2;
		}
		const packages = flags.get('packages')?.split(',') ?? DEFAULT_PACKAGES;
		const reports = positional.map(read_app);
		const names = new Set<string>();
		for (const r of reports) for (const p of Object.keys(r.app.ogygia)) names.add(p);
		const concrete = [...names].filter((n) =>
			packages.some((p) => p === n || (p.endsWith('/*') && n.startsWith(p.slice(0, -1))))
		);
		const inventory = package_inventory(resolve(app), concrete, (l) => console.error(l));
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

/** Extra sections of `abax diff` (empty when none applies). */
export function app_diff_sections(
	result: DiffResult,
	base: Report,
	pr: Report,
	flags: Map<string, string>
): string {
	const parts: string[] = [];
	const b = base as Partial<AppReport>;
	const p = pr as Partial<AppReport>;
	if (b.app && p.app) parts.push(render_app_diff(result, base as AppReport, pr as AppReport));
	const weights = flags.get('weights');
	if (weights) parts.push(render_weighted(rank_changes(result, load_app_weights(weights))));
	return parts.join('\n');
}
