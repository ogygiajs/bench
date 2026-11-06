#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { run_benches } from './runner.ts';
import { diff_reports } from './diff/index.ts';
import { render_markdown } from './diff/markdown.ts';
import { git_diff } from './diff/git.ts';
import { write_private_dts } from './dts.ts';
import type { Report } from './report.ts';
import { engine_health } from './engine/health.ts';
import { run_growth } from './growth/index.ts';
import { run_search } from './search/index.ts';
import { diff_sections, render_sections, write_section } from './sections.ts';
import { measure_command, measure_run, time_section } from './measure/cli.ts';
import { app_command, app_diff_sections } from './app/cli.ts';
import { VERIFY_LAYERS, render_verify, run_verify } from './verify/index.ts';
import { coverage_command } from './coverage/cli.ts';
import type { VerifyLayer } from './verify/index.ts';

const HELP = `abax: count the work a function does, per line, the same on every run.

Counting (the counting build)
  abax run <bench files...>      count every case: steps, allocations, bytes, calls
      [--out abax-report.json] [--root dir] [--filter text] [--deps all|a,b] [--sha sha]
      [--state fresh|shared] [--measure time,bytes,leaks|all] [--time-ms 300]
  abax diff <base.json> <pr.json>   compare two reports: the markdown section
      [--repo dir] [--base sha] [--head sha] [--out section.md] [--json diff.json]
      [--time time.json] [--weights app-weights.json]
  abax dts <source files...> --out abax-private.d.ts [--tsconfig tsconfig.json]
                                 types for the private functions bench files import as __abax

Layers (each writes its section into --out, default abax-report.json)
  abax health <bench files...>   V8 tiers, deopts and inline caches on the plain build
      [--warmup 20] [--runs 3] [--check on|off] [--root dir] [--filter text] [--out file]
  abax growth <bench files...>   steps at 1x, 10x, 100x the input; the curve class
      [--sizes 1,10,100] [--scaled on|off] [--root dir] [--filter text] [--out file]
  abax search <bench files...>   the input of the same size that costs the most steps
      [--evals 300] [--budget-steps 2e8] [--budget-ms 30000] [--seed 1] [--size-factor 1]
  abax time <bench files...> --base dir --pr dir   both trees timed in one process, in turns
      [--repeats 5] [--time-ms 300] [--filter text] [--out abax-time.json] [--md time.md]

Real apps and the measurement-source gate
  abax weights <app-report.json...> [--out app-weights.json]
  abax coverage <app-report.json...> --app <installed app dir> [--packages ogygia,@ogygia/*]
      [--out coverage.json] [--md coverage.md]
  abax inventory [files...] [--list files.txt] --root dir --out inventory.json
      [--reports a.json,b.json --targets targets.json]
  abax replay --records dir --root dir --out replay.json
  abax unmeasured --inventory inventory.json [--reports a.json,b.json] [--records dir]
      [--replay replay.json] [--skipped skipped.json] [--base-inventory base.json]
      [--exempt unmeasured.json] [--out gate.json] [--md gate.md]

Calibration
  abax calibrate prices [--keys a,b] [--sizes 16,64,256] [--out prices.json] [--time-ms 100]
  abax calibrate points [bench files...] [--root dir] [--out points.json] [--time-ms 150] [--repeats 3]
  abax calibrate agree <a.json> <b.json> [--tolerance 3] [--shift 5]
  abax calibrate weights [bench files...] | --points a.json,b.json [--out weights.json]

Proof
  abax verify [--layers steps,elision,leak,engine,growth,search,app,time] [--filter text]
      [--jobs n] [--md table.md] [--json rows.json]

Docs: packages/abax/README.md in github.com/ogygiajs/bench`;

/** `abax verify`: every planted case of every layer; exit 1 when any fails. */
async function verify_command(flags: Map<string, string>): Promise<number> {
	const layers = flags.get('layers')?.split(',') as VerifyLayer[] | undefined;
	const bad = layers?.filter((l) => !VERIFY_LAYERS.includes(l));
	if (bad && bad.length > 0) {
		console.error(`abax verify: unknown layer ${bad.join(', ')} (${VERIFY_LAYERS.join(', ')})`);
		return 2;
	}
	const rows = await run_verify({
		layers,
		filter: flags.get('filter'),
		jobs: flags.has('jobs') ? Number(flags.get('jobs')) : undefined,
		log: (r) =>
			console.log(`${r.pass ? 'pass' : 'FAIL'}  ${r.layer}/${r.name}  ${r.got}  (${r.ms} ms)`)
	});
	console.log('\n' + render_verify(rows, false));
	const md = flags.get('md');
	if (md) writeFileSync(md, render_verify(rows));
	const json = flags.get('json');
	if (json) writeFileSync(json, JSON.stringify(rows, null, '\t') + '\n');
	return rows.length > 0 && rows.every((r) => r.pass) ? 0 : 1;
}

interface Parsed {
	positional: string[];
	flags: Map<string, string>;
}

