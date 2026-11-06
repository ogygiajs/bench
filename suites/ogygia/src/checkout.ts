/**
 * ogygia checkouts: one clone of the repository, and a tree per measured commit beside it.
 *
 *   <work>/repo            the clone (no checkout): every commit, the diffs come from here
 *   <work>/trees/<sha12>   a commit's files, installed, with Abax linked in
 *
 * A tree that is already checked out and installed at its commit is reused (local reruns).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface Tree {
	dir: string;
	sha: string;
	/** `internal/abax/src/preload.ts` of the tree, when it has one. */
	preload: string | null;
	/** Bench files, relative to the tree (`packages/<pkg>/bench/<name>.bench.ts`). */
	benches: string[];
}

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		maxBuffer: 1 << 28,
		stdio: ['ignore', 'pipe', 'inherit']
	}).trim();
}

function has_commit(repo: string, sha: string): boolean {
	try {
		execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: repo, stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

/** The clone at `<work>/repo`, holding every commit in `shas`. */
export function clone(url: string, work: string, shas: string[]): string {
	const repo = join(work, 'repo');
	mkdirSync(work, { recursive: true });
	if (!existsSync(join(repo, '.git'))) {
		git(work, ['clone', '--quiet', '--no-checkout', url, repo]);
	}
	const missing = shas.filter((s) => !has_commit(repo, s));
	if (missing.length > 0) {
		git(repo, ['fetch', '--quiet', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
		// A PR head lives under refs/pull; fetching it by sha works on GitHub.
		for (const s of missing) if (!has_commit(repo, s)) git(repo, ['fetch', '--quiet', 'origin', s]);
	}
	return repo;
}

export function rev_parse(repo: string, rev: string): string {
	return git(repo, ['rev-parse', '--verify', `${rev}^{commit}`]);
}

export function merge_base(repo: string, a: string, b: string): string {
	return git(repo, ['merge-base', a, b]);
}

/** Paths that differ between two commits (renames as their new path, deletions as the old). */
export function changed_files(repo: string, base: string, head: string): string[] {
	const out = git(repo, ['diff', '--name-only', '--no-renames', base, head]);
	return out === '' ? [] : out.split('\n').sort();
}

function bench_files(dir: string): string[] {
	const packages = join(dir, 'packages');
	if (!existsSync(packages)) return [];
	const out: string[] = [];
	for (const name of readdirSync(packages).sort()) {
		const bench = join(packages, name, 'bench');
		if (!existsSync(bench)) continue;
		for (const f of readdirSync(bench).sort()) {
			if (f.endsWith('.bench.ts')) out.push(`packages/${name}/bench/${f}`);
		}
	}
	return out;
}

/** Where the tree of commit `sha` lives. */
export function tree_dir(work: string, sha: string): string {
	return join(work, 'trees', sha.slice(0, 12));
}

/** Remove the tree of commit `sha` (its checkout and its install). */
export function remove_tree(work: string, sha: string): void {
	rmSync(tree_dir(work, sha), { recursive: true, force: true });
}

/**
 * The tree of commit `sha`: checked out, installed, and with Abax linked in by the tree's own
 * `internal/abax/src/types.ts` (which also writes the bench files' types).
 */
export function prepare_tree(
	repo: string,
	work: string,
	sha: string,
	abax_dir: string,
	log: (line: string) => void
): Tree {
	const dir = tree_dir(work, sha);
	const installed = existsSync(join(dir, 'node_modules', '.modules.yaml'));
	const at_sha = existsSync(join(dir, '.git')) && rev_parse(dir, 'HEAD') === sha;
	if (!(installed && at_sha)) {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(join(work, 'trees'), { recursive: true });
		log(`checkout ${sha.slice(0, 12)}`);
		git(work, ['clone', '--quiet', '--shared', '--no-checkout', repo, dir]);
		git(dir, ['checkout', '--quiet', '--detach', sha]);
		log(`install ${sha.slice(0, 12)}`);
		execFileSync(
			'pnpm',
			['install', '--frozen-lockfile', '--prefer-offline', '--config.confirmModulesPurge=false'],
			{ cwd: dir, stdio: ['ignore', 'inherit', 'inherit'] }
		);
	}
	const benches = bench_files(dir);
	const types = join(dir, 'internal', 'abax', 'src', 'types.ts');
	if (benches.length > 0 && existsSync(types)) {
		log(`types ${sha.slice(0, 12)}`);
		execFileSync(process.execPath, [types], {
			cwd: dir,
			stdio: ['ignore', 'inherit', 'inherit'],
			env: { ...process.env, ABAX_DIR: abax_dir }
		});
	}
	const preload = join(dir, 'internal', 'abax', 'src', 'preload.ts');
	return { dir, sha, preload: existsSync(preload) ? preload : null, benches };
}
