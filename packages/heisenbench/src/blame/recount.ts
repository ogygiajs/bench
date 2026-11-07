import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { LoaderConfig } from '../loader/register.ts';
import { own_file } from '../own.ts';
import { ProcessError, run_process } from '../proc.ts';
import { one_line } from '../report.ts';
import type { Report } from '../report.ts';

/*
 * One recount: the named cases of some bench files counted on a scratch tree (tree.ts), in a child
 * of its own (child.ts) with the runner every `heisenbench run` uses. Blame counts its candidate
 * trees this way, and an upgrade diff (upgrade/) its two dependency trees.
 */

const PATH_FLAGS = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader']);

/** Node flags with every path into `root` moved into `lane` (relative ones resolved first). */
export function move_args(args: readonly string[], root: string, lane: string): string[] {
	const move = (v: string): string => {
		if (!(v.startsWith('.') || isAbsolute(v))) return v; // a package name
		const abs = resolve(v);
		return abs === root || abs.startsWith(root + sep) ? lane + abs.slice(root.length) : abs;
	};
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const eq = a.indexOf('=');
		if (eq !== -1 && PATH_FLAGS.has(a.slice(0, eq)))
			out.push(a.slice(0, eq + 1) + move(a.slice(eq + 1)));
		else if (PATH_FLAGS.has(a) && i + 1 < args.length) out.push(a, move(args[++i]));
		else out.push(a);
	}
	return out;
}

export interface RecountOptions {
	/** The scratch tree the cases are counted in. */
	lane: string;
	/** The root the tree was copied from, as given and resolved: paths into it move to the lane. */
	given_root: string;
	root: string;
	/** Bench files, relative to the root. */
	files: readonly string[];
	cases: readonly string[];
	/** The root's place in its repository (the scratch copy is in none). */
	prefix: string;
	deps: LoaderConfig['deps'];
	/** Where the report goes, and the job file the child reads. */
	out: string;
	job_file: string;
	/** Node flags for the child (paths into the root are moved to the lane, NODE_OPTIONS too). */
	node_args: readonly string[];
	env: NodeJS.ProcessEnv;
	timeout_ms: number;
	/**
	 * More of child.ts's job: the mutation layer's twin check, growth, recorded growth, a listing,
	 * a step cap. With growth or a listing the file at `out` holds that instead of a report.
	 */
	job?: Record<string, unknown>;
}

/** Count the cases on the lane; the report, or why there is none. */
export async function recount(
	o: RecountOptions
): Promise<{ report: Report | null; error: string | null }> {
	let error: string | null = null;
	try {
		writeFileSync(
			o.job_file,
			JSON.stringify({
				root: o.lane,
				files: o.files,
				cases: o.cases,
				sha: null,
				prefix: o.prefix,
				deps: o.deps,
				out: o.out,
				...o.job
			})
		);
		// a preload in the root (ogygia maps Vite-only specifiers to stubs) loads from the copy
		const move = (args: readonly string[]) =>
			move_args(move_args(args, o.given_root, o.lane), o.root, o.lane);
		const opts = (o.env.NODE_OPTIONS ?? '').split(' ').filter(Boolean);
		await run_process(
			process.execPath,
			[...move(o.node_args), own_file('blame/child'), o.job_file],
			{
				cwd: o.lane,
				env: { ...o.env, NODE_OPTIONS: move(opts).join(' ') },
				timeout_ms: o.timeout_ms
			}
		);
	} catch (e) {
		const tail =
			e instanceof ProcessError
				? (e.stderr || e.stdout).trim().split('\n').slice(-3).join(' ')
				: '';
		error = `the recount ${one_line(e)}${tail ? `: ${tail}` : ''}`;
	}
	if (error !== null) return { report: null, error };
	try {
		return { report: JSON.parse(readFileSync(o.out, 'utf8')) as Report, error: null };
	} catch (e) {
		return { report: null, error: `no report: ${one_line(e)}` };
	}
}
