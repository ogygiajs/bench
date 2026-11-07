import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { diff_reports } from '../diff/index.ts';
import { git_diff } from '../diff/git.ts';
import type { Report } from '../report.ts';
import { UsageError } from '../usage.ts';
import { blame_regressions, regressed_cases } from './index.ts';
import { render_blame } from './markdown.ts';

/**
 * `heisenbench blame <base.json> <pr.json> --root <dir>`: the hunks of the PR that made its
 * regressed cases slower. The root is the PR's checkout, installed (never written to); the repo
 * (default: the root) has both commits.
 */
export async function blame_command(
	positional: string[],
	flags: Map<string, string>,
	read_report: (path: string) => Report,
	deps: boolean | string[]
): Promise<number> {
	const base = read_report(positional[0]);
	const pr = read_report(positional[1]);
	const root = flags.get('root');
	if (root === undefined)
		throw new UsageError('--root <dir> (the PR checkout, installed) is required');
	const repo = resolve(flags.get('repo') ?? root);
	const base_sha = flags.get('base') ?? base.git.sha;
	const head_sha = flags.get('head') ?? pr.git.sha;
	if (!base_sha || !head_sha)
		throw new UsageError('--base and --head are required (the reports name no commit)');
	const num = (k: string) => (flags.has(k) ? Number(flags.get(k)) : undefined);
	const diff = diff_reports(base, pr, { files: git_diff(repo, base_sha, head_sha) });
	let cases = regressed_cases(diff, pr, { min_ratio: num('min-ratio') });
	const filter = flags.get('filter');
	if (filter) cases = cases.filter((c) => c.name.includes(filter));
	const paths_file = flags.get('paths');
	const paths = paths_file
		? readFileSync(paths_file, 'utf8')
				.split('\n')
				.map((l) => l.trim())
				.filter(Boolean)
		: null;
	if (cases.length === 0) {
		console.log('heisenbench blame: no case got slower past the threshold; nothing to blame');
		return 0;
	}
	const result = await blame_regressions({
		repo,
		root,
		base: base_sha,
		head: head_sha,
		cases,
		paths,
		prefix: pr.git.prefix,
		deps,
		max_recounts: num('max-recounts'),
		budget_ms: num('budget-ms'),
		jobs: num('jobs'),
		work: flags.get('work'),
		log: (l) => console.log(l)
	});
	const md = render_blame(result);
	const out = flags.get('md');
	if (out) writeFileSync(out, md);
	else console.log('\n' + md);
	const json = flags.get('out');
	if (json) writeFileSync(json, JSON.stringify(result, null, '\t') + '\n');
	return 0;
}
