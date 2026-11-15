import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'oxc-parser';

/*
 * A package's Heisenbench settings: `heisenbench.config.ts`, next to its package.json.
 *
 *   import { defineConfig } from 'heisenbench';
 *   export default defineConfig({ importMetaEnv: { SSR: true } });
 *
 * The file is read as data, never run: its default export (bare, through `defineConfig(...)`, or
 * with `satisfies` / `as`) must be an object literal of literals. So it needs nothing installed to
 * read (its `import` is never resolved), it reads the same in a sandboxed child, and a config can
 * not do work that changes what a run counts. A config that is not plain data fails out loud.
 *
 * The settings it holds:
 *   importMetaEnv   the `import.meta.env` the package's code reads, over the default (transform/env.ts)
 */

/** The file a package keeps its settings in, beside its package.json. */
export const CONFIG_FILE = 'heisenbench.config.ts';

export type EnvValue = string | number | boolean | null;
export type ImportMetaEnv = Readonly<Record<string, EnvValue>>;

/** What `heisenbench.config.ts` exports by default. */
export interface HeisenbenchConfig {
	/** Keys of `import.meta.env`, merged over the default (a production client build). */
	readonly importMetaEnv?: ImportMetaEnv;
}

const KEYS: ReadonlySet<string> = new Set(['importMetaEnv']);

/** Types a `heisenbench.config.ts` default export; hands back what it is given. */
export function define_config(config: HeisenbenchConfig): HeisenbenchConfig {
	return config;
}

/** `value` as an env (an object of strings, finite numbers, booleans and nulls), or an error. */
export function check_env(value: unknown, where: string): Record<string, EnvValue> {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		throw new Error(`heisenbench: ${where}: importMetaEnv must be an object`);
	const out: Record<string, EnvValue> = {};
	for (const [k, v] of Object.entries(value)) {
		const ok =
			v === null ||
			typeof v === 'string' ||
			typeof v === 'boolean' ||
			(typeof v === 'number' && Number.isFinite(v));
		if (!ok)
			throw new Error(
				`heisenbench: ${where}: importMetaEnv.${k} must be a string, number, boolean or null`
			);
		out[k] = v as EnvValue;
	}
	return out;
}

interface Node {
	type: string;
	[key: string]: unknown;
}

/** The config in `dir`'s `heisenbench.config.ts`, or null when it has none. */
export function read_config(dir: string): HeisenbenchConfig | null {
	const file = join(dir, CONFIG_FILE);
	// a sandboxed child (prove) may not read above its root: no file there is no config
	if (!existsSync(file)) return null;
	const parsed = parseSync(file, readFileSync(file, 'utf8'), { sourceType: 'module', lang: 'ts' });
	if (parsed.errors.length > 0)
		throw new Error(`heisenbench: ${file} does not parse: ${parsed.errors[0]!.message}`);
	const exported = (parsed.program.body as unknown as Node[]).find(
		(n) => n.type === 'ExportDefaultDeclaration'
	);
	if (exported === undefined) throw new Error(`heisenbench: ${file} must have a default export`);
	const value = data(unwrap(exported.declaration as Node), file);
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		throw new Error(`heisenbench: ${file}: the default export must be an object`);
	const config = value as Record<string, unknown>;
	for (const k of Object.keys(config))
		if (!KEYS.has(k))
			throw new Error(`heisenbench: ${file}: unknown key ${k} (known: ${[...KEYS].join(', ')})`);
	if (config.importMetaEnv === undefined) return {};
	return { importMetaEnv: check_env(config.importMetaEnv, file) };
}

/** `x` without the wrappers a typed default export has: `defineConfig(...)`, `satisfies`, `as`. */
function unwrap(n: Node): Node {
	if (
		n.type === 'TSSatisfiesExpression' ||
		n.type === 'TSAsExpression' ||
		n.type === 'ParenthesizedExpression'
	)
		return unwrap(n.expression as Node);
	if (n.type === 'CallExpression') {
		const callee = n.callee as Node & { name?: string };
		const args = n.arguments as Node[];
		if (callee.type === 'Identifier' && callee.name === 'defineConfig' && args.length === 1)
			return unwrap(args[0]!);
	}
	return n;
}

/** The value a literal expression writes, or an error naming what is not a literal. */
function data(n: Node, file: string): unknown {
	n = unwrap(n);
	const not_data = (): never => {
		throw new Error(
			`heisenbench: ${file}: the config is read as data, so it must be written as a literal (found ${n.type})`
		);
	};
	switch (n.type) {
		case 'Literal':
			if (n.regex !== undefined || n.bigint !== undefined) return not_data();
			return n.value;
		case 'UnaryExpression': {
			const arg = n.argument as Node;
			if (n.operator === '-' && arg.type === 'Literal' && typeof arg.value === 'number')
				return -arg.value;
			return not_data();
		}
		case 'TemplateLiteral': {
			const quasis = n.quasis as Array<{ value: { cooked: string | null } }>;
			if ((n.expressions as Node[]).length > 0 || quasis[0]!.value.cooked === null)
				return not_data();
			return quasis[0]!.value.cooked;
		}
		case 'ArrayExpression':
			return (n.elements as Array<Node | null>).map((e) =>
				e === null || e.type === 'SpreadElement' ? not_data() : data(e, file)
			);
		case 'ObjectExpression': {
			const out: Record<string, unknown> = {};
			for (const p of n.properties as Node[]) {
				if (p.type !== 'Property' || p.computed || p.kind !== 'init' || p.method) return not_data();
				const key = p.key as Node & { name?: string; value?: unknown };
				const name =
					key.type === 'Identifier'
						? key.name
						: key.type === 'Literal' && typeof key.value === 'string'
							? key.value
							: undefined;
				if (name === undefined) return not_data();
				out[name] = data(p.value as Node, file);
			}
			return out;
		}
		default:
			return not_data();
	}
}
