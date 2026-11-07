import {
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { TreeFiles } from './hunks.ts';

/*
 * Scratch trees: a copy of the run root that candidate trees are written into, so the user's
 * checkout is never touched.
 *
 * The project's own files are copied (a copy-on-write clone where the file system has one). The
 * installed dependencies are not: in each `node_modules`, a link stays a link (pnpm's links to
 * workspace packages are relative, so they reach the scratch copy's packages, not the original's),
 * a scope directory (`@scope/`) is walked the same way, and anything else (pnpm's `.pnpm` store,
 * `.bin`, a package npm installed) links to the original. Dependencies are the same in every
 * candidate, so they load from where they are; the project's files load from the copy, where the
 * candidate's content is.
 *
 * A link whose target is outside the root is made absolute; one inside it keeps pointing inside
 * the copy.
 */

function inside(root: string, p: string): boolean {
	return p === root || p.startsWith(root + sep);
}

function copy_link(src_root: string, dst_root: string, s: string, d: string): void {
	const target = readlinkSync(s);
	const abs = isAbsolute(target) ? target : resolve(dirname(s), target);
	if (inside(src_root, abs)) {
		// inside the tree: the same place in the copy
		symlinkSync(relative(dirname(d), join(dst_root, relative(src_root, abs))) || '.', d);
	} else {
		symlinkSync(abs, d);
	}
}

function mirror_modules(src_root: string, dst_root: string, s: string, d: string): void {
	mkdirSync(d, { recursive: true });
	for (const e of readdirSync(s, { withFileTypes: true })) {
		const from = join(s, e.name);
		const to = join(d, e.name);
		if (e.isSymbolicLink()) copy_link(src_root, dst_root, from, to);
		else if (e.isDirectory() && e.name.startsWith('@'))
			mirror_modules(src_root, dst_root, from, to);
		else symlinkSync(from, to);
	}
}

function mirror_dir(
	src_root: string,
	dst_root: string,
	s: string,
	d: string,
	modules_root: string
): void {
	mkdirSync(d, { recursive: true });
	for (const e of readdirSync(s, { withFileTypes: true })) {
		if (e.name === '.git') continue;
		const from = join(s, e.name);
		const to = join(d, e.name);
		if (e.name === 'node_modules' && modules_root !== src_root) {
			// another install's dependencies, at the same place in that tree
			const other = join(modules_root, relative(src_root, from));
			if (existsSync(other)) mirror_modules(modules_root, dst_root, other, to);
		} else if (e.isSymbolicLink()) copy_link(src_root, dst_root, from, to);
		else if (e.isDirectory()) {
			if (e.name === 'node_modules') mirror_modules(src_root, dst_root, from, to);
			else mirror_dir(src_root, dst_root, from, to, modules_root);
		} else if (e.isFile()) copyFileSync(from, to, constants.COPYFILE_FICLONE);
	}
}

/**
 * A scratch copy of `root` at `dst` (which must not exist yet). With `modules_from` (another
 * checkout of the same project, installed), every `node_modules` comes from that checkout instead:
 * the project's files of `root` with the dependencies of the other install. Links into the other
 * checkout (pnpm's links to workspace packages) reach the copy's packages, so the project's code
 * is `root`'s wherever it is loaded from.
 */
export function mirror_tree(root: string, dst: string, o: { modules_from?: string } = {}): void {
	const src = resolve(root);
	const out = resolve(dst);
	const modules = o.modules_from === undefined ? src : resolve(o.modules_from);
	if (inside(src, out) || inside(modules, out))
		throw new Error('heisenbench: the scratch tree cannot be inside the root');
	mirror_dir(src, out, src, out, modules);
}

/**
 * Write a candidate tree's files into a scratch copy: each path (relative to the repository,
 * `prefix` being the root's place in it) gets its content, or is removed.
 */
export function write_tree(dst: string, files: TreeFiles, prefix = ''): void {
	const lead = prefix ? prefix.replace(/\/$/, '') + '/' : '';
	for (const [path, bytes] of files) {
		if (!path.startsWith(lead)) continue;
		const p = join(dst, ...path.slice(lead.length).split('/'));
		// Unlink first: a link copied into the scratch tree may point outside it, and writing
		// through it would change the original.
		rmSync(p, { force: true });
		if (bytes === null) continue;
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, bytes);
	}
}

/** Remove a scratch copy. Links are removed, never followed: the original stays as it is. */
export function remove_tree(dst: string): void {
	rmSync(dst, { recursive: true, force: true });
}
