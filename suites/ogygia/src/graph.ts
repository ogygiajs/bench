/**
 * The static import graph of a bench file: every file of the ogygia checkout it can load.
 *
 * A PR runs only the bench files whose graph reaches a file the PR changed (spec: "only functions
 * whose module or imports changed"). The graph follows `import`, `export ... from`, type-free
 * `import x` and string-literal `import()` through Node's own resolver (`import.meta.resolve` with
 * a parent, so package `exports`/`imports`, conditions and workspace links resolve exactly as the
 * bench run will), into .svelte files (their `<script>` blocks), and stops at node_modules.
 * Type-only imports are skipped: they load nothing.
 *
 * `import.meta.resolve(specifier, parent)` needs `--experimental-import-meta-resolve`, so the
 * walk runs in its own process (graph-cli.ts); `import_graphs` spawns it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSync } from 'oxc-parser';

const RESOLVE_FLAG = '--experimental-import-meta-resolve';
const GRAPH_CLI = fileURLToPath(new URL('./graph-cli.ts', import.meta.url));
const PARSED = new Set(['.ts', '.mts', '.js', '.mjs', '.svelte']);

interface ScriptBlock {
	content: { start: number; end: number };
}

interface SvelteAst {
	instance: ScriptBlock | null;
	module: ScriptBlock | null;
}

interface SvelteCompiler {
	parse(source: string, options: { modern: true; filename?: string }): SvelteAst;
}

/** The `<script>` blocks of a component, as one script (each block on its own lines). */
function svelte_scripts(file: string, source: string): string {
	// The tree's own Svelte parses its own components.
	const svelte = createRequire(file)('svelte/compiler') as SvelteCompiler;
	const ast = svelte.parse(source, { modern: true, filename: file });
	const parts: string[] = [];
	for (const block of [ast.module, ast.instance]) {
		if (block) parts.push(source.slice(block.content.start, block.content.end));
	}
	return parts.join('\n;\n');
}

/** String value of a literal import() argument, or null for a computed one. */
function literal(text: string): string | null {
	const t = text.trim();
	if (t.length < 2) return null;
	const q = t[0];
	if ((q !== '"' && q !== "'" && q !== '`') || t[t.length - 1] !== q) return null;
	const inner = t.slice(1, -1);
	if (q === '`' && inner.includes('${')) return null;
	if (inner.includes('\\')) return null;
	return inner;
}

/** The specifiers a module loads (static imports and exports, literal dynamic imports). */
export function specifiers_of(file: string, source: string): string[] {
	const code = file.endsWith('.svelte') ? svelte_scripts(file, source) : source;
	const lang_file = file.endsWith('.svelte') ? file + '.ts' : file;
	const { module } = parseSync(lang_file, code, { sourceType: 'module' });
	const out: string[] = [];
	for (const s of module.staticImports) {
		if (s.entries.length > 0 && s.entries.every((e) => e.isType)) continue;
		out.push(s.moduleRequest.value);
	}
	for (const s of module.staticExports) {
		for (const e of s.entries) {
			if (e.moduleRequest && !e.isType) out.push(e.moduleRequest.value);
		}
	}
	for (const d of module.dynamicImports) {
		const v = literal(code.slice(d.moduleRequest.start, d.moduleRequest.end));
		if (v !== null) out.push(v);
	}
	return [...new Set(out)];
}

function inside(root: string, file: string): boolean {
	return file.startsWith(root + sep) && !file.includes(`${sep}node_modules${sep}`);
}

/**
 * Every file of `root` the module `entry` reaches (itself included), as absolute paths. Needs
 * `--experimental-import-meta-resolve` (graph-cli.ts runs with it).
 */
export function walk(root: string, entry: string, seen = new Map<string, string[]>()): Set<string> {
	const real_root = realpathSync(root);
	const out = new Set<string>();
	const stack = [realpathSync(entry)];
	while (stack.length > 0) {
		const file = stack.pop()!;
		if (out.has(file)) continue;
		out.add(file);
		let deps = seen.get(file);
		if (deps === undefined) {
			deps = [];
			const ext = file.endsWith('.svelte.ts') ? '.ts' : extname(file);
			if (PARSED.has(ext)) {
				const parent = pathToFileURL(file).href;
				for (const spec of specifiers_of(file, readFileSync(file, 'utf8'))) {
					let url: string;
					try {
						url = import.meta.resolve(spec, parent);
					} catch {
						// virtual modules, Kit's $app/*, optional peers: nothing in the tree to follow
						continue;
					}
					if (!url.startsWith('file:')) continue;
					let target: string;
					try {
						target = realpathSync(fileURLToPath(url));
					} catch {
						continue;
					}
					if (inside(real_root, target)) deps.push(target);
				}
			}
			seen.set(file, deps);
		}
		for (const d of deps) if (!out.has(d)) stack.push(d);
	}
	return out;
}

export function resolve_flag_works(): boolean {
	try {
		return import.meta.resolve('./x.ts', 'file:///a/b/c.ts') === 'file:///a/b/x.ts';
	} catch {
		return false;
	}
}

/**
 * The import graph of each bench file under `root`: bench file (relative to root) -> every file it
 * reaches (relative to root, sorted).
 */
export function import_graphs(root: string, files: string[]): Map<string, string[]> {
	if (files.length === 0) return new Map();
	const out = execFileSync(process.execPath, [RESOLVE_FLAG, GRAPH_CLI, root, ...files], {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 1 << 28
	});
	const parsed = JSON.parse(out) as Record<string, string[]>;
	return new Map(Object.entries(parsed));
}
