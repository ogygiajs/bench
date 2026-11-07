import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	canonical_json,
	make_receipt,
	parse_receipt,
	receipt_hash,
	render_verify_receipt,
	verify_receipt
} from '../src/receipt/index.ts';
import type { Receipt } from '../src/receipt/index.ts';
import { integrity_of, read_tarball, tar_file } from '../src/receipt/tarball.ts';
import { depth_of, install, make_root, write_files as write_tree } from '../src/receipt/tree.ts';
import type { Report } from '../src/report.ts';
import { compare_versions, function_place, render_registry } from '../src/receipt/registry.ts';
import { temp_dir, write_files } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const OWN_PRELOAD = fileURLToPath(new URL('../src/receipt/preload.ts', import.meta.url));

/**
 * A small package: `rank` sorts by score (the counted work), `tag` keeps the keys it saw in a
 * global (state a fresh module copy does not reset: a case after another walks both keys), `where`
 * walks its own URL (work that follows the install path), and `limit` comes from a module only a
 * bundler would serve.
 */
const LIB = (cmp: string) => ({
	'package.json': JSON.stringify({
		name: 'tinyrank',
		version: '1.2.0',
		type: 'module',
		main: 'index.js'
	}),
	'index.js': [
		"import { limit } from 'virtual:tinyrank/limit';",
		'export function rank(rows) {',
		'\tconst out = rows.slice();',
		`\tout.sort((a, b) => b.score ${cmp} a.score);`,
		'\treturn out.slice(0, limit);',
		'}',
		'export function tag(key) {',
		'\tconst seen = (globalThis.__tinyrank_seen ??= new Set());',
		'\tseen.add(key);',
		'\tlet n = 0;',
		'\tfor (const k of seen) n += k.length;',
		'\treturn n;',
		'}',
		'export function where() {',
		'\tlet n = 0;',
		'\tfor (const ch of import.meta.url) if (ch === "/") n++;',
		'\treturn n;',
		'}',
		''
	].join('\n')
});

const BENCH = [
	"import { bench } from 'heisenbench/bench';",
	"import { rank, tag, where } from 'tinyrank';",
	'',
	'const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: i, score: (i * 7919) % 101 }));',
	'',
	"bench('rank: forty rows', ({ xs }) => rank(xs), {",
	'\tsetup: () => ({ xs: rows(40) }),',
	'\tscale: (_ctx, k) => ({ xs: rows(40 * k) })',
	'});',
	"bench('tag: alpha', () => tag('alpha'));",
	"bench('tag: beta', () => tag('beta'));",
	"bench('where: the install path', () => where());",
	''
].join('\n');

const PRELOAD = [
	"import { registerHooks } from 'node:module';",
	"const STUB = new URL('./limit.js', import.meta.url).href;",
	'registerHooks({',
	'\tresolve(specifier, context, next) {',
	"\t\tif (specifier === 'virtual:tinyrank/limit') return { url: STUB, shortCircuit: true };",
	'\t\treturn next(specifier, context);',
	'\t}',
	'});',
	''
].join('\n');