function parse(argv: string[]): Parsed {
	const positional: string[] = [];
	const flags = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			if (eq !== -1) flags.set(a.slice(2, eq), a.slice(eq + 1));
			else flags.set(a.slice(2), argv[++i] ?? '');
		} else {
			positional.push(a);
		}
	}
	return { positional, flags };
}

async function main(argv: string[]): Promise<number> {
	const [cmd, ...rest] = argv;
	const { positional, flags } = parse(rest);
	if (cmd === 'help' || cmd === '--help' || cmd === '-h' || flags.has('help')) {
		console.log(HELP);
		return 0;
	}
	if (cmd === 'run') {
		if (positional.length === 0) {
			console.error(HELP);
			return 2;
		}
		const deps_flag = flags.get('deps');
		const deps =
			deps_flag === undefined ? false : deps_flag === 'all' ? true : deps_flag.split(',');
		const report = await run_benches({
			files: positional,
			root: flags.get('root'),
			out: flags.get('out') ?? 'abax-report.json',
			deps,
			filter: flags.get('filter'),
			sha: flags.get('sha') ?? null,
			fresh: flags.get('state') !== 'shared',
			log: (l) => console.log(l)
		});
		await measure_run(report, positional, flags);
		const bad = report.cases.filter((c) => c.error !== null);
		return bad.length > 0 ? 1 : 0;
	}
	const measured = await measure_command(cmd, positional, flags);
	if (measured !== null) return measured;
	const app = app_command(cmd, positional, flags);
	if (app !== null) return app;
	if (cmd === 'verify') return verify_command(flags);
	const coverage = await coverage_command(cmd, positional, flags);
	if (coverage !== null) return coverage;
	if (cmd === 'diff') {
		if (positional.length !== 2) {
			console.error(HELP);
			return 2;
		}
		const base = JSON.parse(readFileSync(positional[0], 'utf8')) as Report;
		const pr = JSON.parse(readFileSync(positional[1], 'utf8')) as Report;
		const repo = flags.get('repo');
		const base_sha = flags.get('base') ?? base.git.sha;
		const head_sha = flags.get('head') ?? pr.git.sha;
		const files =
			repo !== undefined && base_sha && head_sha
				? git_diff(resolve(repo), base_sha, head_sha)
				: null;
		const result = diff_reports(base, pr, { files });
		const sections = diff_sections(base, pr, files);
		const extra = render_sections(sections);
		const time = time_section(flags);
		const apps = app_diff_sections(result, base, pr, flags);
		const md =
			(apps ? apps + '\n' : '') +
			render_markdown(result) +
			(extra ? '\n' + extra : '') +
			(time ? '\n' + time : '');
		const out = flags.get('out');
		if (out) writeFileSync(out, md + '\n');
		else console.log(md);
		const json = flags.get('json');
		if (json) writeFileSync(json, JSON.stringify({ ...result, ...sections }, null, '\t') + '\n');
		return 0;
	}
	if (cmd === 'health' || cmd === 'growth' || cmd === 'search') {
		if (positional.length === 0) {
			console.error(HELP);
			return 2;
		}
		const root = flags.get('root') ?? process.cwd();
		const out = flags.get('out') ?? 'abax-report.json';
		const deps_flag = flags.get('deps');
		const common = {
			files: positional,
			root,
			filter: flags.get('filter'),
			deps: deps_flag === undefined ? false : deps_flag === 'all' ? true : deps_flag.split(','),
			log: (l: string) => console.log(l)
		};
		const num = (k: string): number | undefined =>
			flags.has(k) ? Number(flags.get(k)) : undefined;
		const info = { root, sha: flags.get('sha') ?? null };
		if (cmd === 'health') {
			const r = await engine_health({
				...common,
				warmup: num('warmup'),
				runs: num('runs'),
				check: flags.get('check') !== 'off'
			});
			write_section(out, 'engine', r, info);
			return r.cases.some((c) => c.error !== null) ? 1 : 0;
		}
		if (cmd === 'growth') {
			const sizes = flags.get('sizes')?.split(',').map(Number);
			const r = await run_growth({ ...common, sizes, scaled: flags.get('scaled') === 'on' });
			write_section(out, 'growth', r, info);
			return r.cases.some((c) => c.error !== null) ? 1 : 0;
		}
		const r = await run_search({
			...common,
			evals: num('evals'),
			steps: num('budget-steps'),
			ms: num('budget-ms'),
			seed: num('seed'),
			size_factor: num('size-factor')
		});
		write_section(out, 'search', r, info);
		return r.cases.some((c) => c.error !== null) ? 1 : 0;
	}
	if (cmd === 'dts') {
		const out = flags.get('out');
		if (!out || positional.length === 0) {
			console.error(HELP);
			return 2;
		}
		write_private_dts({
			files: positional.map((f) => resolve(f)),
			out: resolve(out),
			tsconfig: flags.get('tsconfig')
		});
		return 0;
	}
	console.error(cmd === undefined ? HELP : `abax: unknown command ${cmd}\n\n${HELP}`);
	return 2;
}

process.exitCode = await main(process.argv.slice(2));
