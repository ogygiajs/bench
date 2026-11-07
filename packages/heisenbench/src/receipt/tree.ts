import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { ProcessError, run_process } from '../proc.ts';
import { one_line } from '../report.ts';

/*
 * The scratch tree a receipt is counted in, made the same way by `receipt` and `verify-receipt`:
 *
 *   <root>/package.json        depends on the package under test as `file:package.tgz`
 *   <root>/package.tgz         the tarball
 *   <root>/package-lock.json   npm's lockfile: every dependency at its version and integrity
 *   <root>/<bench files>       the receipt's bench files at their paths
 *
 * `receipt` installs with `npm install` and keeps the lockfile; `verify-receipt` writes that
 * lockfile back and installs with `npm ci`, so both count on the same dependency tree. Install
 * scripts never run: a receipt counts JavaScript, and a script could make the tree differ.
 *
 * The root is any new directory: the counted code sees it as the virtual root (runtime/paths.ts),
 * so a checker's temp directory counts what the maker's did. Receipts made before that record the
 * fixed length and depth of the root they were counted in (200 characters, 16 directories), and
 * are checked in one padded to them (`make_root`).
 */

export const TARBALL = 'package.tgz';
const PROJECT = 'heisenbench-receipt';

/** Directories in a path: its separators. */
export function depth_of(path: string): number {
	let n = 0;
	for (const ch of path) if (ch === sep) n++;
	return n;
}

/** A new empty root under `work` (a fresh temp directory by default). */
export function new_root(work?: string): string {
	if (work !== undefined) mkdirSync(work, { recursive: true });
	// module ids are paths as the loader sees them, through links (`/var` is `/private/var`)
	return realpathSync(mkdtempSync(join(work ?? tmpdir(), 'r-')));
}

/**
 * A new empty root under `work` (a fresh temp directory by default) whose path is `length`
 * characters long and `depth` directories deep: directories `d` down to the depth, the last one
 * padded to the length.
 */
export function make_root(length: number, depth: number, work?: string): string {
	const base = new_root(work);
	const levels = depth - depth_of(base);
	const room = length - base.length - levels;
	if (levels < 1 || room < levels)
		throw new Error(
			`heisenbench: the work directory ${base} is too long or too deep for a root of ${length} characters and ${depth} directories: give a shorter --work`
		);
	const parts = Array.from({ length: levels - 1 }, () => 'd');
	parts.push('r'.padEnd(room - (levels - 1), '_'));
	const root = join(base, ...parts);
	mkdirSync(root, { recursive: true });
	return root;
}

/** The project file of a scratch tree. */
export function project_json(name: string): string {
	return (
		JSON.stringify(
			{ name: PROJECT, private: true, type: 'module', dependencies: { [name]: `file:${TARBALL}` } },
			null,
			'\t'
		) + '\n'
	);
}

/** A bench file's path in the tree: relative, `/`-separated, never leaving the root. */
export function safe_path(p: string): string {
	const n = normalize(p).split(sep).join('/');
	if (isAbsolute(p) || n.startsWith('../') || n === '..' || n === '' || n === '.')
		throw new Error(`heisenbench: ${p} is not a path inside the tree`);
	return n;
}

export function write_files(
	root: string,
	files: ReadonlyArray<{ path: string; text: string }>
): void {
	for (const f of files) {
		const p = join(root, ...safe_path(f.path).split('/'));
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, f.text);
	}
}

const NPM_FLAGS = ['--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'];

async function npm(root: string, args: string[]): Promise<void> {
	try {
		await run_process('npm', [...args, ...NPM_FLAGS], { cwd: root, timeout_ms: 10 * 60_000 });
	} catch (e) {
		const tail =
			e instanceof ProcessError
				? (e.stderr || e.stdout).trim().split('\n').slice(-3).join(' ')
				: '';
		throw new Error(`heisenbench: npm ${args[0]} ${one_line(e)}${tail ? `: ${tail}` : ''}`);
	}
}

export interface Lockfile {
	lockfileVersion?: number;
	packages?: Record<string, { version?: string; integrity?: string; resolved?: string }>;
	[k: string]: unknown;
}

/**
 * Install the package's tarball in `root`. Without `lockfile`, `npm install` resolves the
 * dependencies and the lockfile it writes is returned; with one, it is written back as it was,
 * the package's own entry set to this tarball's integrity and version (a changed tarball still
 * installs: verify-receipt says the integrity differs, then counts it), and `npm ci` installs
 * exactly it.
 */
export async function install(
	root: string,
	t: { bytes: Uint8Array; name: string; version: string; integrity: string },
	lockfile?: Lockfile
): Promise<Lockfile> {
	writeFileSync(join(root, TARBALL), t.bytes);
	writeFileSync(join(root, 'package.json'), project_json(t.name));
	if (lockfile === undefined) {
		await npm(root, ['install']);
		return JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as Lockfile;
	}
	const lock = structuredClone(lockfile);
	const own = lock.packages?.[`node_modules/${t.name}`];
	if (own) {
		own.integrity = t.integrity;
		own.version = t.version;
	}
	writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock, null, '\t') + '\n');
	await npm(root, ['ci']);
	return lock;
}

/** Every installed package of a lockfile but the package itself: name, version, integrity. */
export function locked_packages(
	lock: Lockfile,
	own: string
): Array<{ name: string; version: string; integrity: string | null }> {
	const out: Array<{ name: string; version: string; integrity: string | null }> = [];
	for (const [path, p] of Object.entries(lock.packages ?? {})) {
		if (!path.startsWith('node_modules/')) continue;
		const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
		if (path === `node_modules/${own}`) continue;
		out.push({ name, version: p.version ?? '', integrity: p.integrity ?? null });
	}
	return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
