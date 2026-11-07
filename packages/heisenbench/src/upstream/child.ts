import '../warnings.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { record_benches } from '../coverage/record-benches.ts';
import { watch_parent } from '../proc.ts';

/*
 * Entry of a recording child (upstream/index.ts): `node child.ts job.json`. Runs one case once,
 * uncounted, with the recorder on one function of a dependency (its file as it is on disk), and
 * saves what the recorder kept: the arguments the project passed to that function.
 */

interface Job {
	root: string;
	/** The bench file, relative to the root. */
	file: string;
	case: string;
	/** The dependency's file, resolved through links. */
	module: string;
	path: string;
	out: string;
}

watch_parent();
const job = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Job;
process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});
await record_benches({
	files: [join(job.root, job.file)],
	root: job.root,
	targets: { [job.module]: [job.path] },
	out: job.out,
	names: [job.case]
});
process.exit(0);
