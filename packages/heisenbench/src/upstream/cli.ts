import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { UsageError } from '../usage.ts';
import { UPGRADE_SCHEMA } from '../upgrade/index.ts';
import type { UpgradeResult } from '../upgrade/index.ts';
import { draft_upstream, write_draft } from './index.ts';

/**
 * `heisenbench upstream draft <upgrade.json>`: an issue for the maintainers of the package an
 * upgrade made slower, with a reproduction script beside it. Written to files; never posted.
 */
export async function upstream_command(
	positional: string[],
	flags: Map<string, string>
): Promise<number> {
	if (positional[0] !== 'draft') throw new UsageError('upstream takes `draft <upgrade.json>`');
	let upgrade: UpgradeResult;
	try {
		upgrade = JSON.parse(readFileSync(positional[1], 'utf8')) as UpgradeResult;
	} catch {
		throw new UsageError(`${positional[1]} is not JSON`);
	}
	if (upgrade?.schema !== UPGRADE_SCHEMA)
		throw new UsageError(
			`${positional[1]} is not a \`heisenbench upgrade --out\` file (no "schema": "${UPGRADE_SCHEMA}")`
		);
	const input = flags.get('input');
	if (input !== undefined && !existsSync(input))
		throw new UsageError(`--input ${input}: no such file`);
	const out = resolve(flags.get('out') ?? 'upstream-issue.md');
	const repro = resolve(flags.get('repro') ?? join(dirname(out), 'repro.ts'));
	const d = await draft_upstream({
		upgrade,
		case: flags.get('case'),
		function: flags.get('function'),
		entry: flags.get('entry'),
		input,
		redact: flags.get('redact')?.split(',').filter(Boolean),
		time_ms: flags.has('time-ms') ? Number(flags.get('time-ms')) : undefined,
		work: flags.get('work'),
		log: (l) => console.log(l)
	});
	write_draft(d, out, repro);
	console.log(
		`\n${d.title}\n\nThe issue is in ${out}, the script in ${repro}. Nothing was posted.`
	);
	return 0;
}
