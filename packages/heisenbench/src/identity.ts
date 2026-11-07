/*
 * What a function id is made of, for matching ids across two trees.
 *
 *   module > path            `packages/router/src/match.ts > match_one`
 *   dependency module        `acorn@8.15.0/dist/acorn.mjs`: package name, version, file in it
 *   path segment             a name (`match_one`), plus `~3fa9c2` (its shape hash) when the name is
 *                            a slot (`sort:0`) or taken, plus `#2` when the shape is taken too
 *
 * The hash and the version say which one; the rest says where. When a function's own code changes,
 * its hash does, and when a dependency is upgraded, its version does: the diff and the gate then
 * pair by the part that says where (`context_path`, `unversioned_module`).
 */

/** A path segment's shape hash and order suffixes: `sort:0~3fa9c2#2` -> `sort:0`. */
const SUFFIXES = /(?:~[0-9a-f]{6})?(?:#\d+)?(?= > |$)/g;

/** The path without shape hashes and order suffixes: where the function is, not which one. */
export function context_path(path: string): string {
	return path.replace(SUFFIXES, '');
}

/** `acorn@8.15.0/dist/acorn.mjs` -> name `acorn`, version `8.15.0`; own code -> null. */
const DEP_MODULE = /^((?:@[^/@]+\/)?[^/@]+)@([^/]+)(?:\/|$)/;

/** The package of a dependency module (`acorn@8.15.0`), or null for the project's own code. */
export function package_of(module: string): { name: string; version: string } | null {
	const m = DEP_MODULE.exec(module);
	return m ? { name: m[1], version: m[2] } : null;
}

/** `name@version` of a dependency module, or null for the project's own code. */
export function package_label(module: string): string | null {
	const p = package_of(module);
	return p ? `${p.name}@${p.version}` : null;
}

/** What the project's own code is called where steps are grouped by package. */
export const OWN_CODE = 'own code';

/**
 * `68% acorn@8.15.0, 30% own code`: each package's share of the self steps of `functions`, largest
 * first, shares under `min` left out. Empty when only the project's own code has steps.
 */
export function package_shares(
	functions: ReadonlyArray<{ module: string; self_steps: number }>,
	min = 0.01
): string {
	const by = new Map<string, number>();
	let total = 0;
	for (const f of functions) {
		const p = package_label(f.module) ?? OWN_CODE;
		by.set(p, (by.get(p) ?? 0) + f.self_steps);
		total += f.self_steps;
	}
	if (!(total > 0) || (by.size === 1 && by.has(OWN_CODE))) return '';
	return [...by]
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
		.filter(([, n]) => n / total >= min)
		.map(([p, n]) => `${Math.round((n / total) * 100)}% ${p}`)
		.join(', ');
}

/** A dependency module without its version (`acorn/dist/acorn.mjs`); own modules as they are. */
export function unversioned_module(module: string): string {
	const p = package_of(module);
	return p ? p.name + module.slice(p.name.length + 1 + p.version.length) : module;
}
