// Lines of code a developer wrote to build one app: non-blank, non-comment lines of the app's
// own tracked source and config files. One rule for every app of every scenario:
//
//   - counted: .svelte .ts .js .astro .html files the app tracks in git (its routes, pages,
//     components, server entry, HTML shell), split into `config` (vite / svelte / astro config
//     files and tsconfig.json) and `code` (everything else);
//   - added: the scenario's shared whole-page component, for an app that renders it rather than
//     writing the page's markup itself (see linesOfCode);
//   - left out: anything shared by the apps of a scenario (scenarios/<name>/shared, copied in by
//     scenarios/sync.ts and gitignored; the blog's shared Counter.svelte and post.css), generated
//     content (the blog's synthetic posts and the per-post files shared/sync.ts writes), lockfiles,
//     package.json (a dependency list), node_modules and build output;
//   - a comment line is one that is only a comment (`//`, `/* … */`, `<!-- … -->`).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = /\.(svelte|ts|js|astro|html)$/;
const CONFIG = /(^|\/)((vite|svelte|astro)\.config\.[jt]s|tsconfig\.json)$/;
// The blog's files that shared/sync.ts generates or copies into each app (tracked in git there).
const BLOG_GENERATED = [
	/(^|\/)Counter\.svelte$/,
	/(^|\/)src\/routes\/posts\/[^/]+\//,
	/(^|\/)src\/posts\//,
	/(^|\/)src\/pages\/posts\//,
	/(^|\/)(public|static)\//
];

// Without git (the Docker image has no .git): walk the app, skipping what .gitignore leaves out.
const UNTRACKED = new Set([
	'node_modules',
	'build',
	'dist',
	'.svelte-kit',
	'.astro',
	'.mochi',
	'public',
	'static'
]);
const UNTRACKED_PATHS = ['src/lib/shared', 'src/shared'];

function walk(root, dir, rel = '', out = []) {
	for (const e of readdirSync(join(root, dir, rel), { withFileTypes: true })) {
		const r = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) {
			if (!UNTRACKED.has(e.name) && !UNTRACKED_PATHS.includes(r)) walk(root, dir, r, out);
		} else if (e.isFile() && !e.name.startsWith('.')) out.push(`${dir}/${r}`);
	}
	return out;
}

function tracked(root, dir) {
	const r = spawnSync('git', ['-C', root, 'ls-files', '--', dir], { encoding: 'utf8' });
	if (r.status === 0 && r.stdout.trim()) return r.stdout.split('\n').filter(Boolean);
	return existsSync(join(root, dir)) ? walk(root, dir.replace(/\/$/, '')) : null;
}

/** Non-blank, non-comment lines of one file's text. */
export function countLines(text) {
	const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
	return stripped.split('\n').filter((line) => {
		const t = line.trim();
		return t && !t.startsWith('//');
	}).length;
}

/**
 * `{ locCode, locConfig, loc }` for the app in `dir` (relative to the repo root), or null.
 * `composition` lists the scenario's shared whole-page components (DocPage.svelte, ...): the apps that
 * hydrate the whole page render it instead of writing the page's markup themselves, as the
 * islands apps do, so an app that imports it is charged its lines too.
 */
export function linesOfCode(root, dir, composition = []) {
	const files = tracked(root, dir);
	if (!files?.length) return null;
	let code = 0;
	let config = 0;
	const sources = files
		.filter((f) => SOURCE.test(f))
		.map((f) => readFileSync(join(root, f), 'utf8'));
	for (const shared of composition) {
		// Imported from the app's copy of the shared dir: `…/shared/components/DocPage.svelte'`.
		const tail = shared.slice(shared.indexOf('/shared/'));
		if (sources.some((text) => text.includes(`${tail}'`)))
			code += countLines(readFileSync(join(root, shared), 'utf8'));
	}
	for (const file of files) {
		const rel = file.slice(dir.length).replace(/^\//, '');
		if (!SOURCE.test(file) && !CONFIG.test(file)) continue;
		if (BLOG_GENERATED.some((re) => re.test(rel))) continue;
		const n = countLines(readFileSync(join(root, file), 'utf8'));
		if (CONFIG.test(file)) config += n;
		else code += n;
	}
	return { locCode: code, locConfig: config, loc: code + config };
}
