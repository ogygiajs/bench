// A PR run measures two ogygia builds side by side: the PR's (`ogygia`) and its base's
// (`ogygia-base`). The base app is a copy of the ogygia app next to it (`apps/ogygia` →
// `apps/ogygia-base`, `frameworks/ogygia` → `frameworks/ogygia-base`), the same source with only
// the installed ogygia changed. build-all.ts --base-spec builds the copies; benchmark.ts --ab
// measures both, interleaved, in the same job; compare.ts judges one against the other.

export const PR_ID = 'ogygia';
export const BASE_ID = 'ogygia-base';

/** The base copy's directory for an ogygia app directory. */
export const baseDir = (dir) => dir.replace(/(^|\/)ogygia(\/|$)/, `$1${BASE_ID}$2`);

/** The base twin of one ogygia config entry: same app, its own directory, LOC read from the source. */
function twin(entry) {
	const out = { ...entry, id: BASE_ID, source: entry.dir ?? `frameworks/${entry.id}` };
	if (entry.dir) out.dir = baseDir(entry.dir);
	if (entry.dist && !entry.dir) out.dist = baseDir(entry.dist);
	return out;
}

const withTwin = (list) => list.flatMap((e) => (e.id === PR_ID ? [e, twin(e)] : [e]));

/** The config with an `ogygia-base` entry after every `ogygia` one (the blog and each scenario). */
export function withBase(cfg) {
	const scenarios = Object.fromEntries(
		Object.entries(cfg.scenarios ?? {}).map(([name, s]) => [name, { ...s, apps: withTwin(s.apps ?? []) }])
	);
	return { ...cfg, frameworks: withTwin(cfg.frameworks ?? []), scenarios };
}

/** An A/B run measures the two ogygia builds and nothing else. */
export const inAb = (entry) => entry.id === PR_ID || entry.id === BASE_ID;
