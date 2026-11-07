import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { UsageError } from '../usage.ts';
import { Git } from './git.ts';
import { build_history, run_of } from './index.ts';
import type { HistoryRun } from './index.ts';
import { render_history, render_history_text } from './markdown.ts';

const SHA_FILE = /^([0-9a-f]{40})\.json$/;

/**
 * The runs under `--reports`: files, or directories read recursively. A file named `<sha>.json`
 * (the results branch's layout) whose commit is not on the line is never parsed: a results branch
 * holds every PR's run too.
 */
export function read_runs(paths: string[], on_line: ReadonlySet<string>): HistoryRun[] {
	const runs: HistoryRun[] = [];
	const read = (file: string, given: boolean): void => {
		const m = SHA_FILE.exec(basename(file));
		if (!given && (!file.endsWith('.json') || (m && !on_line.has(m[1])))) return;
		let json: unknown;
		try {
			json = JSON.parse(readFileSync(file, 'utf8'));
		} catch {
			if (given) throw new UsageError(`${file} is not JSON`);
			return;
		}
		const r = run_of(json, file);
		if (r) runs.push(r);
		else if (given) throw new UsageError(`${file} holds no report`);
	};
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const p = join(dir, name);
			if (statSync(p).isDirectory()) walk(p);
			else read(p, false);
		}
	};
	for (const p of paths) {
		if (!existsSync(p)) throw new UsageError(`--reports ${p}: no such file or directory`);
		if (statSync(p).isDirectory()) walk(p);
		else read(p, true);
	}
	return runs;
}

/**
 * `heisenbench history <file>[:<function>] --reports <dirs or files>`: every line of the file with
 * its steps per call today, the commit that last changed its cost and by how much, and each
 * function's timeline (history/index.ts).
 */
export async function history_command(
	positional: string[],
	flags: Map<string, string>
): Promise<number> {
	const reports = flags.get('reports');
	if (!reports)
		throw new UsageError('--reports <dir or file>[,...] (the runs of each commit) is required');
	const repo = resolve(flags.get('repo') ?? process.cwd());
	const rev = flags.get('rev') ?? 'HEAD';
	const git = new Git(repo);
	const head = git.resolve(rev);
	const target = positional[0];
	// `file:function`: the first `:` after which the left part is a file at the commit
	let file = target;
	let fn: string | null = null;
	if (git.lines(head, target) === null) {
		for (let i = target.indexOf(':'); i !== -1; i = target.indexOf(':', i + 1)) {
			if (git.lines(head, target.slice(0, i)) !== null) {
				file = target.slice(0, i);
				fn = target.slice(i + 1);
				break;
			}
		}
		if (fn === null)
			throw new UsageError(
				`${target} is not a file at ${rev} (paths are from the top of the repository)`
			);
	}
	const runs = read_runs(reports.split(',').filter(Boolean), new Set(git.first_parents(head)));
	if (runs.length === 0)
		throw new UsageError(`--reports ${reports}: no report of a commit on ${rev}'s line`);
	const result = build_history({ repo, file, function: fn, runs, rev: head });
	const json = flags.get('out');
	if (json) writeFileSync(json, JSON.stringify(result, null, '\t') + '\n');
	const md = flags.get('md');
	if (md) writeFileSync(md, render_history(result));
	console.log(render_history_text(result));
	return 0;
}
