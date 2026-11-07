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
import { temp_dir, write_files } from './helpers.ts';

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

// A CommonJS package as TypeScript compiles one: getters re-export a file it requires, which
// keeps a module-level call counter (fresh module state must reset it every run).
const CJS_PROJECT: Record<string, string> = {
	'package.json': JSON.stringify({ type: 'module' }),
	'node_modules/tally/package.json': JSON.stringify({
		name: 'tally',
		version: '2.3.4',
		main: 'index.js'
	}),
	'node_modules/tally/index.js': `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.labels = exports.total = void 0;
var impl_1 = require("./lib/impl.js");
Object.defineProperty(exports, "total", { enumerable: true, get: function () { return impl_1.total; } });
Object.defineProperty(exports, "labels", { enumerable: true, get: function () { return impl_1.labels; } });
`,
	'node_modules/tally/lib/impl.js': `'use strict';
let calls = 0;
function scale(x) {
	return x * 2;
}
exports.total = function total(xs) {
	calls++;
	for (let i = 0; i < calls; i++) {}
	let s = 0;
	for (const x of xs) s += scale(x);
	return s;
};
exports.labels = (xs) => xs?.map((x) => 'n' + x).join(',');
`,
	'lib.ts': `import { labels, total } from 'tally';

export function report(xs: number[]): string {
	return labels(xs) + '=' + total(xs);
}
`,
	'lib.bench.ts': `import { bench } from ${JSON.stringify(fileURLToPath(new URL('../src/bench.ts', import.meta.url)))};
import { report } from './lib.ts';

bench('report: ten numbers', ({ xs }) => report(xs), {
	setup: () => ({ xs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })
});
`
};

async function count_in(root: string, extra: string[] = []): Promise<Report> {
	const out = join(root, 'report.json');
	await run(process.execPath, [
		'--no-warnings',
		CLI,
		'run',
		join(root, 'lib.bench.ts'),
		'--root',
		root,
		'--out',
		out,
		...extra
	]);
	return JSON.parse(readFileSync(out, 'utf8')) as Report;
}

test('a CommonJS dependency is counted like an ES module and blamed under its name and version', async () => {
	const flat = temp_dir('heisenbench-cjs-');
	write_files(flat, CJS_PROJECT);
	const c = (await count_in(flat)).cases[0];
	assert.equal(c.error, null);
	// its module counter starts at 0 every run: fresh module state reaches CommonJS too
	assert.equal(c.stable, true);
	const by = (id: string) => c.functions.find((f) => f.id === id);
	const total = by('tally@2.3.4/lib/impl.js > total');
	assert.ok(total, `functions: ${c.functions.map((f) => f.id).join(', ')}`);
	assert.equal(total.calls, 1);
	assert.equal(by('tally@2.3.4/lib/impl.js > scale')?.calls, 10);
	assert.equal(total.line, 6);
	// built-ins it calls are charged on its lines, inside an optional chain too
	const labels = by('tally@2.3.4/lib/impl.js > labels')!;
	assert.deepEqual(
		labels.builtins.map((b) => [b.name, b.line]),
		[
			['map', 13],
			['join', 13]
		]
	);
	assert.equal(
		c.edges.find((e) => e.from === 'lib.ts > report' && e.to === 'tally@2.3.4/lib/impl.js > total')
			?.count,
		1
	);
	assert.match(package_shares(c.functions), /tally@2\.3\.4/);
	// one shared copy for every run: the counter makes two identical runs differ
	assert.equal((await count_in(flat, ['--state', 'shared'])).cases[0].stable, false);
	// `--deps none` leaves it uncounted, as an ES module dependency
	const none = (await count_in(flat, ['--deps', 'none'])).cases[0];
	assert.equal(none.functions.filter((f) => f.module.startsWith('tally')).length, 0);

	// The same project deeper in another checkout: the same functions and the same counts.
	const deep = join(temp_dir('a-much-longer-checkout-path-'), 'nested', 'deeper');
	write_files(deep, CJS_PROJECT);
	const d = (await count_in(deep)).cases[0];
	assert.deepEqual(
		d.functions.map((f) => [f.id, f.self_steps, f.calls]),
		c.functions.map((f) => [f.id, f.self_steps, f.calls])
	);
	assert.equal(d.totals.steps, c.totals.steps);
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
