import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Report } from '../report.ts';
import { git_diff } from '../diff/git.ts';
import { UsageError } from '../usage.ts';
import {
	bench_reached,
	gate,
	measurement_sources,
	read_exemptions,
	record_targets,
	render_gate,
	source_inventory
} from './gate.ts';
import type { SourceInventory } from './gate.ts';
import { read_record_dir, replay_records } from './replay-run.ts';
import type { ReplayResult } from './recorder.ts';
import { read_targets, record_benches } from './record-benches.ts';

/*
 * The CLI of the measurement-source gate (gate.ts):
 *
 *   heisenbench inventory [files...] [--list files.txt] --root dir --out inventory.json
 *                  [--reports a.json,b.json --targets targets.json]
 *       Every function of the files; with counted reports, also the record targets: the functions
 *       no bench ran (`module -> [paths]`, what the test-run recorder wraps).
 *   heisenbench record <bench files...> --targets targets.json --root dir --out samples.bin
 *       Every bench case run once with the recorder on the targets: their calls as samples, like
 *       a recorded test run's (record-benches.ts).
 *   heisenbench replay --records dir --root dir --out replay.json
 *       Merge the sample files a recorded test run wrote and replay them.
 *   heisenbench unmeasured --inventory inventory.json [--reports a.json,b.json] [--records dir]
 *                   [--replay replay.json] [--skipped skipped.json] [--base-inventory base.json]
 *                   [--exempt unmeasured.json] [--out gate.json] [--md gate.md]
 *       The gate: exit 1 when the tree has functions with no measurement source that the base
 *       inventory does not have and no exemption names.
 */

export const COVERAGE_USAGE = `heisenbench inventory [files...] [--list files.txt] --root dir --out inventory.json [--reports a.json,b.json --targets targets.json]
heisenbench record <bench files...> --targets targets.json --root dir --out samples.bin
heisenbench replay --records dir --root dir --out replay.json
heisenbench unmeasured --inventory inventory.json [--reports a.json] [--records dir] [--replay replay.json] [--skipped skipped.json] [--base-inventory base.json] [--repo dir --base sha --head sha] [--exempt file] [--out gate.json] [--md gate.md]`;

type Flags = Map<string, string>;

const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

function reports_of(flags: Flags): Report[] {
	return (flags.get('reports') ?? '')
		.split(',')
		.filter(Boolean)
		.map((p) => read<Report>(p));
}

export async function coverage_command(
	cmd: string,
	positional: string[],
	flags: Flags
): Promise<number | null> {
	if (cmd === 'inventory') {
		const root = resolve(flags.get('root') ?? process.cwd());
		const list = flags.has('list')
			? readFileSync(flags.get('list')!, 'utf8').split('\n').filter(Boolean)
			: [];
		const files = [...positional, ...list].map((f) => (isAbsolute(f) ? f : join(root, f)));
		const out = flags.get('out');
		if (!out) throw new UsageError('--out <inventory.json> is required');
		if (files.length === 0) throw new UsageError('which files? (none given, and no --list)');
		const inv = source_inventory(root, files);
		writeFileSync(out, JSON.stringify(inv, null, '\t') + '\n');
		console.log(
			`${inv.functions.length} functions in ${files.length} files (${inv.errors.length} unreadable)`
		);
		for (const e of inv.errors) console.log(`  unreadable: ${e.file}: ${e.error}`);
		const targets = flags.get('targets');
		if (targets) {
			const t = record_targets(inv, bench_reached(reports_of(flags)));
			writeFileSync(targets, JSON.stringify(t, null, '\t') + '\n');
			const n = Object.values(t).reduce((s, l) => s + l.length, 0);
			console.log(`${n} functions no bench ran -> ${targets}`);
		}
		return 0;
	}
	if (cmd === 'record') {
		const out = flags.get('out');
		const targets = flags.get('targets');
		if (!out) throw new UsageError('--out <samples.bin> is required');
		if (!targets) throw new UsageError('--targets <targets.json> is required');
		const r = await record_benches({
			files: positional,
			root: flags.get('root') ?? process.cwd(),
			targets: read_targets(targets),
			out,
			log: (l) => console.log(l)
		});
		console.log(`${r.ran} cases ran with the recorder on (${r.failed} failed) -> ${out}`);
		return r.ran > 0 ? 0 : 1;
	}
	if (cmd === 'replay') {
		const dir = flags.get('records');
		const out = flags.get('out');
		if (!dir) throw new UsageError('--records <dir> is required');
		if (!out) throw new UsageError('--out <replay.json> is required');
		const records = read_record_dir(dir);
		const results = await replay_records(
			resolve(flags.get('root') ?? process.cwd()),
			records,
			(l) => console.log(l)
		);
		writeFileSync(out, JSON.stringify(results, null, '\t') + '\n');
		const by = new Map<string, number>();
		for (const r of results) by.set(r.status, (by.get(r.status) ?? 0) + 1);
		console.log(
			`${records.length} recorded functions: ${[...by].map(([s, n]) => `${n} ${s}`).join(', ')}`
		);
		return 0;
	}
	if (cmd === 'unmeasured') {
		const inv_path = flags.get('inventory');
		if (!inv_path) throw new UsageError('--inventory <inventory.json> is required');
		const inv = read<SourceInventory>(inv_path);
		const records = flags.has('records') ? read_record_dir(flags.get('records')!) : [];
		const replays = flags.has('replay') ? read<ReplayResult[]>(flags.get('replay')!) : [];
		const skipped = flags.has('skipped')
			? new Set(read<string[]>(flags.get('skipped')!))
			: new Set<string>();
		const measured = measurement_sources(
			inv,
			bench_reached(reports_of(flags)),
			records,
			replays,
			skipped
		);
		const base = flags.get('base-inventory');
		const base_inv = base ? read<SourceInventory>(base) : null;
		const base_ids = base_inv ? new Set(base_inv.functions.map((f) => f.id)) : null;
		const exempt_path = flags.get('exempt');
		const exemptions = exempt_path && existsSync(exempt_path) ? read_exemptions(exempt_path) : [];
		// Files the PR moved keep their functions' history (git rename detection).
		const repo = flags.get('repo');
		const renames = new Map<string, string>();
		if (repo && flags.get('base') && flags.get('head')) {
			for (const f of git_diff(resolve(repo), flags.get('base')!, flags.get('head')!)) {
				if (f.old_path && f.new_path && f.old_path !== f.new_path)
					renames.set(f.old_path, f.new_path);
			}
		}
		// A file nothing could read on the PR's tree, that the base could read (or did not have).
		const base_unreadable = new Set((base_inv?.errors ?? []).map((e) => e.file));
		const unreadable = inv.errors.filter((e) => !base_unreadable.has(e.file));
		const g = gate(measured, base_ids, exemptions, { renames, unreadable });
		const md = render_gate(g);
		const out = flags.get('out');
		if (out) writeFileSync(out, JSON.stringify({ ...g, all: measured }, null, '\t') + '\n');
		const md_out = flags.get('md');
		if (md_out) writeFileSync(md_out, md);
		console.log(md);
		return g.pass ? 0 : 1;
	}
	return null;
}
