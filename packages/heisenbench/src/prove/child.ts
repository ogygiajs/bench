import { readFileSync, writeFileSync } from 'node:fs';
import { deserialize, serialize } from 'node:v8';
import { record_benches } from '../coverage/record-benches.ts';
import { watch_parent } from '../proc.ts';
import { run_prove } from './run.ts';
import type { ProveJob, RecordJob } from './types.ts';

/*
 * `heisenbench prove`'s child process. A `prove` job runs the original and a candidate on the
 * counting build (run.ts) under the permissions index.ts starts it with: reads under the project
 * and Heisenbench only, one file to write (its result), no network, no child processes, no
 * workers. A `record` job runs the bench cases with the input recorder on (trusted code: the
 * project's own bench files), at their own scales too.
 */

watch_parent();
const job = deserialize(readFileSync(process.argv[2])) as ProveJob | RecordJob;
// what the code under test prints is not the result; the result is the file
console.log = () => {};
console.info = () => {};
console.debug = () => {};
if (job.kind === 'record') {
	await record_benches({
		files: job.files,
		root: job.root,
		targets: job.targets,
		out: job.out,
		scales: job.scales,
		log: (l) => process.stderr.write(l + '\n')
	});
} else {
	const r = await run_prove(job);
	writeFileSync(job.out, serialize(r));
}
process.exit(0);
