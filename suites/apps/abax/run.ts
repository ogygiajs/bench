#!/usr/bin/env node
// Count the ogygia apps' scenarios with Abax (spec 8) into one app report.
//
//   node abax/run.ts                                        # every scenario, the installed apps
//   node abax/run.ts --scenarios dashboard,shop --out r.json
//   node abax/run.ts --side base                            # the base twins (build-all --base-spec)
//   node abax/run.ts --overlay @ogygia/core/dist/x.js=patched.js   # a planted change
//
// The apps must be installed first (build-all.ts). Then:
//   abax weights r.json --out app-weights.json      real-app weights (spec 11)
//   abax coverage r.json --app <app dir>            which functions the scenarios reached
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SCENARIOS } from './scenarios.ts';
import { ROOT, count_apps, overlay_of, parse_args } from './count.ts';

const args = parse_args(process.argv.slice(2));
const one = (k: string): string | undefined => args.get(k)?.at(-1);
const scenarios = one('scenarios')?.split(',') ?? Object.keys(SCENARIOS);
const out = resolve(one('out') ?? join(ROOT, 'results/scratch/abax/app-report.json'));
const side = one('side') === 'base' ? 'base' : 'pr';

const { report, errors } = await count_apps({
	scenarios,
	side,
	packages: one('packages')?.split(','),
	overlay: overlay_of(args.get('overlay')),
	work: one('work'),
	browser: !args.has('no-browser'),
	sha: one('sha') ?? null
});
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report) + '\n');

const unstable = report.cases.filter((c) => !c.stable);
console.log(`\n${report.cases.length} phases counted -> ${out}`);
console.log(
	unstable.length === 0
		? 'determinism: every phase counted the same on both runs'
		: `determinism: ${unstable.length} UNSTABLE phase(s): ${unstable.map((c) => c.name).join(', ')}`
);
for (const c of unstable) {
	for (const f of c.app.unstable_functions.slice(0, 10)) {
		console.log(
			`  ${f.id}: ${f.a.calls} vs ${f.b.calls} calls, ${f.a.self_steps} vs ${f.b.self_steps} steps`
		);
	}
}
if (errors.length > 0) {
	console.log(`\n${errors.length} problem(s):`);
	for (const e of errors) console.log(`  ${e.split('\n')[0]}`);
}
process.exitCode = errors.length > 0 || unstable.length > 0 ? 1 : 0;