/** `npm pack` of the package in `dir` with `rank`'s comparison written as `cmp`; the tarball's path. */
function pack(dir: string, cmp: string): string {
	write_files(dir, LIB(cmp));
	const before = new Set(readdirSync(dir));
	const r = spawnSync('npm', ['pack', '--silent'], { cwd: dir, encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	const made = readdirSync(dir).find((f) => f.endsWith('.tgz') && !before.has(f))!;
	const out = join(dir, `${cmp === '-' ? 'release' : 'changed'}.tgz`);
	writeFileSync(out, readFileSync(join(dir, made)));
	return out;
}

let made: { dir: string; release: string; changed: string; receipt: Receipt } | null = null;

async function fixture(): Promise<NonNullable<typeof made>> {
	if (made) return made;
	const dir = temp_dir('heisenbench-receipt-test-');
	const release = pack(join(dir, 'lib'), '-');
	// one character: `b.score - a.score` becomes `b.score + a.score`
	const changed = pack(join(dir, 'lib-changed'), '+');
	const proj = join(dir, 'project');
	write_files(proj, {
		'bench/rank.bench.ts': BENCH,
		'bench/preload.ts': PRELOAD,
		'bench/limit.js': 'export const limit = 10;\n'
	});
	const receipt = await make_receipt({
		package: release,
		bench: [join(proj, 'bench/rank.bench.ts')],
		include: [join(proj, 'bench/limit.js')],
		preload: [join(proj, 'bench/preload.ts')],
		root: proj,
		npm: false,
		work: join(dir, 'work')
	});
	made = { dir, release, changed, receipt };
	return made;
}

test('a tarball says its name, version and npm integrity', async () => {
	const { release } = await fixture();
	const t = read_tarball(release);
	assert.equal(t.name, 'tinyrank');
	assert.equal(t.version, '1.2.0');
	assert.equal(t.integrity, integrity_of(readFileSync(release)));
	assert.match(t.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
	assert.match(
		tar_file(readFileSync(release), 'index.js')!.toString('utf8'),
		/export function rank/
	);
	assert.equal(tar_file(readFileSync(release), 'missing.js'), null);
});

test('a receipt holds the package, the lockfile, the bench files, the engine, Node and every count', async () => {
	const { receipt } = await fixture();
	assert.equal(receipt.package.name, 'tinyrank');
	assert.equal(receipt.package.npm, 'not checked');
	assert.ok(receipt.install.lockfile.packages?.['node_modules/tinyrank']);
	assert.deepEqual(
		receipt.bench.files.map((f) => f.path),
		['bench/rank.bench.ts', 'bench/limit.js', 'bench/preload.ts']
	);
	assert.deepEqual(receipt.counting.preload, ['bench/preload.ts']);
	assert.equal(receipt.counting.isolation, 'process per case');
	assert.equal(receipt.engine.name, 'heisenbench');
	assert.match(receipt.engine.hash, /^[0-9a-f]{64}$/);
	assert.equal(receipt.node.version, process.version);
	assert.deepEqual(
		receipt.cases.map((c) => c.name),
		['rank: forty rows', 'tag: alpha', 'tag: beta', 'where: the install path']
	);
	const rank = receipt.cases[0];
	assert.ok(rank.totals.steps > 0);
	assert.ok(rank.functions.some((f) => f.id === 'tinyrank@1.2.0/index.js > rank'));
	assert.equal(receipt.growth.length, 1);
	assert.equal(receipt.growth[0].name, 'rank: forty rows');
	assert.equal(receipt.hash, receipt_hash(receipt));
});

test('each case counts alone: state an earlier case left in a global does not reach it', async () => {
	const { dir, release, receipt } = await fixture();
	const steps = (cases: ReadonlyArray<{ name: string; totals: { steps: number } }>, name: string) =>
		cases.find((c) => c.name === name)!.totals.steps;
	// each in a process of its own: both walk one key
	assert.equal(steps(receipt.cases, 'tag: beta'), steps(receipt.cases, 'tag: alpha'));

	// the same tree counted by one `heisenbench run`: beta walks alpha's key too
	const root = make_root(200, 16, join(dir, 'shared'));
	write_tree(root, receipt.bench.files);
	await install(root, read_tarball(release));
	const out = join(dir, 'shared.json');
	const imports = [OWN_PRELOAD, join(root, 'bench/preload.ts')].map(
		(f) => `--import=${pathToFileURL(f).href}`
	);
	const r = spawnSync(
		process.execPath,
		[...imports, CLI, 'run', 'bench/rank.bench.ts', '--out', out],
		{ cwd: root, encoding: 'utf8', timeout: 300_000 }
	);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const shared = (JSON.parse(readFileSync(out, 'utf8')) as Report).cases;
	assert.equal(steps(shared, 'tag: alpha'), steps(receipt.cases, 'tag: alpha'));
	assert.ok(steps(shared, 'tag: beta') > steps(shared, 'tag: alpha'));
});

test('the receipt verifies against its tarball, from another work directory', async () => {
	const { dir, release, receipt } = await fixture();
	// a longer, deeper work path: the root is padded to the receipt's length and depth, so `where`
	// (one step per `/` of its own URL) counts the same
	const r = await verify_receipt(receipt, { tarball: release, work: join(dir, 'another', 'work') });
	assert.equal(r.matches, true, render_verify_receipt(r));
	assert.equal(r.first_difference, null);
	assert.match(render_verify_receipt(r), /\nmatches$/);
});

test('one changed character in the tarball fails the check and names the first case', async () => {
	const { changed, receipt } = await fixture();
	const r = await verify_receipt(receipt, { tarball: changed });
	assert.equal(r.matches, false);
	const tarball = r.checks.find((c) => c.what === 'tarball')!;
	assert.equal(tarball.ok, false);
	assert.match(tarball.text, /is not the receipt's tarball/);
	assert.match(r.first_difference ?? '', /^case "rank: forty rows" \(bench\/rank\.bench\.ts\): /);
	assert.ok(r.differing.cases >= 1);
	assert.equal(r.differing.cases < r.differing.of, true, 'the case that never sorts still matches');
});

test('a receipt edited after it was made fails its hash', async () => {
	const { release, receipt } = await fixture();
	const edited = structuredClone(receipt);
	edited.cases[0].totals.steps -= 1;
	const r = await verify_receipt(edited, { tarball: release });
	assert.equal(r.matches, false);
	assert.equal(r.checks[0].what, 'receipt');
	assert.equal(r.checks[0].ok, false);
	assert.match(r.first_difference ?? '', /case "rank: forty rows".*totals\.steps/);
});

test('verify-receipt from the command line: exit 0 and "matches", exit 1 and the difference', async () => {
	const { dir, release, changed, receipt } = await fixture();
	const file = join(dir, 'receipt.json');
	writeFileSync(file, JSON.stringify(receipt, null, '\t'));
	assert.equal(parse_receipt(readFileSync(file, 'utf8'), file).hash, receipt.hash);
	const ok = spawnSync(process.execPath, [CLI, 'verify-receipt', file, release], {
		encoding: 'utf8',
		timeout: 300_000
	});
	assert.equal(ok.status, 0, ok.stdout + ok.stderr);
	assert.match(ok.stdout, /\nmatches\n/);
	const bad = spawnSync(process.execPath, [CLI, 'verify-receipt', file, changed], {
		encoding: 'utf8',
		timeout: 300_000
	});
	assert.equal(bad.status, 1, bad.stdout + bad.stderr);
	assert.match(bad.stdout, /differs: case "rank: forty rows"/);
});

test('canonical JSON does not depend on key order', () => {
	assert.equal(canonical_json({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
	assert.equal(canonical_json({ a: undefined, b: null }), '{"b":null}');
});

test('the counting root has the same length and depth under any work directory', () => {
	const dir = temp_dir('heisenbench-root-');
	for (const work of [join(dir, 'a'), join(dir, 'a', 'much', 'longer', 'path')]) {
		const root = make_root(200, 16, work);
		assert.equal(root.length, 200);
		assert.equal(depth_of(root), 16);
	}
	assert.throws(() => make_root(20, 16, dir), /too long or too deep/);
	assert.throws(() => make_root(200, 2, dir), /too long or too deep/);
});

test('versions sort in release order and functions pair across versions by place', () => {
	assert.deepEqual(['1.10.0', '1.2.0', '1.2.0-next.1', '0.9.9'].sort(compare_versions), [
		'0.9.9',
		'1.2.0-next.1',
		'1.2.0',
		'1.10.0'
	]);
	assert.equal(
		function_place('acorn@8.15.0/dist/acorn.mjs > Parser > parse~3fa9c2'),
		function_place('acorn@8.16.1/dist/acorn.mjs > Parser > parse~09bb1d')
	);
});

test('the registry page renders from two receipts', async () => {
	const { receipt } = await fixture();
	const next = structuredClone(receipt);
	next.package.version = '1.3.0';
	next.cases[0].totals.steps = Math.round(receipt.cases[0].totals.steps * 1.25);
	const html = render_registry([next, receipt]);
	assert.match(html, /^<!doctype html>/);
	assert.match(html, /<title>Heisenbench Registry<\/title>/);
	assert.ok(html.indexOf('>1.2.0<') < html.indexOf('>1.3.0<'), 'versions in release order');
	assert.match(html, /\+25\.0%/);
	assert.match(html, /tinyrank@1\.2\.0/);
	assert.match(html, /tinyrank@1\.3\.0/);
	assert.match(html, /rank: forty rows/);
	assert.match(html, /tinyrank\/index\.js &gt; rank/);
	// a second package with a case of the same name lines up with it
	const other = structuredClone(receipt);
	other.package.name = 'otherrank';
	other.cases[0].totals.steps = receipt.cases[0].totals.steps * 2;
	const both = render_registry([receipt, other]);
	assert.match(both, /otherrank@1\.2\.0/);
	assert.match(both, /2\.00×/);
});
