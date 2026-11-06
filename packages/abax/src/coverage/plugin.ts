import { resolve } from 'node:path';
import { module_id } from '../transform/index.ts';
import { record_transform } from './record-transform.ts';

/*
 * The recording transform as a Vite plugin (for a test runner built on Vite, e.g. vitest): the
 * functions named in `targets` record their inputs and outputs while the tests run (recorder.ts).
 * Runs last, on the JS other plugins produced, like the counting plugin.
 */

export interface RecordPluginOptions {
	/** `module id` (as reports name it) -> function paths to record in it. */
	targets: Record<string, string[]>;
	/** Module ids are relative to this directory (default cwd). */
	root?: string;
}

export function abax_record_plugin(o: RecordPluginOptions) {
	const root = resolve(o.root ?? process.cwd());
	const targets = new Map(Object.entries(o.targets).map(([m, paths]) => [m, new Set(paths)]));
	return {
		name: 'abax:record',
		enforce: 'post' as const,
		transform(code: string, id: string): { code: string; map: object } | null {
			if (id.startsWith('\0')) return null;
			const q = id.indexOf('?');
			const file = q === -1 ? id : id.slice(0, q);
			const mid = module_id(file, root);
			const paths = targets.get(mid);
			if (!paths) return null;
			const r = record_transform(code, { filename: file, id: mid, targets: paths });
			return { code: r.code, map: r.map };
		}
	};
}
