import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Report } from '../src/report.ts';
import { temp_dir, write_files } from './helpers.ts';

/*
 * A repo's first PR adds the bench files, so its base has none. `run --source-from <base>` counts
 * the PR's bench files on the base's code: the diff then compares the two versions of the code.
 */

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const API = JSON.stringify(
	pathToFileURL(fileURLToPath(new URL('../src/bench.ts', import.meta.url))).href
);

function heisenbench(args: string[], cwd: string) {
	const r = spawnSync(process.execPath, [CLI, ...args], {
		cwd,
		encoding: 'utf8',
		timeout: 120_000
	});
	return { code: r.status, out: r.stdout + r.stderr };
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('--source-from counts these bench files on another commit: the first PR has a baseline', () => {
	const repo = temp_dir('heisenbench-source-from-');
	const pkg = join(repo, 'packages', 'lib');
	write_files(pkg, {
		'package.json': '{ "type": "module" }',
		'src/sum.ts': `export function sum(xs: number[]): number {
	let s = 0;
	for (const x of xs) s += x;
	return s;
}
`
	});
	git(repo, 'init', '-q');
	git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
	git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
	const base = git(repo, 'rev-parse', 'HEAD');
	// the PR: a second pass in sum, a helper and the bench file that uses it
	write_files(pkg, {
		'src/sum.ts': `export function sum(xs: number[]): number {
	let s = 0;
	for (const x of xs) s += x;
	for (const x of xs) s += 0 * x;
	return s;
}
`,
		'bench/data.ts': 'export const numbers = () => Array.from({ length: 50 }, (_, i) => i);\n',
		'bench/sum.bench.ts': `import { bench } from ${API};
import { sum } from '../src/sum.ts';
import { numbers } from './data.ts';
bench('sum: fifty numbers', ({ xs }) => sum(xs), { setup: () => ({ xs: numbers() }) });
`
	});
	git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
	git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'pr');

	assert.equal(heisenbench(['run', 'bench/sum.bench.ts', '--out', 'head.json'], pkg).code, 0);
	const r = heisenbench(
		['run', 'bench/sum.bench.ts', '--source-from', base, '--out', 'base.json'],
		pkg
	);
	assert.equal(r.code, 0, r.out);
	const head_report = JSON.parse(readFileSync(join(pkg, 'head.json'), 'utf8')) as Report;
	const base_report = JSON.parse(readFileSync(join(pkg, 'base.json'), 'utf8')) as Report;
	assert.equal(base_report.git.sha, base, "the report is the base commit's");
	assert.equal(base_report.git.prefix, 'packages/lib');
	const steps = (rep: Report) => rep.cases[0].functions.find((f) => f.path === 'sum')!.self_steps;
	assert.ok(steps(head_report) > steps(base_report), 'the base counted its own sum, one pass');
	// the working tree is untouched
	assert.match(readFileSync(join(pkg, 'src/sum.ts'), 'utf8'), /s \+= 0 \* x/);

	const d = heisenbench(['diff', 'base.json', 'head.json', '--repo', repo], pkg);
	assert.equal(d.code, 0, d.out);
	assert.match(d.out, /\| sum: fifty numbers \| `src\/sum\.ts > sum` \|/);
	assert.match(d.out, /\| new code \| `src\/sum\.ts:4` \|/);

	const bad = heisenbench(['run', 'bench/sum.bench.ts', '--source-from', 'nope'], pkg);
	assert.equal(bad.code, 1);
	assert.match(bad.out, /--source-from nope: no such commit/);
	const measured = heisenbench(
		['run', 'bench/sum.bench.ts', '--source-from', base, '--measure', 'time'],
		pkg
	);
	assert.equal(measured.code, 2);
	assert.match(measured.out, /--source-from counts only/);
});
