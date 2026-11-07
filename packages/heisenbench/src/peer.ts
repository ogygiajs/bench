import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PACKAGE_NAME } from './own.ts';

/*
 * The optional peer dependencies: typescript (compiling what type stripping cannot run, and
 * `heisenbench dts`), svelte (.svelte files) and playwright (the app layer's browser). Each is the
 * project's own when it has one: resolved from the file it is for, then from the working
 * directory, then from Heisenbench itself. Missing, it is one error that says what to install.
 */

/** `svelte/compiler` -> `svelte`, `@scope/pkg/sub` -> `@scope/pkg`. */
function package_of(specifier: string): string {
	const parts = specifier.split('/');
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Every copy of a peer that resolves, in the order they are tried, each file once. */
function peer_files(specifier: string, from?: string): string[] {
	const froms = [from, join(process.cwd(), 'package.json'), import.meta.url];
	const files: string[] = [];
	for (const f of froms) {
		if (f === undefined) continue;
		try {
			const file = createRequire(f).resolve(specifier);
			if (!files.includes(file)) files.push(file);
		} catch {
			// next
		}
	}
	return files;
}

/** The error for a peer that no candidate resolves: what needs it (`need`) and how to install it. */
function missing(specifier: string, need: string): Error {
	const name = package_of(specifier);
	// TypeScript 7 has no JavaScript API (see require_typescript).
	const install = name === 'typescript' ? 'typescript@6' : name;
	return new Error(
		`heisenbench: ${need} needs ${name}, an optional peer dependency of ${PACKAGE_NAME}. Install it in the project: npm i -D ${install}`
	);
}

/** The resolved file of a peer, or an error naming what needs it (`need`) and how to install it. */
export function resolve_peer(specifier: string, need: string, from?: string): string {
	const file = peer_files(specifier, from)[0];
	if (file === undefined) throw missing(specifier, need);
	return file;
}

const loaded = new Map<string, unknown>();

/** A peer's module (CommonJS entry), loaded once per resolved file. */
function load<T>(path: string): T {
	let m = loaded.get(path);
	if (m === undefined) {
		m = createRequire(import.meta.url)(path);
		loaded.set(path, m);
	}
	return m as T;
}

/** A peer's module (CommonJS entry): the first copy that resolves. */
export function require_peer<T>(specifier: string, need: string, from?: string): T {
	return load<T>(resolve_peer(specifier, need, from));
}

/**
 * TypeScript's compiler API (`transpileModule`, the checker): the first copy that has it.
 * TypeScript 7 is the native compiler and has no JavaScript API, so a project on 7 is passed over
 * for the next copy (Heisenbench's own); with no copy that has the API, the error says what to
 * install.
 */
export function require_typescript<T>(need: string, from?: string): T {
	let refused: string | undefined;
	for (const file of peer_files('typescript', from)) {
		const ts = load<{ version?: string; transpileModule?: unknown }>(file);
		if (typeof ts.transpileModule === 'function') return ts as T;
		refused ??= ts.version ?? '7+';
	}
	if (refused === undefined) throw missing('typescript', need);
	throw new Error(
		`heisenbench: ${need} needs TypeScript's compiler API, which typescript ${refused} does not have. Install typescript 5 or 6 in the project: npm i -D typescript@6`
	);
}
