import '../v8-flags.ts';
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
	const failures: string[] = [];
	const r = await record_benches({
		files: job.files,
		root: job.root,
		targets: job.targets,
		out: job.out,
		scales: job.scales,
		log: (l) => failures.push(l)
	});
	// a proof on the inputs of the bench files that loaded is a proof on fewer inputs than asked
	if (r.unloaded.length > 0 || r.failed > 0) {
		process.stderr.write(
			`--bench recorded fewer inputs than its files give (${r.unloaded.length} file(s) did not load, ${r.failed} case(s) threw); the first: ${failures[0]}\n`
		);
		process.exit(1);
	}
} else {
	const r = await run_prove(job);
	writeFileSync(job.out, serialize(r));
}
process.exit(0);
