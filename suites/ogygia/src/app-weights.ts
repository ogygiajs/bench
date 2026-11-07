#!/usr/bin/env node
/**
 * The real-app weights a main run stores, from the counted app scenarios (suites/apps/heisenbench):
 *
 *   node suites/apps/heisenbench/run.ts --sha <sha> --out app-report.json
 *   node suites/ogygia/src/app-weights.ts --sha <sha> --out app-weights.json app-report.json
 *
 * The same file `heisenbench weights` writes, labelled with the commit and stamped with the Node and V8
 * that counted it, so a PR run can tell whether the weights compare with its own counts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { AppReport } from '@bench/heisenbench/app';
import { main_weights } from './weights.ts';

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { sha: { type: 'string' }, out: { type: 'string', default: 'app-weights.json' } }
});
if (!values.sha || !/^[0-9a-f]{40}$/.test(values.sha) || positionals.length === 0) {
	console.error(
		'usage: node app-weights.ts --sha <sha> [--out app-weights.json] <app-report.json...>'
	);
	process.exit(2);
}
const reports = positionals.map((p) => {
	const r = JSON.parse(readFileSync(p, 'utf8')) as AppReport;
	if (!r.app) throw new Error(`${p} is not an app report`);
	return r;
});
const w = main_weights(reports, values.sha);
writeFileSync(values.out, JSON.stringify(w) + '\n');
const units = Object.keys(w.units).length;
console.log(`${Object.keys(w.functions).length} functions in ${units} units -> ${values.out}`);
if (units === 0) process.exitCode = 1;
