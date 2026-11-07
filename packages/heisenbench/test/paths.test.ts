import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CaseReport, Report } from '../src/report.ts';
import { drop_generation, real_url, virtual_text, virtual_url } from '../src/runtime/paths.ts';
import { VIRTUAL_ROOT } from '../src/runtime/determinism.ts';
import { virtualize_meta } from '../src/transform/meta.ts';
import { BENCH_API, CLI, KEYS, key_files } from '../src/verify/fixture.ts';
import type { Files } from '../src/verify/fixture.ts';
import { temp_dir, write_files } from './helpers.ts';

const run = promisify(execFile);

/** Three roots: a short one, a long and deep one, and one with unicode and spaces. */
function three_roots(tag: string): string[] {
	const short = temp_dir(`hb-${tag}-`);
	const long = join(
		temp_dir(`a-much-longer-checkout-path-${tag}-${'x'.repeat(60)}-`),
		'nested',
		'deeper',
		'still',
		'deeper'
	);
	const odd = join(temp_dir(`hb-${tag}-`), 'ünï cødé', 'with spaces', 'prøjéct ü');
	for (const r of [long, odd]) mkdirSync(r, { recursive: true });
	return [short, long, odd];
}

async function count(root: string, bench: string, command = 'run'): Promise<Report> {
	const out = join(root, 'heisenbench-report.json');
	await run(
		process.execPath,
		['--no-warnings', CLI, command, bench, '--root', root, '--out', out],
		{
			cwd: root,
			maxBuffer: 1 << 26
		}
	);
	return JSON.parse(readFileSync(out, 'utf8')) as Report;
}

/** Everything a case report says about the work: steps, units, bytes, allocations, lines. */
function work(cases: readonly CaseReport[]): unknown {
	return cases.map((c) => ({ ...c }));
}

/*
 * A module that reads its own location every way a module can, and does per-character and
 * per-part work on what it read: the count follows the length of every path it sees. It checks
 * that each one names the virtual root (a case that throws fails the test with what it saw).
 */
const WHERE = `import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tally } from './tally.cjs';

const HERE = import.meta.url;
const require = createRequire(import.meta.url);
const RESOLVED = require.resolve('./data.json');
const REQUIRED = require('./data.json').n;
const META_RESOLVED = import.meta.resolve('./data.json');
const TOP_READ = readFileSync(new URL('./data.json', import.meta.url), 'utf8');
const TOP_CWD = process.cwd();
const TOP_REL = relative(process.cwd(), fileURLToPath(import.meta.url));

function expect(what, value, want) {
	if (!value.startsWith(want)) throw new Error(what + ' is ' + value);
}

export function where(from_bench) {
	const url = import.meta.url;
	expect('import.meta.url', url, 'file:///heisenbench/root/src/where.ts');
	if (url !== 'file:///heisenbench/root/src/where.ts') throw new Error('the query stayed: ' + url);
	expect('import.meta.filename', import.meta.filename, '/heisenbench/root/src/');
	expect('import.meta.dirname', import.meta.dirname, '/heisenbench/root/src');
	expect('import.meta.resolve', META_RESOLVED, 'file:///heisenbench/root/src/data.json');
	expect('require.resolve', RESOLVED, '/heisenbench/root/src/data.json');
	expect('process.cwd at the top', TOP_CWD, '/heisenbench/root');
	expect('process.cwd', process.cwd(), '/heisenbench/root');
	expect('the bench file', from_bench, 'file:///heisenbench/root/');
	if (TOP_REL !== join('src', 'where.ts')) throw new Error('relative to the cwd: ' + TOP_REL);
	let n = 0;
	n += url.length + HERE.split('/').length;
	n += url.replace(/\\//g, '\\\\').length;
	const m = url.match(/[a-z]+/g);
	n += m ? m.length : 0;
	n += [url, HERE, from_bench].join('|').length;
	const file = fileURLToPath(url);
	n += file.split(sep).join('/').length;
	n += dirname(file).length + basename(file).length;
	n += import.meta.filename.length + import.meta.dirname.length + META_RESOLVED.length;
	n += pathToFileURL(join(dirname(file), 'data.json')).href.length;
	n += JSON.stringify({ url, file }).length;
	n += readFileSync(join(import.meta.dirname, 'data.json'), 'utf8').length + TOP_READ.length;
	n += REQUIRED + RESOLVED.length + RESOLVED.split(sep).length;
	n += relative(process.cwd(), file).length + process.cwd().length;
	const stack = new Error('x').stack ?? '';
	const frame = stack.split('\\n')[1];
	expect('a stack frame', frame.slice(frame.indexOf('(') + 1), 'file:///heisenbench/root/src/where.ts:');
	n += frame.length;
	try {
		readFileSync(join(import.meta.dirname, 'missing.json'));
	} catch (e) {
		if (!e.message.includes('/heisenbench/root/src/missing.json')) throw new Error('fs said ' + e.message);
		n += e.message.length;
	}
	n += \`\${url}#\${n}\`.length;
	for (const ch of url) if (ch === '/') n++;
	n += url.toUpperCase().length + url.indexOf('src') + url.lastIndexOf('/');
	return n + tally();
}
`;

const TALLY = `const { sep } = require('node:path');
const RESOLVED = require.resolve('./data.json');
exports.tally = function tally() {
	if (!__filename.startsWith('/heisenbench/root/src/')) throw new Error('__filename is ' + __filename);
	if (__dirname !== '/heisenbench/root/src') throw new Error('__dirname is ' + __dirname);
	if (RESOLVED !== '/heisenbench/root/src/data.json') throw new Error('require.resolve: ' + RESOLVED);
	const frame = new Error('y').stack.split('\\n')[1];
	if (!frame.includes('/heisenbench/root/src/tally.cjs:')) throw new Error('a stack frame: ' + frame);
	return __filename.split(sep).length + __dirname.replace(/o/g, '0').length + frame.length + RESOLVED.length;
};
`;

