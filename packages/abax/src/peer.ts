import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PACKAGE_NAME } from './own.ts';

/*
 * The optional peer dependencies: typescript (compiling what type stripping cannot run, and
 * `abax dts`), svelte (.svelte files) and playwright (the app layer's browser). Each is the
 * project's own when it has one: resolved from the file it is for, then from the working
 * directory, then from Abax itself. Missing, it is one error that says what to install.
 */

/** `svelte/compiler` -> `svelte`, `@scope/pkg/sub` -> `@scope/pkg`. */
function package_of(specifier: string): string {
	const parts = specifier.split('/');
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** The resolved file of a peer, or an error naming what needs it (`need`) and how to install it. */
export function resolve_peer(specifier: string, need: string, from?: string): string {
	const froms = [from, join(process.cwd(), 'package.json'), import.meta.url];
	for (const f of froms) {
		if (f === undefined) continue;
		try {
			return createRequire(f).resolve(specifier);
		} catch {
			// next
		}
	}
	const name = package_of(specifier);
	// TypeScript 7 has no JavaScript API (see require_typescript).
	const install = name === 'typescript' ? 'typescript@6' : name;
	throw new Error(
		`abax: ${need} needs ${name}, an optional peer dependency of ${PACKAGE_NAME}. Install it in the project: npm i -D ${install}`
	);
}

const loaded = new Map<string, unknown>();

/** A peer's module (CommonJS entry), loaded once per resolved file. */
export function require_peer<T>(specifier: string, need: string, from?: string): T {
	const path = resolve_peer(specifier, need, from);
	let m = loaded.get(path);
	if (m === undefined) {
		m = createRequire(import.meta.url)(path);
		loaded.set(path, m);
	}
	return m as T;
}

/**
 * TypeScript's compiler API (`transpileModule`, the checker). TypeScript 7 is the native compiler
 * and has no JavaScript API, so it is refused with what to install instead.
 */
export function require_typescript<T>(need: string, from?: string): T {
	const ts = require_peer<{ version?: string; transpileModule?: unknown }>(
		'typescript',
		need,
		from
	);
	if (typeof ts.transpileModule !== 'function') {
		throw new Error(
			`abax: ${need} needs TypeScript's compiler API, which typescript ${ts.version ?? '7+'} does not have. Install typescript 5 or 6 in the project: npm i -D typescript@6`
		);
	}
	return ts as T;
}
