import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import MagicString from 'magic-string';
import { parseSync } from 'oxc-parser';
import remapping from '@jridgewell/remapping';
import type { SourceMapInput } from '@jridgewell/trace-mapping';

/*
 * `import.meta.env`, the way Vite gives it to code it builds. Vite replaces it statically (its
 * define): `import.meta.env.DEV` becomes `false`, and `if (import.meta.env.DEV) {...}` is dead code
 * the minifier removes from the shipped bundle. Node has no `import.meta.env`, so the same line
 * throws in a bench. Every build Heisenbench loads code with (counted, plain, the engine's,
 * the recorder's) rewrites it the same way, before anything else sees the code:
 *
 *   import.meta.env.DEV       the value as a literal (`false`), or `undefined` for a key the env
 *                             does not have (Vite's `import.meta.env.*`); a literal costs nothing
 *   import.meta.env           anywhere else (`const { DEV } = import.meta.env`, a computed key,
 *                             an assignment target): the whole env as an object literal, as Vite 8
 *                             writes it
 *
 * A literal shorter than what it replaces is padded with spaces, so no line or column moves; a
 * longer one (the object, a long string) comes with a source map, chained to the one the code
 * already had. Code without `import.meta.env` comes back as it was, byte for byte.
 *
 * Dependencies are rewritten too: a production build (`vite build`) defines every module it
 * bundles, node_modules included. Heisenbench's own files never read it.
 *
 * The env models a production client build. A project changes it in its package.json, merged
 * over the default (the nearest package.json above the file that sets it):
 *
 *   "heisenbench": { "importMetaEnv": { "SSR": true, "VITE_API": "/api" } }
 */

/** The package.json field (under `heisenbench`) a project sets its env with. */
export const ENV_KEY = 'importMetaEnv';

export type EnvValue = string | number | boolean | null;
export type ImportMetaEnv = Readonly<Record<string, EnvValue>>;

/** `vite build` for the browser. */
export const DEFAULT_ENV: ImportMetaEnv = Object.freeze({
	BASE_URL: '/',
	DEV: false,
	MODE: 'production',
	PROD: true,
	SSR: false
});

/** `value` as an env (an object of strings, finite numbers, booleans and nulls), or an error. */
export function check_env(value: unknown, where: string): Record<string, EnvValue> {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		throw new Error(`heisenbench: ${where}: heisenbench.${ENV_KEY} must be an object`);
	const out: Record<string, EnvValue> = {};
	for (const [k, v] of Object.entries(value)) {
		const ok =
			v === null ||
			typeof v === 'string' ||
			typeof v === 'boolean' ||
			(typeof v === 'number' && Number.isFinite(v));
		if (!ok)
			throw new Error(
				`heisenbench: ${where}: heisenbench.${ENV_KEY}.${k} must be a string, number, boolean or null`
			);
		out[k] = v as EnvValue;
	}
	return out;
}

/** The env each directory's code sees (from the nearest package.json that sets one). */
const env_of_dir = new Map<string, ImportMetaEnv>();

/** The env a file's `import.meta.env` reads. */
export function env_for(filename: string): ImportMetaEnv {
	const walked: string[] = [];
	let dir = dirname(filename);
	let found: ImportMetaEnv | undefined;
	while (found === undefined) {
		const known = env_of_dir.get(dir);
		if (known !== undefined) {
			found = known;
			break;
		}
		walked.push(dir);
		const set = project_env(join(dir, 'package.json'));
		if (set !== null) found = Object.freeze({ ...DEFAULT_ENV, ...set });
		else if (dirname(dir) === dir) found = DEFAULT_ENV;
		else dir = dirname(dir);
	}
	for (const d of walked) env_of_dir.set(d, found);
	return found;
}

