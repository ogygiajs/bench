#!/usr/bin/env node
// Check a measure job's artifact before the publish job stores or posts it (see artifact.ts).
//
//   node packages/compare/src/validate-artifact.ts heisenbench --dir <artifact> --out <dir> \
//     --kind <pr|main|manual> --sha <sha> [--base-sha <sha>] [--pr <n>]
//   node packages/compare/src/validate-artifact.ts apps    ...same flags
//   node packages/compare/src/validate-artifact.ts weights --dir <artifact> --out <dir> --sha <sha>
//
// The checked files are written to --out under fixed names (heisenbench: result.json, its checked
// shards in shards/ when it is a manifest, section.md; apps:
// run.json, comment.md; weights: app-weights.json); later steps read only those. `apps` prints
// `name=<file name on the results branch>` for $GITHUB_OUTPUT. Exit 1, with the reason, when the
// artifact does not pass.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
	ArtifactError,
	validate_heisenbench,
	validate_apps,
	validate_weights
} from './artifact.ts';
import { SHARDS_DIR } from './shards.ts';

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		dir: { type: 'string' },
		out: { type: 'string' },
		kind: { type: 'string', default: '' },
		sha: { type: 'string', default: '' },
		'base-sha': { type: 'string', default: '' },
		pr: { type: 'string', default: '' }
	}
});

const usage =
	'usage: node validate-artifact.ts <heisenbench|apps|weights> --dir <artifact> --out <dir> --kind <k> --sha <sha> [--base-sha <sha>] [--pr <n>]';
const [what] = positionals;
if (!values.dir || !values.out || !['heisenbench', 'apps', 'weights'].includes(what)) {
	console.error(usage);
	process.exit(2);
}
const plan = { kind: values.kind, sha: values.sha, base_sha: values['base-sha'], pr: values.pr };
const out = values.out;

try {
	mkdirSync(out, { recursive: true });
	if (what === 'heisenbench') {
		const a = validate_heisenbench(values.dir, plan);
		writeFileSync(join(out, 'result.json'), a.result);
		if (a.shards.size > 0) {
			mkdirSync(join(out, SHARDS_DIR), { recursive: true });
			for (const [name, bytes] of a.shards) writeFileSync(join(out, SHARDS_DIR, name), bytes);
		}
		writeFileSync(join(out, 'section.md'), a.section);
	} else if (what === 'apps') {
		const a = validate_apps(values.dir, plan);
		writeFileSync(join(out, 'run.json'), a.run);
		if (a.comment !== null) writeFileSync(join(out, 'comment.md'), a.comment);
		console.log(`name=${a.name}`);
	} else {
		writeFileSync(join(out, 'app-weights.json'), validate_weights(values.dir, plan));
	}
	console.error(`${what} artifact ok`);
} catch (e) {
	if (!(e instanceof ArtifactError)) throw e;
	console.error(`::error title=Artifact rejected::${e.message}`);
	process.exit(1);
}
