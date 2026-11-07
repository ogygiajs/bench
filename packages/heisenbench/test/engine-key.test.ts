import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { git_diff } from '../src/diff/git.ts';
import { diff_engine, render_engine_markdown } from '../src/engine/diff.ts';
import type { EngineFinding } from '../src/engine/diff.ts';
import type { EngineReport } from '../src/engine/types.ts';
import type { Report } from '../src/report.ts';
import { temp_dir } from './helpers.ts';

/*
 * The engine-health answer key (spec 5 + 12): fixture commits that plant a shape change V8 pays
 * for (properties in another order, an int field that becomes a double, `delete`) or an inline
 * cache that goes megamorphic, each with a twin that changes the same line without changing any
 * shape, plus plain no-ops (rename, comments). Both sides are measured by `heisenbench health` in separate
 * checkouts and diffed through git. Heisenbench must flag exactly the planted ones.
 *
 * expect.json: `flags` must each be matched by a finding; every finding must match `flags` or
 * `allow` (a planted shape change may also show in the function that builds the objects).
 */

const run = promisify(execFile);
const KEY = fileURLToPath(new URL('./engine-key/', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const BENCH_API = fileURLToPath(new URL('../src/bench.ts', import.meta.url));

interface Rule {
	kind?: string;
	function: string;
	lines?: [number, number];
}

interface Expect {
	what: string;
	flags: Rule[];
	allow?: Rule[];
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
		{ cwd, encoding: 'utf8' }
	).trim();
}

async function measure(dir: string): Promise<EngineReport> {
	await run(process.execPath, ['--no-warnings', CLI, 'health', 'lib.bench.ts', '--root', dir], {
		cwd: dir
	});
	const report = JSON.parse(readFileSync(join(dir, 'heisenbench-report.json'), 'utf8')) as Report;
	return report.engine!;
}

function matches(f: EngineFinding, r: Rule): boolean {
	if (r.function !== f.function) return false;
	if (r.kind && r.kind !== f.kind) return false;
	if (r.lines && (f.line < r.lines[0] || f.line > r.lines[1])) return false;
	return true;
}

const tmp = temp_dir('heisenbench-engine-key-');
let base_report: Promise<EngineReport> | null = null;

function base(): Promise<EngineReport> {
	if (!base_report) {
		const dir = join(tmp, 'base');
		write_all(dir, files_of(join(KEY, 'base')));
		base_report = measure(dir);
	}
	return base_report;
}

test('engine health: the base is stable and optimized', async () => {
	const b = await base();
	const c = b.cases[0];
	assert.equal(c.error, null);
	assert.equal(c.stable, true, 'two runs of the child decode to the same result');
	const ids = c.functions.map((f) => f.path).sort();
	assert.deepEqual(ids, ['label_len', 'make_items', 'make_rows', 'run', 'total']);
	assert.ok(
		c.functions.every((f) => f.optimized),
		c.functions.map((f) => `${f.path}: ${f.tier}`).join(', ')
	);
	assert.ok(c.sites.every((s) => s.state === 'monomorphic'));
	assert.ok(c.functions.every((f) => f.deopts.length === 0));
});

for (const name of readdirSync(KEY).filter((d) => d !== 'base')) {
	test(`engine answer key: ${name}`, async () => {
		const expect = JSON.parse(readFileSync(join(KEY, name, 'expect.json'), 'utf8')) as Expect;
		const repo = join(tmp, name, 'repo');
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

		const pr_dir = join(tmp, name, 'pr');
		write_all(pr_dir, pr_files);
		const [b, p] = await Promise.all([base(), measure(pr_dir)]);
		assert.equal(p.cases[0].error, null);
		assert.equal(p.cases[0].stable, true, 'the PR side is stable');

		const d = diff_engine(b, p, { files: git_diff(repo, base_sha, pr_sha) });
		const shown = d.findings.map((f) => `${f.kind} ${f.function}:${f.line} ${f.text}`).join('\n');
		assert.deepEqual(d.unstable, []);
		if (expect.flags.length === 0) {
			assert.deepEqual(d.findings, [], `no-op "${expect.what}" flagged:\n${shown}`);
			assert.ok(render_engine_markdown(d).includes('No function lost optimization'));
			return;
		}
		const rules = [...expect.flags, ...(expect.allow ?? [])];
		for (const f of d.findings) {
			assert.ok(
				rules.some((r) => matches(f, r)),
				`unexpected flag: ${f.kind} ${f.function}:${f.line}\n${shown}`
			);
		}
		for (const r of expect.flags) {
			assert.ok(
				d.findings.some((f) => matches(f, r)),
				`planted ${r.kind ?? ''} in ${r.function} not flagged\n${shown}`
			);
		}
		const md = render_engine_markdown(d);
		assert.ok(md.includes('lib.ts:'), md);

		// the PR comment, through the CLI: the "Engine" part under the step table
		const { stdout } = await run(process.execPath, [
			'--no-warnings',
			CLI,
			'diff',
			join(tmp, 'base', 'heisenbench-report.json'),
			join(pr_dir, 'heisenbench-report.json'),
			'--repo',
			repo,
			'--base',
			base_sha,
			'--head',
			pr_sha
		]);
		assert.ok(stdout.includes('#### Engine'), stdout);
		for (const f of d.findings) assert.ok(stdout.includes(f.text), stdout);
	});
}
