// The router and ops benchmarks measure ogygia from SOURCE (its playground app and core's runtime
// files), which no npm build ships, so they run against a local ogygia checkout named by
// OGYGIA_REPO. Results still land in this repo's results/.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESULTS = fileURLToPath(new URL('../results', import.meta.url));

export function ogygiaCheckout(): string {
	const dir = process.env.OGYGIA_REPO;
	if (!dir || !existsSync(join(dir, 'packages', 'core', 'src'))) {
		console.error('Set OGYGIA_REPO to a local ogygia checkout (with `pnpm install` done in it).');
		process.exit(1);
	}
	return resolve(dir);
}
