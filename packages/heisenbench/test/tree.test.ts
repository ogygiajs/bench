import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Report } from '../src/report.ts';
import { BENCH_API, CLI } from '../src/verify/fixture.ts';
import { temp_dir, write_files } from './helpers.ts';

const run = promisify(execFile);

/*
 * A count is of the files on disk. Two checkouts of one commit count differently when one of them
 * has uncommitted changes (a mutation run applies its mutants in place): the report says so, so
 * the difference is never read as Heisenbench's.
 */

function repo(): string {
	const root = temp_dir('hb-tree-');
	write_files(root, {
		'package.json': JSON.stringify({ name: 'tree', private: true, type: 'module' }),
		'README.md': 'a project\n',
		'src/lib.ts': 'export function add(a: number, b: number): number {\n\treturn a + b;\n}\n',
		'src/unused.ts': 'export const x = 1;\n',
		'bench/lib.bench.ts': `import { bench } from '${BENCH_API}';\nimport { add } from '../src/lib.ts';\n\nbench('add', () => add(1, 2));\n`
	});
	const git = (...args: string[]) =>
		execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
			cwd: root,
			stdio: 'ignore'
		});
	git('init', '-q');
	git('add', '.');
	git('commit', '-q', '-m', 'one');
	return root;
}

async function count(root: string): Promise<{ report: Report; out: string }> {
	const out = join(root, 'heisenbench-report.json');
	const r = await run(process.execPath, ['--no-warnings', CLI, 'run', 'bench/lib.bench.ts', '--root', root, '--out', out], {
		cwd: root
	});
	return { report: JSON.parse(readFileSync(out, 'utf8')) as Report, out: r.stdout + r.stderr };
}

test('a report of a clean checkout names no changed files', async () => {
	const { report, out } = await count(repo());
	assert.equal(report.git.changed, undefined);
	assert.doesNotMatch(out, /uncommitted/);
});

test('a report names the counted files that differ from its commit, and says so', async () => {
	const root = repo();
	writeFileSync(join(root, 'src/lib.ts'), 'export function add(a: number, b: number): number {\n\treturn b + a;\n}\n');
	writeFileSync(join(root, 'src/unused.ts'), 'export const x = 2;\n');
	writeFileSync(join(root, 'README.md'), 'changed\n');
	write_files(root, { 'src/new.ts': 'export const y = 1;\n' });
	const { report, out } = await count(root);
	assert.deepEqual(report.git.changed, ['src/lib.ts'], 'only what the run loaded');
	assert.match(out, /uncommitted changes to src\/lib\.ts/);
});

test('a counted file git does not track yet is a change too', async () => {
	const root = repo();
	write_files(root, {
		'src/extra.ts': 'export const one = 1;\n',
		'bench/extra.bench.ts': `import { bench } from '${BENCH_API}';\nimport { one } from '../src/extra.ts';\n\nbench('one', () => one + 1);\n`
	});
	const outp = join(root, 'r.json');
	await run(process.execPath, ['--no-warnings', CLI, 'run', 'bench/extra.bench.ts', '--root', root, '--out', outp], { cwd: root });
	const report = JSON.parse(readFileSync(outp, 'utf8')) as Report;
	assert.deepEqual(report.git.changed, ['bench/extra.bench.ts', 'src/extra.ts']);
});
