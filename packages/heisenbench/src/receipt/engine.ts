import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OWN_DIR, PACKAGE_DIR } from '../own.ts';

/*
 * Which engine counted a receipt. Its hash is the incremental cache's (cache/key.ts
 * engine_version: Heisenbench's code, package files and dependency versions), so two engines with
 * the same hash count the same. Its version and where it runs from say which one to check with.
 */

export { engine_version } from '../cache/key.ts';
export { sha256 } from '../cache/normalize.ts';

/**
 * Where the engine runs from: the npm package (built dist/), or a checkout of the bench repo (src/)
 * at a commit, `+changes` when its working tree differs from that commit. A checkout's version is
 * the last one released from it, not the code it runs, so the commit says which engine it is.
 */
export function engine_source(): string {
	if (!/[\\/]src[\\/]$/.test(OWN_DIR)) return 'npm';
	const git = (args: string[]): string | null => {
		try {
			return execFileSync('git', args, {
				cwd: PACKAGE_DIR,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'ignore']
			}).trim();
		} catch {
			return null;
		}
	};
	const sha = git(['rev-parse', 'HEAD']);
	if (sha === null) return 'checkout';
	const dirty = git(['status', '--porcelain', '--', '.']);
	return `checkout ${sha.slice(0, 12)}${dirty ? '+changes' : ''}`;
}

/** Heisenbench's own version (package.json). */
export function engine_package_version(): string {
	return (
		JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as { version: string }
	).version;
}
