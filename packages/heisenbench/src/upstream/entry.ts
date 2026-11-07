import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

/*
 * How a stranger imports a function of a package: the public specifier (`svelte/compiler`) whose
 * file is the function's module, or re-exports from it. Read off the package's `exports` (or
 * `main`/`module` when it has none), the conditions Node takes for an import first.
 */

const CONDITIONS = ['node', 'import', 'module', 'default', 'require'];

type Exports = string | null | Exports[] | { [k: string]: Exports };

/** The file a target resolves to under Node's import conditions, or null. */
function target_of(t: Exports): string | null {
	if (t === null) return null;
	if (typeof t === 'string') return t;
	if (Array.isArray(t)) {
		for (const x of t) {
			const got = target_of(x);
			if (got) return got;
		}
		return null;
	}
	for (const c of CONDITIONS)
		if (c in t) {
			const got = target_of(t[c]);
			if (got) return got;
		}
	return null;
}

/** Subpath (`.`, `./compiler`) -> file in the package (`src/compiler/index.js`). */
export function export_map(pkg_dir: string): Map<string, string> {
	const out = new Map<string, string>();
	let pkg: { exports?: Exports; main?: string; module?: string };
	try {
		pkg = JSON.parse(readFileSync(join(pkg_dir, 'package.json'), 'utf8')) as typeof pkg;
	} catch {
		return out;
	}
	const clean = (p: string) => normalize(p).split('\\').join('/').replace(/^\.\//, '');
	const ex = pkg.exports;
	if (ex === undefined) {
		const main = pkg.module ?? pkg.main ?? 'index.js';
		out.set('.', clean(main));
		return out;
	}
	const subpaths =
		typeof ex === 'object' &&
		ex !== null &&
		!Array.isArray(ex) &&
		Object.keys(ex).some((k) => k.startsWith('.'))
			? (ex as Record<string, Exports>)
			: { '.': ex };
	for (const [sub, t] of Object.entries(subpaths)) {
		if (sub.includes('*')) continue;
		const file = target_of(t);
		if (file && !file.endsWith('.json') && !file.endsWith('.d.ts')) out.set(sub, clean(file));
	}
	return out;
}

/**
 * Files a module re-exports `name` from, relative to the package: `export * from './x.js'`, or an
 * `export { ... } from` clause that names it.
 */
function re_exports(pkg_dir: string, file: string, name: string): string[] {
	let src: string;
	try {
		src = readFileSync(join(pkg_dir, file), 'utf8');
	} catch {
		return [];
	}
	const named = new RegExp(`\\b${name}\\b`);
	const out: string[] = [];
	for (const m of src.matchAll(
		/export\s+(\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\s*['"](\.[^'"]+)['"]/g
	)) {
		if (m[1] !== '*' && !named.test(m[1])) continue;
		const p = normalize(join(dirname(file), m[2]))
			.split('\\')
			.join('/');
		out.push(p);
		if (!p.endsWith('.js') && existsSync(join(pkg_dir, p + '.js'))) out.push(p + '.js');
	}
	return out;
}

/**
 * The specifier that imports `name` from `module` (a file of the package, `src/compiler/index.js`):
 * the subpath whose file is that module, then one whose file re-exports it (two levels deep), or
 * null when the package does not export it.
 */
export function import_specifier(
	pkg_dir: string,
	pkg_name: string,
	module: string,
	name: string
): string | null {
	const map = export_map(pkg_dir);
	const spec = (sub: string) =>
		sub === '.' ? pkg_name : `${pkg_name}/${sub.replace(/^\.\//, '')}`;
	const subs = [...map].sort((a, b) => a[0].length - b[0].length || (a[0] < b[0] ? -1 : 1));
	for (const [sub, file] of subs) if (file === module) return spec(sub);
	for (const [sub, file] of subs) {
		const one = re_exports(pkg_dir, file, name);
		if (one.includes(module)) return spec(sub);
		for (const f of one) if (re_exports(pkg_dir, f, name).includes(module)) return spec(sub);
	}
	return null;
}
