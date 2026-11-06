#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { run_benches } from './runner.ts';
import { diff_reports } from './diff/index.ts';
import { render_markdown } from './diff/markdown.ts';
import { git_diff } from './diff/git.ts';
import { write_private_dts } from './dts.ts';
import type { Report } from './report.ts';

const USAGE = `abax run <bench files...> [--root dir] [--out report.json] [--deps all|a,b] [--filter text] [--sha sha]
abax diff <base.json> <pr.json> [--repo dir] [--base sha] [--head sha] [--out section.md] [--json out.json]
abax dts <source files...> --out abax-private.d.ts [--tsconfig tsconfig.json]`;

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
			log: (l) => console.log(l)
		});
		const bad = report.cases.filter((c) => c.error !== null);
		return bad.length > 0 ? 1 : 0;
	}
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
		const md = render_markdown(result);
		const out = flags.get('out');
		if (out) writeFileSync(out, md + '\n');
		else console.log(md);
		const json = flags.get('json');
		if (json) writeFileSync(json, JSON.stringify(result, null, '\t') + '\n');
		return 0;
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
	console.error(USAGE);
	return 2;
}

process.exitCode = await main(process.argv.slice(2));
