import { own_file } from '../own.ts';

/*
 * How `--conditions` reaches the processes Heisenbench starts, without the code under test seeing
 * it. The conditions travel in HEISENBENCH_CONDITIONS; the loader that applies them
 * (loader/conditions.ts) is put first in a child's NODE_OPTIONS by `with_conditions`, and takes
 * itself out of that process's NODE_OPTIONS as it loads. Code that reads NODE_OPTIONS (a package
 * checking `NODE_OPTIONS?.includes(...)`) then reads what the user set, whatever path Heisenbench
 * is installed at. No side effects here: any process may import this.
 */

export const CONDITIONS_ENV = 'HEISENBENCH_CONDITIONS';

/** `svelte, browser` -> ['svelte', 'browser']. */
export function parse_conditions(list: string | undefined): string[] {
	if (list === undefined) return [];
	return [
		...new Set(
			list
				.split(',')
				.map((c) => c.trim())
				.filter(Boolean)
		)
	];
}

/** The loader as a Node flag. */
export function conditions_flag(): string {
	return `--import=${own_file('loader/conditions')}`;
}

/** NODE_OPTIONS without the loader: what the user set. */
export function without_loader(options: string): string {
	const flag = conditions_flag();
	return options
		.split(/\s+/)
		.filter((part) => part !== '' && part !== flag)
		.join(' ');
}

/** Whether NODE_OPTIONS names the loader. */
export function names_loader(options: string | undefined): boolean {
	return options !== undefined && options.split(/\s+/).includes(conditions_flag());
}

/**
 * The environment for a process Heisenbench starts: with HEISENBENCH_CONDITIONS set, the loader
 * first in its NODE_OPTIONS, before the user's preloads (their imports get the conditions too).
 */
export function with_conditions(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	if (parse_conditions(env[CONDITIONS_ENV]).length === 0) return env;
	const options = without_loader(env.NODE_OPTIONS ?? '');
	return { ...env, NODE_OPTIONS: `${conditions_flag()} ${options}`.trim() };
}
