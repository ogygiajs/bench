import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GcError, apply_gc, parse_drops, plan_gc, render_gc, scan_results } from '@bench/compare';
import { UsageError } from '../usage.ts';

/**
 * `heisenbench gc --root <results dir> [--drop policy.json] [--dry-run] [--json gc.json]`: drops
 * the run files the policy names, then every shard no kept run file lists (@bench/compare's
 * gc.ts). Nothing is deleted when any run file or shard of the tree cannot be read: exit 1 with
 * the list.
 */
export function gc_command(flags: Map<string, string>): number {
	const root = flags.get('root');
	if (!root)
		throw new UsageError('--root <results dir> (the run files and their shards/) is required');
	const dir = resolve(root);
	if (!existsSync(dir) || !statSync(dir).isDirectory())
		throw new UsageError(`--root ${root}: not a directory`);
	const policy = flags.get('drop');
	const dry_run = flags.has('dry-run');
	try {
		const drops = policy ? parse_drops(readFileSync(policy, 'utf8')) : [];
		const plan = plan_gc(scan_results(dir), drops);
		if (!dry_run) apply_gc(dir, plan);
		const json = flags.get('json');
		if (json) writeFileSync(json, JSON.stringify({ dry_run, ...plan }, null, '\t') + '\n');
		console.log(render_gc(plan, dry_run));
		return 0;
	} catch (e) {
		if (!(e instanceof GcError)) throw e;
		console.error(`heisenbench gc: ${e.message}`);
		return 1;
	}
}
