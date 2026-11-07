import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/*
 * Where Heisenbench's own files are. In the bench repo Heisenbench runs from its TypeScript source (src/*.ts);
 * installed from npm it runs from built JavaScript (dist/*.js), because Node does not strip types
 * from files inside node_modules. dist/ mirrors src/ file for file, so a module is named once,
 * without its extension, and resolves in both layouts.
 *
 * Every file Heisenbench hands to another process or a loader by path (a child script, the counting
 * runtime, a loader, a Vite plugin) and every data file it reads comes from here.
 */

const HERE = import.meta.url;
/** `.ts` from source, `.js` from the build. */
const EXT = HERE.slice(HERE.lastIndexOf('.'));

/** src/ or dist/: Heisenbench's own modules (never counted). Ends with a separator. */
export const OWN_DIR = fileURLToPath(new URL('./', HERE));

/** The package directory: package.json, prices.json, weights.json. Ends with a separator. */
export const PACKAGE_DIR = fileURLToPath(new URL('../', HERE));

/** One of Heisenbench's modules, by its path under src/ without the extension (`runtime/index`). */
export function own_url(module: string): URL {
	return new URL(`./${module}${EXT}`, HERE);
}

/** {@link own_url} as a file path. */
export function own_file(module: string): string {
	return fileURLToPath(own_url(module));
}

/** A file at the package root (`weights.json`, `calibration/`), by its relative path. */
export function package_url(path: string): URL {
	return new URL(`../${path}`, HERE);
}

/** {@link package_url} as a file path. */
export function package_file(path: string): string {
	return fileURLToPath(package_url(path));
}

/** The name Heisenbench is installed under (package.json `name`). */
export const PACKAGE_NAME = (
	JSON.parse(readFileSync(package_url('package.json'), 'utf8')) as { name: string }
).name;

/**
 * Commands that read files only a clone of the bench repo has (`heisenbench verify`'s planted cases, the
 * calibration corpus). From npm they stop with this error instead of a missing-file stack.
 */
export function needs_bench_repo(path: string): void {
	if (existsSync(package_file(path))) return;
	throw new Error(
		`heisenbench: this command runs only in a clone of github.com/ogygiajs/bench (packages/heisenbench); the npm package does not ship ${path}`
	);
}