/** What a package.json sets under `heisenbench.importMetaEnv`, or null. */
function project_env(file: string): Record<string, EnvValue> | null {
	let pkg: unknown;
	try {
		// a sandboxed child (prove) may not read above its root: no file there is no config
		if (!existsSync(file)) return null;
		pkg = JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
	const hb = (pkg as { heisenbench?: unknown } | null)?.heisenbench;
	if (hb === null || typeof hb !== 'object' || !(ENV_KEY in hb)) return null;
	return check_env((hb as Record<string, unknown>)[ENV_KEY], file);
}

interface Node {
	type: string;
	start: number;
	end: number;
	[key: string]: unknown;
}

const MAY_READ = /import\.meta\??\.env/;

/** `import.meta.env` (or `import.meta?.env`). */
function is_env(n: Node): boolean {
	if (n.type !== 'MemberExpression' || n.computed) return false;
	const o = n.object as Node;
	const p = n.property as Node;
	return (
		o.type === 'MetaProperty' &&
		(o.meta as Node & { name: string }).name === 'import' &&
		(o.property as Node & { name: string }).name === 'meta' &&
		(p as Node & { name?: string }).name === 'env'
	);
}

/** The key `parent` reads off `env` (`.DEV`, `['DEV']`), or null. */
function key_read(parent: Node | null, env: Node): string | null {
	if (parent === null || parent.type !== 'MemberExpression' || parent.object !== env) return null;
	const p = parent.property as Node & { name?: string; value?: unknown };
	if (!parent.computed) return p.type === 'Identifier' ? (p.name ?? null) : null;
	return p.type === 'Literal' && typeof p.value === 'string' ? p.value : null;
}

/** Whether `n[key]` is written, not read: an assignment, `++`, `delete`, a destructuring target. */
function writes(n: Node, key: string, written: boolean): boolean {
	switch (n.type) {
		case 'AssignmentExpression':
		case 'ForInStatement':
		case 'ForOfStatement':
		case 'AssignmentPattern':
			return key === 'left';
		case 'UpdateExpression':
		case 'RestElement':
			return key === 'argument';
		case 'UnaryExpression':
			return key === 'argument' && n.operator === 'delete';
		case 'ArrayPattern':
			return key === 'elements';
		case 'ObjectPattern':
			return key === 'properties';
		case 'Property':
			// a property of an object pattern: its value is the target
			return written && key === 'value';
		default:
			return false;
	}
}

function literal(v: EnvValue | undefined): string {
	if (v === undefined) return 'undefined';
	return typeof v === 'number' ? `(${JSON.stringify(v)})` : JSON.stringify(v);
}

function object_literal(env: ImportMetaEnv): string {
	const keys = Object.keys(env).sort();
	return `({${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(env[k])}`).join(',')}})`;
}

/**
 * JavaScript `code` (TypeScript already stripped or compiled, Svelte already compiled) with
 * `import.meta.env` replaced by `env`, and the map from it back to the source: `map` (the map
 * `code` already has, or null) chained with the rewrite's own when a replacement changed a length.
 * Unchanged, the same `code` and `map` come back.
 */
export function define_env(
	code: string,
	filename: string,
	map: SourceMapInput | null = null,
	env: ImportMetaEnv = env_for(filename)
): { code: string; map: SourceMapInput | null } {
	if (!MAY_READ.test(code)) return { code, map };
	const parsed = parseSync(filename, code, { sourceType: 'module', lang: 'js' });
	if (parsed.errors.length > 0) return { code, map };
	const edits: Array<[number, number, string]> = [];
	// `parent_written`: the parent is itself a write target (`import.meta.env.X = 1`)
	const walk = (
		v: unknown,
		parent: Node | null,
		parent_written: boolean,
		written: boolean
	): void => {
		if (Array.isArray(v)) {
			for (const x of v) walk(x, parent, parent_written, written);
			return;
		}
		if (v === null || typeof v !== 'object') return;
		const n = v as Node;
		if (is_env(n)) {
			// `import.meta.env = x` is the code's own business
			if (written) return;
			const key = key_read(parent, n);
			if (key !== null && !parent_written)
				edits.push([parent!.start, parent!.end, literal(env[key])]);
			else edits.push([n.start, n.end, object_literal(env)]);
			return;
		}
		for (const k in n) {
			if (k === 'parent') continue;
			const child = n[k];
			if (child !== null && typeof child === 'object')
				walk(child, n, written, writes(n, k, written));
		}
	};
	walk(parsed.program, null, false, false);
	if (edits.length === 0) return { code, map };
	const s = new MagicString(code);
	let moved = false;
	for (const [a, b, text] of edits) {
		const was = code.slice(a, b);
		if (text.length <= was.length && !was.includes('\n')) {
			s.overwrite(a, b, text + ' '.repeat(was.length - text.length));
		} else {
			s.overwrite(a, b, text + '\n'.repeat(was.split('\n').length - 1));
			moved = true;
		}
	}
	const out = s.toString();
	if (!moved) return { code: out, map };
	const own = JSON.parse(
		s.generateMap({ hires: true, source: filename, includeContent: false }).toString()
	) as SourceMapInput;
	if (map === null) return { code: out, map: own };
	const chained = remapping([own, map] as Parameters<typeof remapping>[0], () => null);
	return { code: out, map: chained as unknown as SourceMapInput };
}
