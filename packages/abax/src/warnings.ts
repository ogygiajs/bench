/*
 * Node prints an ExperimentalWarning the first time a process calls `stripTypeScriptTypes`, which
 * Abax does for every TypeScript module it counts. That one warning says nothing to someone
 * running Abax, so it is dropped here, in every process that strips types (the CLI, the children
 * it spawns, the loader thread). Every other warning goes through untouched.
 */

const INSTALLED = Symbol.for('abax.quiet_strip_warning');

type EmitWarning = typeof process.emitWarning;

function is_strip_warning(warning: unknown, rest: unknown[]): boolean {
	const message =
		typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : '';
	if (!message.startsWith('stripTypeScriptTypes')) return false;
	const opt = rest[0];
	const type =
		typeof opt === 'string'
			? opt
			: opt !== null && typeof opt === 'object' && 'type' in opt
				? String((opt as { type: unknown }).type)
				: warning instanceof Error
					? warning.name
					: 'Warning';
	return type === 'ExperimentalWarning';
}

export function quiet_strip_warning(): void {
	const g = globalThis as unknown as Record<symbol, boolean | undefined>;
	if (g[INSTALLED] || typeof process === 'undefined') return;
	g[INSTALLED] = true;
	const emit = process.emitWarning;
	const filtered = function (this: unknown, warning: unknown, ...rest: unknown[]): void {
		if (is_strip_warning(warning, rest)) return;
		Reflect.apply(emit, process, [warning, ...rest]);
	};
	process.emitWarning = filtered as EmitWarning;
}

quiet_strip_warning();
