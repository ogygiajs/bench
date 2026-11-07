import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Report } from '../report.ts';
import { own_file, package_file } from '../own.ts';

/*
 * What every planted case needs: two sides of a change as two directories (measured apart, the
 * way CI measures two checkouts) and the same change as two commits of one repository (for the
 * line mapping a diff takes from git).
 */

const exec = promisify(execFile);

export const CLI = own_file('cli');
export const BENCH_API = own_file('bench');
/**
 * The answer keys: one directory per layer, `base/` and one directory per planted change. Only a
 * clone of the bench repo has them (`abax verify` says so from npm).
 */
export const KEYS = package_file('test/');

export type Files = Record<string, string>;

export function temp_dir(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function write_all(dir: string, files: Files): void {
	for (const [name, text] of Object.entries(files)) {
		const p = join(dir, name);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, text);
	}
}

/** A key's `lib.ts` of `variant`, with the bench file of `base` (its API path filled in). */
export function key_files(key: string, variant: string, lib = 'lib.ts'): Files {
	const bench = readFileSync(join(KEYS, key, 'base', 'lib.bench.ts.txt'), 'utf8').replace(
		'ABAX_BENCH',
		BENCH_API
	);
	return {
		[lib]: readFileSync(join(KEYS, key, variant, 'lib.ts.txt'), 'utf8'),
		'lib.bench.ts': bench
	};
}

function git(cwd: string, args: string[]): string {
	return execFileSync(
		'git',
		['-c', 'user.name=abax', '-c', 'user.email=abax@example.invalid', ...args],
		{ cwd, encoding: 'utf8' }
	).trim();
}

export interface Pair {
	repo: string;
	base_sha: string;
	pr_sha: string;
	base_dir: string;
	pr_dir: string;
}

/** Both sides as directories, and as two commits of one repository. */
export function make_pair(tmp: string, base: Files, pr: Files): Pair {
	const repo = join(tmp, 'repo');
	write_all(repo, base);
	git(repo, ['init', '-q']);
	git(repo, ['add', '.']);
	git(repo, ['commit', '-q', '-m', 'base']);
	const base_sha = git(repo, ['rev-parse', 'HEAD']);
	write_all(repo, pr);
	git(repo, ['add', '.']);
	git(repo, ['commit', '-q', '--allow-empty', '-m', 'pr']);
	const pr_sha = git(repo, ['rev-parse', 'HEAD']);
	const base_dir = join(tmp, 'base');
	const pr_dir = join(tmp, 'pr');
	write_all(base_dir, base);
	write_all(pr_dir, pr);
	return { repo, base_sha, pr_sha, base_dir, pr_dir };
}

/** `abax <args> lib.bench.ts --root dir`, then the report it wrote. */
export async function cli(dir: string, args: string[], bench = 'lib.bench.ts'): Promise<Report> {
	const out = join(dir, 'abax-report.json');
	await exec(
		process.execPath,
		['--no-warnings', CLI, ...args, bench, '--root', dir, '--out', out],
		{
			cwd: dir,
			maxBuffer: 1 << 26
		}
	);
	return JSON.parse(readFileSync(out, 'utf8')) as Report;
}
