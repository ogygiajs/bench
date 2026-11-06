import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Report } from '../src/report.ts';
import { temp_dir } from './helpers.ts';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/deps/', import.meta.url));

async function count(extra: string[]): Promise<Report> {
	const out = join(temp_dir('abax-deps-'), 'report.json');
	await run(process.execPath, [
		'--no-warnings',
		CLI,
		'run',
		join(FIXTURE, 'lib.bench.ts'),
		'--root',
		FIXTURE,
		'--out',
		out,
		...extra
	]);
	return JSON.parse(readFileSync(out, 'utf8')) as Report;
}

test('--deps instruments a real dependency and blames its blocks under the package name', async () => {
	const report = await count(['--deps', 'devalue']);
	const c = report.cases[0];
	assert.equal(c.error, null);
	assert.equal(c.stable, true);
	const dep = c.functions.filter((f) => f.module.startsWith('devalue/'));
	const stringify = dep.find(
		(f) => f.module === 'devalue/src/stringify.js' && f.path === 'stringify'
	);
	const parse = dep.find((f) => f.module === 'devalue/src/parse.js' && f.path === 'parse');
	assert.ok(stringify, `devalue functions: ${dep.map((f) => f.id).join(', ')}`);
	assert.ok(parse);
	assert.equal(stringify.calls, 1);
	assert.ok(stringify.self_steps > 0);
	// its blocks and lines are devalue's own source lines
	assert.ok(
		stringify.blocks.some(
			(b) => b.count > 0 && b.id.startsWith('devalue/src/stringify.js > stringify > block')
		)
	);
	assert.ok(stringify.lines.every((l) => l.line >= stringify.line && l.line <= stringify.end_line));
	// the call graph crosses into the package
	const e = c.edges.find(
		(x) => x.from === 'lib.ts > round_trip' && x.to === 'devalue/src/stringify.js > stringify'
	);
	assert.equal(e?.count, 1);
	// nested functions inside the dependency are counted too
	assert.ok(
		dep.some((f) => f.path.includes(' > ')),
		'closures inside devalue'
	);
	// the dependency's steps are part of the case total
	const own = c.functions.filter((f) => !f.module.startsWith('devalue/'));
	assert.ok(dep.reduce((s, f) => s + f.self_steps, 0) > own.reduce((s, f) => s + f.self_steps, 0));

	const plain = (await count([])).cases[0];
	assert.equal(plain.functions.filter((f) => f.module.startsWith('devalue/')).length, 0);
	assert.ok(plain.totals.steps < c.totals.steps);
});
