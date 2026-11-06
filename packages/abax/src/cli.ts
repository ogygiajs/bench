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
import { MEASURE_USAGE, measure_command, measure_run, time_section } from './measure/cli.ts';
import { APP_USAGE, app_command, app_diff_sections } from './app/cli.ts';

const USAGE = `abax run <bench files...> [--root dir] [--out report.json] [--deps all|a,b] [--filter text] [--sha sha] [--state fresh|shared]
abax diff <base.json> <pr.json> [--repo dir] [--base sha] [--head sha] [--out section.md] [--json out.json]
abax dts <source files...> --out abax-private.d.ts [--tsconfig tsconfig.json]
abax health <bench files...> [--root dir] [--out report.json] [--filter text] [--warmup 20] [--runs 3] [--check on|off]
abax growth <bench files...> [--root dir] [--out report.json] [--filter text] [--sizes 1,10,100] [--scaled on|off]
abax search <bench files...> [--root dir] [--out report.json] [--filter text] [--evals 300] [--budget-steps 2e8] [--budget-ms 30000] [--seed 1] [--size-factor 1]`;

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
	if (cmd === 'run') {
		if (positional.length === 0) {
			console.error(USAGE);
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
	if (cmd === 'diff') {
		if (positional.length !== 2) {
			console.error(USAGE);
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
			console.error(USAGE);
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
			console.error(USAGE);
			return 2;
		}
		write_private_dts({
			files: positional.map((f) => resolve(f)),
			out: resolve(out),
			tsconfig: flags.get('tsconfig')
		});
		return 0;
	}
	console.error(USAGE + '\n' + MEASURE_USAGE + '\n' + APP_USAGE);
	return 2;
}

process.exitCode = await main(process.argv.slice(2));
