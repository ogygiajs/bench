import { writeFileSync } from 'node:fs';
import type { Report } from '../report.ts';
import { UsageError } from '../usage.ts';
import { upgrade_diff } from './index.ts';
import { render_upgrade } from './markdown.ts';

/**
 * `heisenbench upgrade <base.json> <pr.json> --root <pr checkout> --base-root <base checkout>`:
 * what the PR's dependency upgrades cost, counted on the PR's code with each side's install.
 */
export async function upgrade_command(
	positional: string[],
	flags: Map<string, string>,
	read_report: (path: string) => Report,
	deps: boolean | string[]
): Promise<number> {
	const base = read_report(positional[0]);
	const pr = read_report(positional[1]);
	const root = flags.get('root');
	const base_root = flags.get('base-root');
	if (root === undefined)
		throw new UsageError('--root <dir> (the PR checkout, installed) is required');
	if (base_root === undefined)
		throw new UsageError('--base-root <dir> (the base checkout, installed) is required');
	const packages = flags.get('packages')?.split(',').filter(Boolean) ?? null;
	const result = await upgrade_diff({
		base,
		pr,
		root,
		base_root,
		packages,
		deps,
		work: flags.get('work'),
		log: (l) => console.log(l)
	});
	const md = render_upgrade(result);
	const out = flags.get('md');
	if (out) writeFileSync(out, md);
	else console.log('\n' + md);
	const json = flags.get('out');
	if (json) writeFileSync(json, JSON.stringify(result, null, '\t') + '\n');
	return result.failed.length > 0 ? 1 : 0;
}
