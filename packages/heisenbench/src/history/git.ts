import { execFileSync } from 'node:child_process';
import { check_rev, parse_diff } from '../diff/git.ts';
import type { FileDiff } from '../diff/git.ts';

/*
 * What `heisenbench history` asks git, each answer kept for the run: the first-parent order, a
 * file's text and blame at a commit, renames and hunks between two commits. Every revision goes
 * through check_rev (they come from report files).
 */

/** Where a line came from, as `git blame -M -C` says it: the commit, and its path and line there. */
export interface Origin {
	commit: string;
	path: string;
	line: number;
}

export class Git {
	readonly repo: string;
	#text = new Map<string, string[] | null>();
	#blame = new Map<string, Origin[] | null>();
	#subjects = new Map<string, string>();
	#renames = new Map<string, Map<string, string>>();
	#hunks = new Map<string, FileDiff[]>();
	#trees = new Map<string, string | null>();

	constructor(repo: string) {
		this.repo = repo;
	}

	run(args: string[]): string {
		return execFileSync('git', args, {
			cwd: this.repo,
			encoding: 'utf8',
			maxBuffer: 1 << 30,
			stdio: ['ignore', 'pipe', 'pipe']
		});
	}

	try_run(args: string[]): string | null {
		try {
			return this.run(args);
		} catch {
			return null;
		}
	}

	resolve(rev: string): string {
		return this.run([
			'rev-parse',
			'--verify',
			'--end-of-options',
			`${check_rev(rev)}^{commit}`
		]).trim();
	}

	/** The first-parent commits up to `rev`, oldest first. */
	first_parents(rev: string): string[] {
		return this.run(['rev-list', '--first-parent', '--end-of-options', check_rev(rev)])
			.split('\n')
			.filter(Boolean)
			.reverse();
	}

	/** The subject line of a commit. */
	subject(sha: string): string {
		let s = this.#subjects.get(sha);
		if (s === undefined) {
			s = (
				this.try_run(['log', '-1', '--format=%s', '--end-of-options', check_rev(sha)]) ?? ''
			).trim();
			this.#subjects.set(sha, s);
		}
		return s;
	}

	/** The file's lines at a commit (index 0 is line 1), or null when the commit has no such file. */
	lines(sha: string, path: string): string[] | null {
		const key = `${sha}:${path}`;
		if (this.#text.has(key)) return this.#text.get(key)!;
		const text = this.try_run(['show', `${check_rev(sha)}:${path}`]);
		const lines = text === null ? null : text.replace(/\n$/, '').split('\n');
		this.#text.set(key, lines);
		return lines;
	}

	/** The id of a tree or blob at a commit (`packages/core/bench`), or null when it is not there. */
	object(sha: string, path: string): string | null {
		const key = `${sha}:${path}`;
		if (!this.#trees.has(key))
			this.#trees.set(
				key,
				this.try_run(['rev-parse', `${check_rev(sha)}:${path}`])?.trim() ?? null
			);
		return this.#trees.get(key)!;
	}

	/** The files under a directory at a commit, sorted. */
	files(sha: string, dir: string): string[] {
		return this.run(['ls-tree', '-r', '--name-only', '-z', check_rev(sha), '--', `${dir}/`])
			.split('\0')
			.filter(Boolean)
			.sort();
	}

	/**
	 * `git blame -M -C since..sha` of the file at `sha` (index 0 is line 1): a line no commit after
	 * `since` wrote is blamed on `since` (the boundary), at its line and path there, through moves
	 * inside the file and moves or copies from other files changed in the same commit. Blaming
	 * the range, not the whole history, costs milliseconds where a full `-C` blame takes a second.
	 */
	blame_since(since: string, sha: string, path: string): Origin[] | null {
		const key = `${since}..${sha}:${path}`;
		if (this.#blame.has(key)) return this.#blame.get(key)!;
		const out = this.try_run([
			'blame',
			'--line-porcelain',
			'-M',
			'-C',
			// blame reads `--end-of-options` as the end of its revisions; check_rev keeps out options
			`${check_rev(since)}..${check_rev(sha)}`,
			'--',
			path
		]);
		const origins = out === null ? null : parse_blame(out);
		this.#blame.set(key, origins);
		return origins;
	}

	/** Files renamed from `a` to `b` (`git diff -M`): new path -> old path. */
	renames(a: string, b: string): Map<string, string> {
		const key = `${a} ${b}`;
		let m = this.#renames.get(key);
		if (m) return m;
		m = new Map();
		const out = this.run([
			'-c',
			'core.quotePath=false',
			'diff',
			'--no-color',
			'--no-ext-diff',
			'-M',
			'--name-status',
			'-z',
			'--end-of-options',
			check_rev(a),
			check_rev(b),
			'--'
		]);
		const parts = out.split('\0');
		for (let i = 0; i < parts.length;) {
			const status = parts[i];
			if (status.startsWith('R') || status.startsWith('C')) {
				if (status.startsWith('R')) m.set(parts[i + 2], parts[i + 1]);
				i += 3;
			} else i += status === '' ? 1 : 2;
		}
		this.#renames.set(key, m);
		return m;
	}

	/** The zero-context hunks of one file between two commits (old path at `a`, new path at `b`). */
	hunks(a: string, b: string, old_path: string, new_path: string): FileDiff | null {
		const key = `${a} ${b} ${old_path} ${new_path}`;
		let d = this.#hunks.get(key);
		if (!d) {
			const out = this.run([
				'-c',
				'core.quotePath=false',
				'diff',
				'--no-color',
				'--no-ext-diff',
				'--src-prefix=a/',
				'--dst-prefix=b/',
				'--unified=0',
				'--end-of-options',
				`${check_rev(a)}:${old_path}`,
				`${check_rev(b)}:${new_path}`
			]);
			d = parse_diff(out);
			this.#hunks.set(key, d);
		}
		return d[0] ?? null;
	}
}

/** `git blame --line-porcelain`: one header (`sha orig final [n]`) and its fields per line. */
export function parse_blame(out: string): Origin[] {
	const origins: Origin[] = [];
	let commit = '';
	let line = 0;
	for (const row of out.split('\n')) {
		if (row.startsWith('\t')) {
			continue;
		}
		const head = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(row);
		if (head) {
			commit = head[1];
			line = Number(head[2]);
		} else if (row.startsWith('filename ')) {
			origins.push({ commit, path: row.slice(9), line });
		}
	}
	return origins;
}
