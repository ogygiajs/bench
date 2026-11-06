/**
 * Which bench files a PR runs: those whose import graph reaches a file the PR changed. A change to
 * what every run shares (the lockfile, the workspace, the bench harness in internal/abax) runs
 * them all. A main push or the nightly run runs them all too (`select_all`).
 */

/** Changed paths that run every bench file. */
const EVERYTHING = ['pnpm-lock.yaml', 'pnpm-workspace.yaml'];
const EVERYTHING_UNDER = ['internal/abax/'];

export interface Selection {
	/** `changed`: picked by the PR's changed files; `all`: every bench file. */
	mode: 'changed' | 'all';
	/** Why every bench file runs (null when picked by changes). */
	reason: string | null;
	/** Every bench file of the tree (relative paths). */
	all: string[];
	/** The bench files to run. */
	selected: string[];
	/** Selected bench file -> the changed files its graph reaches. */
	reach: Record<string, string[]>;
	/** Files the PR changed (empty for a full run). */
	changed: string[];
}

export function select_all(all: string[], reason: string): Selection {
	return { mode: 'all', reason, all, selected: [...all], reach: {}, changed: [] };
}

export function select_changed(graphs: Map<string, string[]>, changed: string[]): Selection {
	const all = [...graphs.keys()].sort();
	const shared = changed.find(
		(c) => EVERYTHING.includes(c) || EVERYTHING_UNDER.some((p) => c.startsWith(p))
	);
	if (shared !== undefined) return { ...select_all(all, `${shared} changed`), changed };
	const touched = new Set(changed);
	const reach: Record<string, string[]> = {};
	const selected: string[] = [];
	for (const bench of all) {
		const hits = (graphs.get(bench) ?? []).filter((f) => touched.has(f));
		if (hits.length > 0) {
			selected.push(bench);
			reach[bench] = hits;
		}
	}
	return { mode: 'changed', reason: null, all, selected, reach, changed };
}
