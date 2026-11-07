#!/usr/bin/env node
// PR vs base on the real apps (Heisenbench, spec 8 + 11), like the app benchmark's A/B: two ogygia
// specs, each app built counted for both, every scenario run on both, one run each (the counts
// are exact), then `heisenbench diff` of the two app reports:
//
//   dashboard server request (GET /): 1.63M → 1.66M steps (+1.8%), mostly `…/hooks.js:662`
//
//   node heisenbench/ab.ts --spec <pr spec> --base-spec <base spec> [--scenarios dashboard,shop]
//   node heisenbench/ab.ts --installed            # both twins are installed already (build-all.ts)
//
// Specs are what build-all.ts takes: an npm version or dist-tag, or a pkg.pr.new URL.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { diffReports, renderMarkdown } from '@bench/heisenbench';
import { overlay_diff, render_app_diff } from '@bench/heisenbench/app';
import type { FileDiff } from '@bench/heisenbench/app';
import { APP_DIRS, SCENARIOS, base_dir } from './scenarios.ts';
import { ROOT, count_apps, parse_args } from './count.ts';

const args = parse_args(process.argv.slice(2));
const one = (k: string): string | undefined => args.get(k)?.at(-1);
const scenarios = one('scenarios')?.split(',') ?? Object.keys(SCENARIOS);
const out = resolve(one('out') ?? join(ROOT, 'results/scratch/heisenbench/ab'));
mkdirSync(out, { recursive: true });

if (!args.has('installed')) {
	const spec = one('spec');
	const base = one('base-spec');
	if (!spec || !base) {
		console.error('ab.ts: --spec and --base-spec (or --installed)');
		process.exit(2);
	}
	// build-all installs both twins (`ogygia`, `ogygia-base`) and builds them the normal way.
	const app_scenarios = scenarios.filter((s) => s !== 'blog');
	const r = spawnSync(
		process.execPath,
		[
			join(ROOT, 'build-all.ts'),
			'--spec',
			spec,
			'--base-spec',
			base,
			'--scenarios',
			app_scenarios.length ? app_scenarios.join(',') : 'none',
			...(scenarios.includes('blog') ? [] : ['--no-blog'])
		],
		{ stdio: 'inherit', cwd: ROOT }
	);
	if (r.status !== 0) process.exit(r.status ?? 1);
}

// One work directory for both sides: the copies share a path (paths end up in app strings).
const work = join(tmpdir(), 'heisenbench-ab');
const pr = await count_apps({ scenarios, side: 'pr', work, sha: one('sha') ?? null });
const base = await count_apps({ scenarios, side: 'base', work, sha: one('base-sha') ?? null });
writeFileSync(join(out, 'pr.json'), JSON.stringify(pr.report) + '\n');
writeFileSync(join(out, 'base.json'), JSON.stringify(base.report) + '\n');

// Lines move between two builds of a package: map them through a diff of each counted module's
// installed file, PR against base, as `heisenbench diff` maps a commit's lines through git.
function module_diffs(): FileDiff[] {
	const name = scenarios[0];
	const pr_app = join(ROOT, APP_DIRS[name]);
	const base_app = join(ROOT, base_dir(APP_DIRS[name]));
	const out_diffs: FileDiff[] = [];
	for (const id of Object.keys(pr.report.app.loaded)) {
		const a = join(base_app, 'node_modules', id);
		const b = join(pr_app, 'node_modules', id);
		if (!existsSync(a) || !existsSync(b)) continue;
		if (readFileSync(a, 'utf8') === readFileSync(b, 'utf8')) continue;
		out_diffs.push(overlay_diff(id, a, b));
	}
	return out_diffs;
}
const d = diffReports(base.report, pr.report, { files: module_diffs() });
const md = [
	render_app_diff(d, base.report, pr.report),
	`PR: ${JSON.stringify(pr.report.app.ogygia)}  \nBase: ${JSON.stringify(base.report.app.ogygia)}`,
	'',
	renderMarkdown(d)
].join('\n');
writeFileSync(join(out, 'ab.md'), md + '\n');
console.log('\n' + render_app_diff(d, base.report, pr.report));
const problems = [...pr.errors, ...base.errors];
for (const p of problems) console.log(`problem: ${p.split('\n')[0]}`);
console.log(`\n-> ${out}/ab.md`);
process.exitCode = problems.length > 0 ? 1 : 0;
