#!/usr/bin/env node
// Copy a scenario's shared UI and data into one of its apps, so every app renders the same
// components from the same data. The copies are gitignored in the app; edit scenarios/<name>/shared.
//
//   node scenarios/sync.ts <scenario> <app dir> [shared dest] [public dir]
//
// shared/ goes to <shared dest> (default src/lib/shared). Static files, shared/public/ and the
// generated shared/data/public/, go into the app's <public dir> (default public; `static` for
// SvelteKit), served at the site root.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [scenario, appDir, dest = 'src/lib/shared', publicDir = 'public'] = process.argv.slice(2);
if (!scenario || !appDir) {
	console.error('usage: node scenarios/sync.ts <scenario> <app dir> [shared dest] [public dir]');
	process.exit(1);
}
const from = join(ROOT, 'scenarios', scenario, 'shared');
if (!existsSync(from)) {
	console.error(`no shared dir at ${from}`);
	process.exit(1);
}
const to = join(ROOT, appDir, dest);
rmSync(to, { recursive: true, force: true });
cpSync(from, to, {
	recursive: true,
	filter: (src) => !src.startsWith(join(from, 'data', 'public'))
});
const pub = join(ROOT, appDir, publicDir);
rmSync(pub, { recursive: true, force: true });
for (const dir of [join(from, 'public'), join(from, 'data', 'public')])
	if (existsSync(dir)) cpSync(dir, pub, { recursive: true });
console.log(`synced scenarios/${scenario}/shared → ${appDir}/${dest} (+ ${publicDir}/)`);
