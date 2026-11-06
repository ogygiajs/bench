import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The static file of a build that answers `pathname` (SSG-style: `/x`, `/x.html`, `/x/index.html`),
 * searched in `dirs` in order; null when the app itself has to answer.
 */
export function static_file(dirs: readonly string[], pathname: string): string | null {
	const tries =
		pathname === '/'
			? ['/index.html']
			: pathname.endsWith('/')
				? [pathname + 'index.html', pathname.slice(0, -1) + '.html']
				: [pathname, pathname + '.html', pathname + '/index.html'];
	for (const dir of dirs) {
		for (const t of tries) {
			const file = join(dir, t);
			if (!file.startsWith(dir)) continue;
			if (existsSync(file) && statSync(file).isFile()) return file;
		}
	}
	return null;
}