const BENCH = `import { bench } from '${BENCH_API}';
import { where } from './src/where.ts';

const HERE = import.meta.url;

bench('where the code is', () => where(HERE));
`;

test('a module that reads its own paths counts the same at any root: short, deep, unicode, spaces', async () => {
	const roots = three_roots('where');
	const reports: Report[] = [];
	for (const root of roots) {
		write_files(root, {
			'package.json': JSON.stringify({ name: 'where', private: true, type: 'module' }),
			'src/where.ts': WHERE,
			'src/tally.cjs': TALLY,
			'src/data.json': '{"n":1}\n',
			'where.bench.ts': BENCH
		});
		const r = await count(root, 'where.bench.ts');
		const c = r.cases[0];
		assert.equal(c.error, null, `${root}: ${c.error}`);
		assert.equal(c.stable, true);
		reports.push(r);
	}
	const [a, b, c] = reports.map((r) => r.cases);
	assert.ok(a[0].totals.steps > 0);
	assert.ok(a[0].functions.some((f) => f.module === 'src/tally.cjs'));
	assert.deepEqual(work(b), work(a), 'a long, deep root counts what a short one does');
	assert.deepEqual(work(c), work(a), 'unicode and spaces in the root count the same');
});

/** Every planted change of every answer key `heisenbench verify` counts (base and each variant). */
function key_projects(): Array<{ name: string; files: Files }> {
	const out: Array<{ name: string; files: Files }> = [];
	for (const key of readdirSync(KEYS).filter((d) => d.endsWith('-key'))) {
		if (!existsSync(join(KEYS, key, 'base', 'lib.bench.ts.txt'))) continue;
		// the app key's module is a package's server (verify/app.ts)
		const lib = key === 'app-key' ? 'packages/fakekit/src/server.js' : 'lib.ts';
		for (const variant of readdirSync(join(KEYS, key)).sort())
			if (existsSync(join(KEYS, key, variant, 'lib.ts.txt')))
				out.push({ name: `${key}/${variant}`, files: key_files(key, variant, lib) });
	}
	return out;
}

test('every answer key counts the same at three roots', async () => {
	const projects = key_projects();
	assert.ok(projects.length >= 20, `${projects.length} answer-key projects`);
	const roots = three_roots('keys');
	const differ: string[] = [];
	let next = 0;
	const lane = async (): Promise<void> => {
		while (next < projects.length) {
			const p = projects[next++];
			const seen: unknown[] = [];
			for (const root of roots) {
				const dir = join(root, ...p.name.split('/'));
				write_files(dir, p.files);
				seen.push(work((await count(dir, 'lib.bench.ts')).cases));
			}
			if (JSON.stringify(seen[1]) !== JSON.stringify(seen[0])) differ.push(`${p.name} (deep)`);
			if (JSON.stringify(seen[2]) !== JSON.stringify(seen[0])) differ.push(`${p.name} (unicode)`);
		}
	};
	await Promise.all([lane(), lane(), lane(), lane()]);
	assert.deepEqual(differ, [], `projects whose counts follow the root: ${differ.join(', ')}`);
});

test('virtual paths: a real URL in the root names it virtually, without the fresh-copy query', () => {
	const root = '/work/a b/ü';
	const url = 'file:///work/a%20b/%C3%BC/src/x.ts?heisenbench_gen=12';
	assert.equal(virtual_url(url, root), 'file:///heisenbench/root/src/x.ts');
	assert.equal(
		virtual_url('file:///work/a%20b/%C3%BC/x.ts?v=1&heisenbench_gen=3', root),
		'file:///heisenbench/root/x.ts?v=1'
	);
	assert.equal(
		virtual_url('file:///elsewhere/x.ts?heisenbench_gen=3', root),
		'file:///elsewhere/x.ts'
	);
	assert.equal(drop_generation('a?heisenbench_gen=4&b=1'), 'a?b=1');
	assert.equal(
		real_url('file:///heisenbench/root/src/x.ts?q', root),
		'file:///work/a%20b/%C3%BC/src/x.ts?q'
	);
	assert.equal(real_url(`${VIRTUAL_ROOT}/src/x.ts`, root), '/work/a b/ü/src/x.ts');
	assert.equal(real_url('node:fs', root), 'node:fs');
	assert.equal(
		virtual_text(
			'Error: x\n    at f (file:///work/a%20b/%C3%BC/src/x.ts?heisenbench_gen=2:3:4)\n    at /work/a b/ü/lib.cjs:1:2',
			root
		),
		'Error: x\n    at f (file:///heisenbench/root/src/x.ts:3:4)\n    at /heisenbench/root/lib.cjs:1:2'
	);
});

test('a bench file gets the virtual import.meta without a line or column moving', () => {
	const code =
		'const a = import.meta.url;\nexport const b = import.meta.dirname + "import.meta";\n';
	const out = virtualize_meta(code, '/x/a.bench.js');
	const lines = out.split('\n');
	assert.equal(lines[0], 'const a = $hb_meta_().url;');
	assert.equal(lines[1], 'export const b = $hb_meta_().dirname + "import.meta";');
	assert.equal(virtualize_meta('export const a = 1;\n', '/x/a.js'), 'export const a = 1;\n');
});
