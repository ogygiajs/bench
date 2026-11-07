#!/usr/bin/env node
/**
 * The trend over main without a run: the newest full run of main the history holds, against the
 * earlier ones, as the nightly summary would say it.
 *
 *   node suites/ogygia/src/trend-cli.ts --repo <ogygia clone> --history <results branch dir> \
 *     [--sha <main commit>] [--json out.json]
 *
 * --sha defaults to `main` of the clone; the newest stored run on its first-parent line is used.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { trend_lines } from './section.ts';
import { main_order, read_result, run_trend, stored_runs } from './trend.ts';

const { values } = parseArgs({
	options: {
		repo: { type: 'string' },
		history: { type: 'string' },
		sha: { type: 'string', default: 'main' },
		json: { type: 'string' }
	}
});
if (!values.repo || !values.history) {
	console.error('usage: node trend-cli.ts --repo <ogygia clone> --history <dir> [--sha <commit>]');
	process.exit(2);
}
const repo = resolve(values.repo);
const history = resolve(values.history);
const stored = stored_runs(history);
const newest = main_order(repo, values.sha)
	.filter((s) => stored.has(s))
	.at(-1);
if (!newest) {
	console.error(`no full run of main on the first-parent line of ${values.sha}`);
	process.exit(1);
}
const t = run_trend({ repo, history, result: read_result(history, newest) });
if (values.json) writeFileSync(values.json, JSON.stringify(t, null, '\t') + '\n');
console.log(trend_lines(t).join('\n').trimEnd());
console.log(`\n(${t.ms} ms)`);
