// node --experimental-import-meta-resolve graph-cli.ts <root> <bench files...>
// Prints { "<bench file>": ["<file it reaches>", ...] } (paths relative to root) as JSON.
import { relative, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { resolve_flag_works, walk } from './graph.ts';

const [root_arg, ...files] = process.argv.slice(2);
if (!root_arg || files.length === 0) throw new Error('usage: graph-cli.ts <root> <bench files...>');
if (!resolve_flag_works()) throw new Error('graph-cli.ts needs --experimental-import-meta-resolve');

const root = realpathSync(resolve(root_arg));
const rel = (f: string): string => relative(root, f).split(sep).join('/');
const seen = new Map<string, string[]>();
const out: Record<string, string[]> = {};
for (const f of files) {
	out[rel(realpathSync(resolve(root, f)))] = [...walk(root, resolve(root, f), seen)]
		.map(rel)
		.sort();
}
process.stdout.write(JSON.stringify(out));
