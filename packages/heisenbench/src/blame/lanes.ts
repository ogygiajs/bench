import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TreeFiles } from './hunks.ts';
import { mirror_tree, remove_tree, write_tree } from './tree.ts';

/*
 * Scratch copies of the run root to count candidate trees in, side by side (blame, and the
 * mutation layer). A candidate tree is written into a free lane, counted there (recount.ts), and
 * the lane goes back to the pool. The user's checkout is never written to.
 *
 * A lane remembers the paths the last tree wrote: a tree that does not write one of them gets the
 * root's own content back there, so each count sees the root plus exactly its own files.
 */

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
	/** Copy the root's dependencies into each lane instead of linking them (tree.ts). */
	copy_modules: boolean;
	constructor(
		root: string,
		work: string,
		jobs: number,
		fixed: TreeFiles,
		prefix: string,
		copy_modules = false
	) {
		this.root = root;
		this.work = work;
		this.jobs = jobs;
		this.fixed = fixed;
		this.prefix = prefix;
		this.copy_modules = copy_modules;
	}

	take(): Promise<string> {
		const dir = this.#free.pop();
		if (dir) return Promise.resolve(dir);
		if (this.#made < this.jobs) {
			const d = join(this.work, `tree-${this.#made++}`);
			remove_tree(d); // one a stopped run left
			mirror_tree(this.root, d, { copy_modules: this.copy_modules });
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
