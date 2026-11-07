/**
 * Which bench files a PR runs: those whose import graph reaches a file the PR changed. A change to
 * what every run shares (the lockfile, the workspace, the root package.json and tsconfig, the bench
 * harness in internal/heisenbench) runs them all. A main push or the nightly run runs them all too
 * (`select_all`).
 *
 * A manifest (`package.json`, `tsconfig*.json`) is in no import graph, yet it decides how the
 * files under its directory resolve: a PR that only re-points `#lib/x` in a package's `imports`
 * map, or an `exports` entry, changes what the bench files load. A changed manifest reaches every
 * bench file whose graph has a file under the manifest's directory (for a package's own
 * package.json: its own bench files and every bench file that imports the package).
 */

/** Changed paths that run every bench file. */
const EVERYTHING = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc'];
const EVERYTHING_UNDER = ['internal/heisenbench/'];
/** A tsconfig at the root. */
const ROOT_TSCONFIG = /^tsconfig[^/]*\.json$/;
/** A manifest anywhere: the directory before it is its scope. */
const MANIFEST = /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json)$/;

export interface Selection {
	/** `changed`: picked by the PR's changed files; `all`: every bench file. */
	mode: 'changed' | 'all';
	/** Why every bench file runs (null when picked by changes). */
	reason: string | null;
	/** Every bench file of the tree (relative paths). */
	all: string[];
	/** The bench files to run. */
	selected: string[];
	/** Selected bench file -> the changed files its graph reaches (manifests by their directory). */
	reach: Record<string, string[]>;
	/** Files the PR changed (empty for a full run). */
	changed: string[];
}

export function select_all(all: string[], reason: string): Selection {
	return { mode: 'all', reason, all, selected: [...all], reach: {}, changed: [] };
}

/** A changed path that every bench file depends on. */
export function is_shared(path: string): boolean {
	return (
		EVERYTHING.includes(path) ||
		ROOT_TSCONFIG.test(path) ||
		EVERYTHING_UNDER.some((p) => path.startsWith(p))
	);
}

/** The directory (with its trailing `/`) whose files a manifest governs, or null for any other file. */
export function manifest_scope(path: string): string | null {
	if (!MANIFEST.test(path)) return null;
	return path.slice(0, path.lastIndexOf('/') + 1);
}

export function select_changed(graphs: Map<string, string[]>, changed: string[]): Selection {
	const all = [...graphs.keys()].sort();
	const shared = changed.find(is_shared);
	if (shared !== undefined) return { ...select_all(all, `${shared} changed`), changed };
	const touched = new Set(changed);
	const manifests = changed
		.map((path) => ({ path, scope: manifest_scope(path) }))
		.filter((m): m is { path: string; scope: string } => m.scope !== null);
	const reach: Record<string, string[]> = {};
	const selected: string[] = [];
	for (const bench of all) {
		const graph = graphs.get(bench) ?? [];
		const hits = graph.filter((f) => touched.has(f));
		for (const m of manifests) {
			if (graph.some((f) => f.startsWith(m.scope))) hits.push(m.path);
		}
		if (hits.length > 0) {
			selected.push(bench);
			reach[bench] = hits;
		}
	}
	return { mode: 'changed', reason: null, all, selected, reach, changed };
}
