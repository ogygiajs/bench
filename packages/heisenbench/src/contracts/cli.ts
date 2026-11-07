import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { source_inventory } from '../coverage/gate.ts';
import { write_section } from '../sections.ts';
import type { Report } from '../report.ts';
import { UsageError } from '../usage.ts';
import { check_contracts, contract_lines, render_contracts } from './index.ts';

/*
 * `heisenbench contracts [source files...] [--list files.txt] --reports a.json,b.json`: every
 * complexity contract the source files declare, held against the growth sections of the reports
 * (`heisenbench growth` and `heisenbench growth --recorded` write them). The check is written into
 * `--out` as the `contracts` section, so `heisenbench diff` can show what a PR changed about them.
 * Exit 1 when a contract does not hold, nothing measures it, or a tag declares nothing.
 */

export async function contracts_command(
	positional: string[],
	flags: Map<string, string>
): Promise<number> {
	const root = resolve(flags.get('root') ?? process.cwd());
	const list = flags.has('list')
		? readFileSync(flags.get('list')!, 'utf8').split('\n').filter(Boolean)
		: [];
	const files = [...positional, ...list].map((f) => (isAbsolute(f) ? f : join(root, f)));
	if (files.length === 0) throw new UsageError('which source files? (none given, and no --list)');
	const paths = (flags.get('reports') ?? '').split(',').filter(Boolean);
	if (paths.length === 0)
		throw new UsageError('--reports a.json[,b.json] is required (the growth sections to check)');
	const reports = paths.map((p) => {
		if (!existsSync(p)) throw new UsageError(`--reports: no such file ${p}`);
		return JSON.parse(readFileSync(p, 'utf8')) as Report;
	});
	const bar = flags.has('contract-odds') ? Number(flags.get('contract-odds')) : undefined;
	if (bar !== undefined && !(bar > 0.5 && bar <= 1))
		throw new UsageError(
			`--contract-odds takes a number in (0.5, 1], not ${flags.get('contract-odds')}`
		);
	const inv = source_inventory(root, files);
	for (const e of inv.errors) console.log(`  unreadable: ${e.file}: ${e.error}`);
	const r = check_contracts(inv.contracts ?? [], inv.contract_errors ?? [], reports, { bar });
	const out = flags.get('out') ?? 'heisenbench-report.json';
	write_section(out, 'contracts', r, { root, sha: flags.get('sha') ?? null });
	const md = flags.get('md');
	if (md) writeFileSync(md, render_contracts(r));
	const lines = contract_lines(r);
	console.log(
		[
			...lines,
			`${r.contracts.filter((c) => c.verdict === 'holds').length} of ${r.contracts.length} contracts hold${r.errors.length > 0 ? `; ${r.errors.length} ${r.errors.length === 1 ? 'tag declares' : 'tags declare'} nothing` : ''}`
		].join('\n')
	);
	return r.pass ? 0 : 1;
}
