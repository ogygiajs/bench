#!/usr/bin/env node
// The answer key of the counted app runs (Heisenbench, spec 8 + 11 + 12): plant changes in a patched
// copy of the installed @ogygia/core and check that Heisenbench finds what was planted, where it was
// planted, with what it costs the real apps.
//
//   1. A slowdown (an extra loop) in `is_lower_hex`, which the shop's server-island requests run.
//      Counted shop and dashboard runs, unpatched vs patched: the shop's server request must grow,
//      mostly at the planted line; the dashboard must not change.
//   2. The same two changes seen by a bench of the module, ranked by real-app weight: the slowdown
//      shows with its cost per shop request; a change in `configure_islands_endpoint`, which no
//      scenario calls, is cold and suppressed.
//
//   node heisenbench/answer-key.ts [--out results/scratch/heisenbench/answer-key]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffReports, renderMarkdown } from '@bench/heisenbench';
import { overlay_diff, render_app_diff } from '@bench/heisenbench/app';
import { build_weights, rank_changes, render_weighted } from '@bench/heisenbench/weight';
import type { Report } from '@bench/heisenbench';
import { APP_DIRS } from './scenarios.ts';
import { ROOT, count_apps, parse_args } from './count.ts';

const MODULE = '@ogygia/core/dist/server/endpoint.js';
const args = parse_args(process.argv.slice(2));
const out = resolve(
	args.get('out')?.at(-1) ?? join(ROOT, 'results/scratch/heisenbench/answer-key')
);
mkdirSync(out, { recursive: true });
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
	if (!ok) failures.push(what);
};

// ---- the patched copy
const installed = realpathSync(join(ROOT, APP_DIRS.shop, 'node_modules', ...MODULE.split('/')));
const original = readFileSync(installed, 'utf8');
function plant(src: string, anchor: string, insert: string): string {
	const at = src.indexOf(anchor);
	if (at === -1) throw new Error(`answer key: "${anchor}" is not in ${MODULE} any more`);
	return src.slice(0, at + anchor.length) + insert + src.slice(at + anchor.length);
}
const SLOW_ANCHOR = 'function is_lower_hex(s, n) {\n\tif (s.length !== n) return false;\n';
const COLD_ANCHOR = 'function configure_islands_endpoint(path) {\n';
let patched = plant(
	original,
	SLOW_ANCHOR,
	'\tlet planted = 0;\n\tfor (let j = 0; j < n; j++) planted += s.charCodeAt(j) & 1;\n\tif (planted < 0) return false;\n'
);
// Same behaviour, a few more steps per call.
patched = plant(
	patched,
	COLD_ANCHOR,
	"\tconst planted_len = typeof path === 'string' ? path.length : 0;\n\tif (planted_len < 0) return;\n"
);
const slow_line =
	patched.slice(0, patched.indexOf(SLOW_ANCHOR) + SLOW_ANCHOR.length).split('\n').length + 1;
const patched_file = join(out, 'endpoint.patched.js');
writeFileSync(patched_file, patched);
console.log(
	`planted: an extra loop at ${MODULE}:${slow_line}, a cold change in configure_islands_endpoint`
);

// ---- 1. counted apps, unpatched vs patched
const scenarios = ['shop', 'dashboard'];
const work = join(tmpdir(), 'heisenbench-key');
const base = await count_apps({ scenarios, work });
const pr = await count_apps({ scenarios, work, overlay: { [MODULE]: patched_file } });
writeFileSync(join(out, 'base.json'), JSON.stringify(base.report) + '\n');
writeFileSync(join(out, 'pr.json'), JSON.stringify(pr.report) + '\n');
const original_file = join(out, 'endpoint.original.js');
writeFileSync(original_file, original);
const files = [overlay_diff(MODULE, original_file, patched_file)];
const d = diffReports(base.report, pr.report, { files });
const apps_md = render_app_diff(d, base.report, pr.report);
console.log('\n' + apps_md);

const shop_req = d.findings.filter(
	(f) => f.case.startsWith('shop › server › page view') && f.module === MODULE
);
check(shop_req.length > 0, 'the shop server request changed in endpoint.js');
check(
	shop_req.some((f) => f.line === slow_line && f.delta.steps > 0),
	`the change is placed on the planted line (${MODULE}:${slow_line})`
);
check(
	d.findings.every((f) => f.module === MODULE),
	'nothing outside the patched module changed'
);
check(
	d.findings.filter((f) => f.case.startsWith('dashboard')).length === 0,
	'the dashboard, which never runs the function, did not change'
);

// ---- 2. a bench of the module, ranked by real-app weight
const weights = build_weights([base.report]);
writeFileSync(join(out, 'app-weights.json'), JSON.stringify(weights, null, '\t') + '\n');
const HEISENBENCH = fileURLToPath(new URL('../../../packages/heisenbench/', import.meta.url));
function bench_side(name: string, source: string): Report {
	// one directory for both sides, one after the other (paths are part of what code handles)
	const dir = join(tmpdir(), 'heisenbench-key-bench');
	const files: Record<string, string> = {
		'node_modules/@ogygia/core/package.json': '{"name":"@ogygia/core","type":"module"}',
		[`node_modules/${MODULE}`]: source,
		'endpoint.bench.ts': [
			`import { bench } from ${JSON.stringify(join(HEISENBENCH, 'src/bench.ts'))};`,
			`import { configure_islands_endpoint, is_region_id } from '${MODULE}';`,
			`bench('region ids', () => { for (const id of ['0123456789ab', 'deadbeef0000', 'XYZ']) is_region_id(id); });`,
			`bench('configure', () => configure_islands_endpoint('/__ogygia__'));`
		].join('\n')
	};
	for (const [f, text] of Object.entries(files)) {
		mkdirSync(join(dir, f, '..'), { recursive: true });
		writeFileSync(join(dir, f), text);
	}
	const report = join(out, `bench-${name}.json`);
	execFileSync(
		process.execPath,
		[
			'--no-warnings',
			join(HEISENBENCH, 'src/cli.ts'),
			'run',
			join(dir, 'endpoint.bench.ts'),
			'--root',
			dir,
			'--deps',
			'@ogygia/core',
			'--out',
			report
		],
		{ stdio: 'ignore' }
	);
	return JSON.parse(readFileSync(report, 'utf8')) as Report;
}
const bd = diffReports(bench_side('base', original), bench_side('pr', patched), { files });
const ranked = rank_changes(bd, weights);
const weighted_md = render_weighted(ranked);
console.log('\n' + weighted_md);
const slow = ranked.find((r) => r.function === 'is_lower_hex');
const cold = ranked.find((r) => r.function === 'configure_islands_endpoint');
check(slow?.judgement.show === true, 'the slowdown is shown');
check(
	slow?.judgement.top?.unit === 'shop server request' && (slow?.judgement.top?.steps ?? 0) > 0,
	`its cost is given per shop server request (${slow?.judgement.top?.steps} steps)`
);
check(
	cold?.judgement.heat === 'cold' && cold?.judgement.show === false,
	'the cold change is suppressed'
);

writeFileSync(join(out, 'answer-key.md'), [apps_md, renderMarkdown(d), weighted_md, ''].join('\n'));
console.log(
	`\n${failures.length === 0 ? 'answer key: all planted changes found' : `answer key: ${failures.length} FAILED`} -> ${out}`
);
process.exitCode = failures.length === 0 ? 0 : 1;
