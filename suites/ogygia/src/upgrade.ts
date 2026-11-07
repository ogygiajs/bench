/**
 * What a PR's dependency upgrades cost (`upgradeDiff`). When the base and the head count a package
 * at different versions (the lockfile or a package.json changed it), the head's code is counted
 * again with each tree's install, on scratch copies of the head tree: the step change of the cases
 * that count the package is then the upgrade's alone, placed on the package's own lines through
 * its diff between the two versions. Both trees are installed already, so this costs two recounts
 * of the bench files that reach the package, side by side.
 *
 * It runs after the time layer, which needs the cores.
 */
import { join } from 'node:path';
import { findBumps, upgradeDiff } from '@bench/heisenbench';
import type { Report, UpgradeResult } from '@bench/heisenbench';
import type { Tree } from './checkout.ts';
import { node_options } from './run.ts';

export interface UpgradeRun {
	result: UpgradeResult | null;
	error: string | null;
}

/** Null when the two reports count every package at the same version. */
export async function run_upgrade(
	head: Tree,
	base: Tree,
	head_report: Report,
	base_report: Report,
	work: string,
	log: (line: string) => void
): Promise<UpgradeRun | null> {
	if (findBumps(base_report, head_report).bumps.length === 0) return null;
	try {
		const result = await upgradeDiff({
			base: base_report,
			pr: head_report,
			root: head.dir,
			base_root: base.dir,
			work: join(work, 'upgrade'),
			node_args: [],
			env: { ...process.env, NODE_OPTIONS: node_options(head) },
			log
		});
		return { result, error: null };
	} catch (e) {
		return { result: null, error: e instanceof Error ? e.message : String(e) };
	}
}
