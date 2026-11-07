import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Report } from '../src/report.ts';
import { module_id } from '../src/transform/index.ts';
import { package_shares, unversioned_module } from '../src/identity.ts';
import { temp_dir } from './helpers.ts';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/deps/', import.meta.url));
const DEVALUE = (
	JSON.parse(
		readFileSync(
			join(dirname(createRequire(join(FIXTURE, 'lib.ts')).resolve('devalue')), 'package.json'),
			'utf8'
		)
	) as { version: string }
).version;
const PKG = `devalue@${DEVALUE}`;

async function count(extra: string[]): Promise<{ report: Report; log: string }> {
	const out = join(temp_dir('heisenbench-deps-'), 'report.json');
	const r = await run(process.execPath, [
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
	return { report: JSON.parse(readFileSync(out, 'utf8')) as Report, log: r.stdout };
}

test('every dependency is counted by default and blamed under its name and version', async () => {
	const { report, log } = await count([]);
	const c = report.cases[0];
	assert.equal(c.error, null);
	assert.equal(c.stable, true);
	const dep = c.functions.filter((f) => f.module.startsWith(`${PKG}/`));
	const stringify = dep.find(
		(f) => f.module === `${PKG}/src/stringify.js` && f.path === 'stringify'
	);
	const parse = dep.find((f) => f.module === `${PKG}/src/parse.js` && f.path === 'parse');
	assert.ok(stringify, `devalue functions: ${dep.map((f) => f.id).join(', ')}`);
	assert.ok(parse);
	assert.equal(stringify.calls, 1);
	assert.ok(stringify.self_steps > 0);
	// its blocks and lines are devalue's own source lines
	assert.ok(
		stringify.blocks.some(
			(b) => b.count > 0 && b.id.startsWith(`${PKG}/src/stringify.js > stringify > block`)
		)
	);
	assert.ok(stringify.lines.every((l) => l.line >= stringify.line && l.line <= stringify.end_line));
	// the call graph crosses into the package
	const e = c.edges.find(
		(x) => x.from === 'lib.ts > round_trip' && x.to === `${PKG}/src/stringify.js > stringify`
	);
	assert.equal(e?.count, 1);
	// nested functions inside the dependency are counted too
	assert.ok(
		dep.some((f) => f.path.includes(' > ')),
		'closures inside devalue'
	);
	// the dependency's steps are part of the case total, and the log says how much of it
	const own = c.functions.filter((f) => !f.module.startsWith(`${PKG}/`));
	assert.ok(dep.reduce((s, f) => s + f.self_steps, 0) > own.reduce((s, f) => s + f.self_steps, 0));
	const shares = package_shares(c.functions);
	// devalue does nearly all of it: own code is under the 1% a share needs to be listed
	assert.match(shares, new RegExp(`^\\d+% ${PKG.replaceAll('.', '\\.')}(, \\d+% own code)?$`));
	assert.ok(log.includes(`steps (${shares})`), log);

	// a list counts only those; `none` counts the project alone
	const listed = (await count(['--deps', 'devalue'])).report.cases[0];
	assert.equal(listed.totals.steps, c.totals.steps);
	const plain = (await count(['--deps', 'none'])).report.cases[0];
	assert.equal(plain.functions.filter((f) => f.module.startsWith('devalue')).length, 0);
	assert.ok(plain.totals.steps < c.totals.steps);
	assert.equal((await count(['--deps', 'other'])).report.cases[0].totals.steps, plain.totals.steps);
});

test('a dependency has the same name wherever it is installed: name@version, not its path', () => {
	const file = (root: string, ...dir: string[]): string => {
		const pkg = join(root, ...dir);
		mkdirSync(join(pkg, 'dist'), { recursive: true });
		writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'x', version: '8.15.0' }));
		writeFileSync(join(pkg, 'dist', 'acorn.mjs'), '');
		return join(pkg, 'dist', 'acorn.mjs');
	};
	const flat = temp_dir('heisenbench-flat-');
	const nested = temp_dir('a-much-longer-checkout-path-');
	const ids = [
		module_id(file(flat, 'node_modules', 'acorn'), flat),
		module_id(
			file(nested, 'deep', 'node_modules', '.pnpm', 'acorn@8.15.0', 'node_modules', 'acorn'),
			nested
		)
	];
	assert.deepEqual(ids, ['acorn@8.15.0/dist/acorn.mjs', 'acorn@8.15.0/dist/acorn.mjs']);
	const scoped = temp_dir('heisenbench-scoped-');
	assert.equal(
		module_id(file(scoped, 'node_modules', '@scope', 'p'), scoped),
		'@scope/p@8.15.0/dist/acorn.mjs'
	);
	assert.equal(unversioned_module('@scope/p@8.15.0/dist/acorn.mjs'), '@scope/p/dist/acorn.mjs');
	assert.equal(unversioned_module('packages/core/src/a.ts'), 'packages/core/src/a.ts');
});
