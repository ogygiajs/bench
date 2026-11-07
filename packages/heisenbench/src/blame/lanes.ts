import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { own_file } from '../own.ts';
import { ProcessError, run_process } from '../proc.ts';
import { one_line } from '../report.ts';
import type { TreeFiles } from './hunks.ts';
import { mirror_tree, remove_tree, write_tree } from './tree.ts';

/*
 * Recounting candidate trees side by side (blame, and the mutation layer). A lane is a scratch copy
 * of the run root (tree.ts); a candidate tree is written into a free lane, counted there by a
 * child of its own (blame/child.ts) with the runner every `heisenbench run` uses, and the lane goes
 * back to the pool. The user's checkout is never written to.
 *
 * A lane remembers the paths the last tree wrote: a tree that does not write one of them gets the
 * root's own content back there, so each count sees the root plus exactly its own files.
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

export class Lanes {
	#free: string[] = [];
	#made = 0;
	#waiting: Array<(dir: string) => void> = [];
	#written = new Map<string, Set<string>>();
	root: string;
	work: string;
	jobs: number;
	fixed: TreeFiles;
	prefix: string;
	modules: 'link' | 'copy';
	constructor(
		root: string,
		work: string,
		jobs: number,
		fixed: TreeFiles,
		prefix: string,
		modules: 'link' | 'copy' = 'link'
	) {
		this.root = root;
		this.work = work;
		this.jobs = jobs;
		this.fixed = fixed;
		this.prefix = prefix;
		this.modules = modules;
	}

	take(): Promise<string> {
		const dir = this.#free.pop();
		if (dir) return Promise.resolve(dir);
		if (this.#made < this.jobs) {
			const d = join(this.work, `tree-${this.#made++}`);
			remove_tree(d); // one a stopped run left
			mirror_tree(this.root, d, this.modules);
			write_tree(d, this.fixed, this.prefix);
			return Promise.resolve(d);
		}
		return new Promise((r) => this.#waiting.push(r));
	}

	give(dir: string): void {
		const w = this.#waiting.shift();
		if (w) w(dir);
		else this.#free.push(dir);
	}

	/** Write a tree into a lane: its files, and the root's content where the last tree wrote others. */
	put(lane: string, files: TreeFiles): void {
		const lead = this.prefix ? this.prefix.replace(/\/$/, '') + '/' : '';
		const all = new Map(files);
		for (const p of this.#written.get(lane) ?? []) {
			if (all.has(p) || this.fixed.has(p) || !p.startsWith(lead)) continue;
			let bytes: Buffer | null = null;
			try {
				bytes = readFileSync(join(this.root, ...p.slice(lead.length).split('/')));
			} catch {
				bytes = null;
			}
			all.set(p, bytes);
		}
		write_tree(lane, all, this.prefix);
		this.#written.set(lane, new Set(files.keys()));
	}

	remove(): void {
		for (let i = 0; i < this.#made; i++) remove_tree(join(this.work, `tree-${i}`));
	}
}

export interface ChildOptions {
	/** The root as given and as resolved through links: Node flags into either move to the lane. */
	given_root: string;
	root: string;
	node_args: readonly string[];
	env: NodeJS.ProcessEnv;
	timeout_ms: number;
}

/**
 * Run a recount child (blame/child.ts) on `job` in `lane`: null, or why it did not finish. A
 * preload in the root (ogygia maps Vite-only specifiers to stubs) loads from the lane's copy.
 */
export async function run_child(
	lane: string,
	job: object,
	job_file: string,
	o: ChildOptions
): Promise<string | null> {
	writeFileSync(job_file, JSON.stringify(job));
	const move = (args: readonly string[]) =>
		move_args(move_args(args, o.given_root, lane), o.root, lane);
	const opts = (o.env.NODE_OPTIONS ?? '').split(' ').filter(Boolean);
	try {
		await run_process(process.execPath, [...move(o.node_args), own_file('blame/child'), job_file], {
			cwd: lane,
			env: { ...o.env, NODE_OPTIONS: move(opts).join(' ') },
			timeout_ms: o.timeout_ms
		});
		return null;
	} catch (e) {
		const tail =
			e instanceof ProcessError
				? (e.stderr || e.stdout).trim().split('\n').slice(-3).join(' ')
				: '';
		return `the recount ${one_line(e)}${tail ? `: ${tail}` : ''}`;
	}
}
