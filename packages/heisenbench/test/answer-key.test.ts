import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { diff_reports } from '../src/diff/index.ts';
import type { Finding } from '../src/diff/index.ts';
import { git_diff } from '../src/diff/git.ts';
import { render_markdown } from '../src/diff/markdown.ts';
import type { Report } from '../src/report.ts';
import { temp_dir } from './helpers.ts';

/*
 * The answer key (spec 12): fixture commits with planted slowdowns and planted no-ops. Each fixture
 * is a PR against the same base; both sides are measured by the CLI in separate checkouts, like CI
 * does, and diffed through git. Heisenbench must flag exactly the planted lines and nothing for a no-op.
 */

const run = promisify(execFile);
const KEY = fileURLToPath(new URL('./answer-key/', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const BENCH_API = fileURLToPath(new URL('../src/bench.ts', import.meta.url));

interface Expect {
	what: string;
	planted: Array<[number, number]>;
	/** Extra `heisenbench run` flags (the plain-build layers: `--measure bytes`). */
	flags?: string[];
	/** Planted allocations the engine elides: shown, est >> real, never a regression. */
	elided?: Array<[number, number]>;
	/** The PR leaks (where), or must not (null). */
	leak?: { module: string; function: string; variable: string; line: number } | null;
}

function files_of(dir: string): Record<string, string> {
	const bench = readFileSync(join(KEY, 'base', 'lib.bench.ts.txt'), 'utf8').replace(
		'HEISENBENCH_BENCH',
		BENCH_API
	);
	return { 'lib.ts': readFileSync(join(dir, 'lib.ts.txt'), 'utf8'), 'lib.bench.ts': bench };
}

function write_all(dir: string, files: Record<string, string>): void {
	mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}

function git(cwd: string, args: string[]): string {
	return execFileSync(
		'git',
		['-c', 'user.name=heisenbench', '-c', 'user.email=heisenbench@example.invalid', ...args],
		{
			cwd,
			encoding: 'utf8'
		}
	).trim();
}

async function measure(dir: string, sha: string, flags: string[] = []): Promise<Report> {
	await run(
		process.execPath,
		[
			'--no-warnings',
			CLI,
			'run',
			'lib.bench.ts',
			'--root',
			dir,
			'--out',
			'report.json',
			'--sha',
			sha,
			...flags
		],
		{
			cwd: dir
		}
	);
	return JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as Report;
}

function describe_findings(f: Finding[]): string {
	return f
		.map((x) => `${x.kind} ${x.module}:${x.line} (${x.function}) Δ${x.delta.steps} steps`)
		.join('\n');
}

const fixtures = readdirSync(KEY).filter((d) => d !== 'base');

for (const name of fixtures) {
	test(`answer key: ${name}`, async () => {
		const expect = JSON.parse(readFileSync(join(KEY, name, 'expect.json'), 'utf8')) as Expect;
		const tmp = temp_dir('heisenbench-key-');
		const repo = join(tmp, 'repo');
		const base_files = files_of(join(KEY, 'base'));
		const pr_files = files_of(join(KEY, name));
		write_all(repo, base_files);
		git(repo, ['init', '-q']);
		git(repo, ['add', '.']);
		git(repo, ['commit', '-q', '-m', 'base']);
		const base_sha = git(repo, ['rev-parse', 'HEAD']);
		write_all(repo, pr_files);
		git(repo, ['add', '.']);
		git(repo, ['commit', '-q', '-m', name]);
		const pr_sha = git(repo, ['rev-parse', 'HEAD']);

		write_all(join(tmp, 'base'), base_files);
		write_all(join(tmp, 'pr'), pr_files);
		// Timing-sensitive layers (real bytes, leaks) measure one side at a time.
		const base = await measure(join(tmp, 'base'), base_sha, expect.flags);
		const pr = await measure(join(tmp, 'pr'), pr_sha, expect.flags);
		assert.equal(base.cases[0].stable, true);
		assert.equal(pr.cases[0].stable, true);

		const d = diff_reports(base, pr, { files: git_diff(repo, base_sha, pr_sha) });
		const findings = d.findings;
		const shown = describe_findings(findings);
		if (expect.planted.length === 0) {
			assert.deepEqual(findings, [], `no-op "${expect.what}" flagged:\n${shown}`);
			assert.ok(render_markdown(d).includes('No function changed'));
			return;
		}
		for (const f of findings) {
			assert.equal(f.module, 'lib.ts');
			const inside = expect.planted.some(([a, b]) => f.line >= a && f.line <= b);
			assert.ok(inside, `flag outside the planted lines: ${f.kind} line ${f.line}\n${shown}`);
		}
		for (const [a, b] of expect.planted) {
			const hit = findings.some((f) => f.line >= a && f.line <= b);
			assert.ok(hit, `planted lines ${a}-${b} not flagged\n${shown}`);
		}
		const total = findings.reduce((s, f) => s + f.delta.steps, 0);
		assert.ok(total > 0, 'a planted slowdown costs more steps');
		const md = render_markdown(d);
		assert.ok(md.includes('lib.ts'));

		if (expect.elided) {
			// Shown as est >> real on the PR side, and not a regression in the diff.
			const bytes = pr.cases[0].measure?.bytes;
			assert.ok(bytes, 'real bytes measured');
			const fn = bytes.functions.find((f) => f.elided);
			assert.ok(fn, `an elided function: ${JSON.stringify(bytes.functions)}`);
			assert.ok(fn.estimated > 4 * fn.real, `estimated ${fn.estimated} B, real ${fn.real} B`);
			for (const [a, b] of expect.elided) {
				assert.ok(
					fn.lines.some((l) => l >= a && l <= b),
					`elided lines ${fn.lines}`
				);
			}
			assert.ok(
				findings.every((f) => f.elided),
				`a finding is not marked elided:\n${shown}`
			);
			// Elision qualifies the bytes; the steps the new allocation costs still show.
			assert.ok(!md.includes('No function changed'), md);
			assert.ok(md.includes(`+${total.toLocaleString('en-US')} (`), md);
			assert.ok(md.includes('B (elided)'), md);
			assert.ok(md.includes('Allocations the engine elides'), md);
		}
		if (expect.leak !== undefined) {
			const leak = pr.cases[0].measure?.leak;
			assert.ok(leak, 'leak check ran');
			assert.equal(base.cases[0].measure?.leak?.leaked, false, 'the base does not leak');
			if (expect.leak === null) {
				assert.equal(leak.leaked, false, JSON.stringify(leak));
				assert.equal(d.measure?.leaks.length, 0);
			} else {
				assert.equal(leak.leaked, true, JSON.stringify(leak));
				assert.deepEqual(leak.source, expect.leak);
				assert.equal(d.measure?.leaks.length, 1);
				assert.ok(md.includes('**Leaks**') && md.includes(`\`${expect.leak.variable}\``), md);
			}
		}
	});
}
