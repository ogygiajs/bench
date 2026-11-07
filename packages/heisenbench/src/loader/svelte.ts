/*
 * Which output `.svelte` files compile to: `server` (the default: `render` from `svelte/server`)
 * or `client` (`mount`, `hydrate` and updates, on a DOM the bench brings). `--svelte client` sets it
 * for a whole command: the CLI passes it to the layers it runs and puts it in HEISENBENCH_SVELTE,
 * so every process the command starts (engine health, time, real bytes, blame's recounts) compiles
 * the same way.
 */

export type SvelteOutput = 'server' | 'client';

export const SVELTE_ENV = 'HEISENBENCH_SVELTE';

/** The output a loader compiles to: the one it was given, else this process's command's. */
export function svelte_output(given?: SvelteOutput): SvelteOutput {
	if (given) return given;
	return process.env[SVELTE_ENV] === 'client' ? 'client' : 'server';
}
