import { execFileSync } from 'node:child_process';
import { parse_diff } from '../diff/git.ts';
import type { FileDiff } from '../diff/git.ts';

/**
 * The line map of an overlay (a patched copy of a package file, vite.ts): a zero-context diff of
 * the two files under the module's id, so `abax diff` places changes on the patched lines and
 * maps the unchanged ones across, as it does for a commit.
 */
export function overlay_diff(module_id: string, original: string, patched: string): FileDiff {
	let text = '';
	try {
		text = execFileSync(
			'git',
			['diff', '--no-index', '--no-color', '--no-ext-diff', '--unified=0', original, patched],
			{ encoding: 'utf8', maxBuffer: 1 << 26 }
		);
	} catch (e) {
		// `git diff --no-index` exits 1 when the files differ
		text = String((e as { stdout?: string }).stdout ?? '');
	}
	const hunks = parse_diff(text).flatMap((f) => f.hunks);
	return { old_path: module_id, new_path: module_id, hunks };
}
