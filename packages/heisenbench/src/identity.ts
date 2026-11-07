/*
 * What a function id is made of, for matching ids across two trees.
 *
 *   module > path            `packages/router/src/match.ts > match_one`
 *   path segment             a name (`match_one`), plus `~3fa9c2` (its shape hash) when the name is
 *                            a slot (`sort:0`) or taken, plus `#2` when the shape is taken too
 *
 * The hash says which one; the rest says where. When a function's own code changes, its hash
 * does: the diff and the gate then pair by the part that says where (`context_path`).
 */

/** A path segment's shape hash and order suffixes: `sort:0~3fa9c2#2` -> `sort:0`. */
const SUFFIXES = /(?:~[0-9a-f]{6})?(?:#\d+)?(?= > |$)/g;

/** The path without shape hashes and order suffixes: where the function is, not which one. */
export function context_path(path: string): string {
	return path.replace(SUFFIXES, '');
}
