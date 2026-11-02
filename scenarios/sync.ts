#!/usr/bin/env node
// Copy a scenario's shared UI and data into one of its apps, so every app renders the same
// components from the same data. The copy is gitignored in the app; edit scenarios/<name>/shared.
//
//   node scenarios/sync.ts <scenario> <app dir> [dest inside the app, default src/lib/shared]
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [scenario, appDir, dest = 'src/lib/shared'] = process.argv.slice(2);
if (!scenario || !appDir) {
	console.error('usage: node scenarios/sync.ts <scenario> <app dir> [dest]');
	process.exit(1);
}
const from = join(ROOT, 'scenarios', scenario, 'shared');
if (!existsSync(from)) {
	console.error(`no shared dir at ${from}`);
	process.exit(1);
}
const to = join(ROOT, appDir, dest);
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log(`synced scenarios/${scenario}/shared → ${appDir}/${dest}`);
