import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Report } from '../src/report.ts';
import { temp_dir, write_files } from './helpers.ts';

/*
 * A case counts the same whatever ran before it in the process. Here the two cases share a table
 * in module scope: with shared module state the second case would walk what the first left in it
 * (growth did, before every run started from a fresh copy). Every run of `heisenbench run` and of
 * `heisenbench growth` starts from fresh module state, so the counts are the same in either order
 * and alone. Incremental counting rests on it: a reused count must be the count of the case alone.
 */

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const API = JSON.stringify(
	pathToFileURL(fileURLToPath(new URL('../src/bench.ts', import.meta.url))).href
);

// `add` fills a table in module scope and costs the same however full it is; `total` walks it.
// Each case is stable on its own (its runs never change what it reads), yet `total` after `add`
// would walk what `add` left behind if the two shared module state.
const memo = [
	'const table: number[] = [];',
	'export function add(n: number): void {',
	'\tfor (let i = 0; i < n; i++) table.push(i);',
	'}',
	'export function total(n: number): number {',
	'\tlet s = n;',
	'\tfor (const x of table) s += x;',
	'\treturn s;',
	'}',
	''
].join('\n');

function bench_file(order: string[]): string {
	const scale = 'scale: ({ n }, k) => ({ n: n * k })';
	const cases: Record<string, string> = {
		first: `bench('first', ({ n }) => add(n), { setup: () => ({ n: 40 }), ${scale} });`,
		second: `bench('second', ({ n }) => total(n), { setup: () => ({ n: 40 }), ${scale} });`
	};
	return [
		`import { bench } from ${API};`,
		`import { add, total } from '../src/memo.ts';`,
		'',
		...order.map((n) => cases[n]),
		''
	].join('\n');
}

function count(
	dir: string,
	cmd: 'run' | 'growth',
	file: string,
	filter?: string
): Map<string, string> {
	const out = join(dir, `${cmd}-${Math.random().toString(36).slice(2)}.json`);
	const r = spawnSync(
		process.execPath,
		[
			'--no-warnings',
			CLI,
			cmd,
			file,
			'--root',
			dir,
			'--out',
			out,
			...(cmd === 'growth' ? ['--scaled', 'on', '--sizes', '1,4,16'] : []),
			...(filter ? ['--filter', filter] : [])
		],
		{ cwd: dir, encoding: 'utf8' }
	);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const report = JSON.parse(readFileSync(out, 'utf8')) as Report;
	const got = new Map<string, string>();
	if (cmd === 'run') for (const c of report.cases) got.set(c.name, String(c.totals.steps));
	else for (const g of report.growth!.cases) got.set(g.name, g.steps.join(' / '));
	return got;
}

for (const cmd of ['run', 'growth'] as const) {
	test(`${cmd}: a case counts the same in either order and alone, past a table in module scope`, () => {
		const dir = temp_dir('heisenbench-order-');
		write_files(dir, {
			'package.json': JSON.stringify({ type: 'module' }),
			'src/memo.ts': memo,
			'bench/ab.bench.ts': bench_file(['first', 'second']),
			'bench/ba.bench.ts': bench_file(['second', 'first'])
		});
		const ab = count(dir, cmd, 'bench/ab.bench.ts');
		const ba = count(dir, cmd, 'bench/ba.bench.ts');
		for (const name of ['first', 'second']) {
			const alone = count(dir, cmd, 'bench/ab.bench.ts', name).get(name);
			assert.ok(alone && alone !== '0', `${name} counted`);
			assert.equal(ab.get(name), alone, `${name} after the other case`);
			assert.equal(ba.get(name), alone, `${name} before the other case`);
		}
	});
}
