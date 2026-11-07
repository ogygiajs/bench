import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { parse_diff } from '../diff/git.ts';
import type { FileDiff } from '../diff/git.ts';

/*
 * The two versions of an upgraded package, on disk and line for line.
 *
 * A dependency module is `name@version/path/in/pkg` (identity.ts). To place a change on lines, the
 * diff needs the package's own `git diff` between its two versions, as it has the project's: lines
 * that only moved compare one to one, and lines inside an upstream hunk are "new code". Files the
 * package moved between the versions are renames, found the way git finds them (`-M`), so a
 * function whose file moved is still the same function.
 */

function version_of(dir: string): string | null {
	try {
		const v = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown })
			.version;
		return typeof v === 'string' ? v : null;
	} catch {
		return null;
	}
}

function name_of(dir: string): string | null {
	try {
		const n = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown })
			.name;
		return typeof n === 'string' ? n : null;
	} catch {
		return null;
	}
}

function entries(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/**
 * Where package `name` at `version` is installed under `root`, resolved through links; null when
 * it is not. Looks where package managers put it: pnpm's store (`node_modules/.pnpm/<name>@<v>…`),
 * the root's `node_modules`, the `node_modules` of each directory the project's modules are in and
 * their parents (`starts`, relative to the root), and one level of nesting under the root's.
 */
export function find_package_dir(
	root: string,
	name: string,
	version: string,
	starts: readonly string[] = []
): string | null {
	const hit = (dir: string): string | null => {
		if (!existsSync(join(dir, 'package.json'))) return null;
		if (version_of(dir) !== version || name_of(dir) !== name) return null;
		return realpathSync(dir);
	};
	const store = join(root, 'node_modules', '.pnpm');
	const lead = `${name.replace('/', '+')}@${version}`;
	for (const e of entries(store)) {
		if (e !== lead && !e.startsWith(lead + '_') && !e.startsWith(lead + '(')) continue;
		const got = hit(join(store, e, 'node_modules', ...name.split('/')));
		if (got) return got;
	}
	const dirs = new Set<string>(['']);
	for (const s of starts) {
		let d = dirname(s);
		while (d !== '.' && d !== '' && d !== '/') {
			dirs.add(d);
			d = dirname(d);
		}
	}
	for (const d of [...dirs].sort((a, b) => b.length - a.length || (a < b ? -1 : 1))) {
		const got = hit(join(root, d, 'node_modules', ...name.split('/')));
		if (got) return got;
	}
	const top = join(root, 'node_modules');
	for (const e of entries(top)) {
		if (e.startsWith('.')) continue;
		const pkgs = e.startsWith('@') ? entries(join(top, e)).map((x) => join(e, x)) : [e];
		for (const p of pkgs) {
			const got = hit(join(top, p, 'node_modules', ...name.split('/')));
			if (got) return got;
		}
	}
	return null;
}

/**
 * `git diff --no-index -M --unified=0` of one package between two installed versions, with the
 * paths as module ids: `svelte@5.56.8/src/x.js` → `svelte@5.57.3/src/x.js`. Files of nested
 * `node_modules` are left out (they are other packages).
 */
export function package_diffs(
	old_dir: string,
	new_dir: string,
	old_label: string,
	new_label: string
): FileDiff[] {
	// paths relative to `/`, so git prints them whole (`a/private/tmp/...`) and they can be cut back
	const rel = (p: string) => realpathSync(p).split(sep).join('/').replace(/^\/+/, '');
	const a = rel(old_dir);
	const b = rel(new_dir);
	let out: string;
	try {
		out = execFileSync(
			'git',
			[
				'-c',
				'core.quotePath=false',
				'diff',
				'--no-index',
				'--no-color',
				'--no-ext-diff',
				'--src-prefix=a/',
				'--dst-prefix=b/',
				'-M',
				'--unified=0',
				'--',
				a,
				b
			],
			{ cwd: '/', encoding: 'utf8', maxBuffer: 1 << 29, stdio: ['ignore', 'pipe', 'pipe'] }
		);
	} catch (e) {
		// exit 1: the two differ (the usual case); anything else is an error
		const err = e as { status?: number; stdout?: string };
		if (err.status !== 1 || typeof err.stdout !== 'string') throw e;
		out = err.stdout;
	}
	const cut = (p: string | null, from: string, label: string): string | null => {
		if (p === null) return null;
		const q = p.replace(/^\/+/, '');
		if (!q.startsWith(from + '/')) return null;
		const inner = q.slice(from.length + 1);
		if (inner.split('/').includes('node_modules')) return null;
		return `${label}/${inner}`;
	};
	const files: FileDiff[] = [];
	for (const f of parse_diff(out)) {
		const old_path = cut(f.old_path, a, old_label);
		const new_path = cut(f.new_path, b, new_label);
		if (old_path === null && new_path === null) continue;
		files.push({ old_path, new_path, hunks: f.hunks });
	}
	return files;
}

/** The lines `from..to` of a file of a package (1-based, inclusive), or null when it cannot be read. */
export function package_lines(
	dir: string,
	path: string,
	from: number,
	to: number
): string[] | null {
	try {
		const lines = readFileSync(join(dir, ...path.split('/')), 'utf8').split('\n');
		return lines.slice(Math.max(0, from - 1), Math.min(lines.length, to));
	} catch {
		return null;
	}
}
