import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Report } from '../src/report.ts';
import { find_bumps, upgrade_diff } from '../src/upgrade/index.ts';
import type { UpgradeResult } from '../src/upgrade/index.ts';
import { headline, render_upgrade } from '../src/upgrade/markdown.ts';
import { find_package_dir, package_diffs } from '../src/upgrade/packages.ts';
import { mirror_tree, remove_tree } from '../src/blame/tree.ts';
import { draft_upstream, input_source, named_in, project_words } from '../src/upstream/index.ts';
import { import_specifier } from '../src/upstream/entry.ts';
import { to_source } from '../src/upstream/source.ts';
import { temp_dir, write_files } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/upgrade/', import.meta.url));
const BENCH_API = JSON.stringify(
	pathToFileURL(fileURLToPath(new URL('../src/bench.ts', import.meta.url))).href
);

/** The project: one case that tokenizes with the dependency, one that never calls it. */
const APP: Record<string, string> = {
	'package.json': JSON.stringify({
		name: 'quillpad-app',
		type: 'module',
		dependencies: { slowdep: 'file:../slowdep' }
	}),
	'src/words.ts': [
		"import { count_words } from 'slowdep';",
		'',
		'export function words(text: string): number {',
		'\treturn count_words(text);',
		'}',
		'',
		'export function total(xs: number[]): number {',
		'\tlet s = 0;',
		'\tfor (const x of xs) s += x;',
		'\treturn s;',
		'}',
		''
	].join('\n'),
	'words.bench.ts': [
		`import { bench } from ${BENCH_API};`,
		"import { total, words } from './src/words.ts';",
		'',
		"bench('words: a paragraph', ({ text }) => words(text), {",
		"\tsetup: () => ({ text: Array.from({ length: 40 }, (_, i) => 'w' + (i % 7)).join(' ') })",
		'});',
		"bench('total: own code only', ({ xs }) => total(xs), {",
		'\tsetup: () => ({ xs: Array.from({ length: 50 }, (_, i) => i) })',
		'});',
		''
	].join('\n')
};

/** A checkout of the app with `slowdep` at `version` installed, as `npm i --install-links` copies a file dependency. */
function checkout(dir: string, version: string): void {
	write_files(dir, APP);
	cpSync(join(FIXTURE, `slowdep-${version}`), join(dir, 'node_modules', 'slowdep'), {
		recursive: true
	});
}

function count(root: string, out: string): Report {
	const r = spawnSync(
		process.execPath,
		[CLI, 'run', 'words.bench.ts', '--root', root, '--out', out],
		{ cwd: root, encoding: 'utf8', timeout: 300_000 }
	);
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	return JSON.parse(readFileSync(out, 'utf8')) as Report;
}

let fixture: {
	base: Report;
	pr: Report;
	base_root: string;
	root: string;
	result: UpgradeResult;
} | null = null;

async function planted(): Promise<NonNullable<typeof fixture>> {
	if (fixture) return fixture;
	const dir = temp_dir('heisenbench-upgrade-');
	const base_root = join(dir, 'base');
	const root = join(dir, 'head');
	checkout(base_root, '1.0.0');
	checkout(root, '1.1.0');
	const base = count(base_root, join(dir, 'base.json'));
	const pr = count(root, join(dir, 'pr.json'));
	const result = await upgrade_diff({ base, pr, root, base_root, work: join(dir, 'work') });
	fixture = { base, pr, base_root, root, result };
	return fixture;
}

test('a bump is a package the two reports count at different versions', async () => {
	const { base, pr } = await planted();
	const b = find_bumps(base, pr);
	assert.deepEqual(b.bumps, [{ name: 'slowdep', from: '1.0.0', to: '1.1.0' }]);
	assert.deepEqual(b.added, []);
	assert.deepEqual(b.removed, []);
});

test('the planted slowdown in the dependency is placed on its line, through a moved file', async () => {
	const { result } = await planted();
	assert.equal(result.bumps.length, 1);
	assert.equal(result.bumps[0].changed_files, 3); // index.js, the moved helper, package.json
	assert.deepEqual(result.failed, []);
	assert.deepEqual(result.unexplained, []);
	assert.deepEqual(result.order_dependent, []);
	assert.equal(result.cases.length, 1, JSON.stringify(result.cases.map((c) => c.case)));
	const c = result.cases[0];
	assert.equal(c.case, 'words: a paragraph');
	assert.ok(c.delta > 0);
	const top = c.functions[0];
	assert.equal(top.module, 'slowdep@1.1.0/index.js');
	assert.equal(top.function, 'tokenize');
	assert.equal(top.old_module, 'slowdep@1.0.0/index.js');
	assert.equal(top.upstream, true);
	assert.equal(top.delta_self_steps, c.delta, 'all of the change is in tokenize');
	// the planted lines, and nothing on the lines that only moved down
	assert.deepEqual(top.lines.map((l) => [l.line, l.kind, l.upstream]).sort(), [
		[13, 'new code', true],
		[14, 'new code', true]
	]);
	// the helper moved to another file and is the same function: no change, not new or gone
	assert.ok(!c.functions.some((f) => f.function === 'is_space'));
	assert.deepEqual(c.by_package, [{ package: 'slowdep@1.1.0', delta: c.delta }]);
	assert.deepEqual(
		c.entries.slowdep.map((e) => `${e.module} > ${e.function}`),
		['slowdep@1.1.0/index.js > count_words']
	);
	const line = headline(result, c);
	assert.match(
		line,
		/^upgrading slowdep 1\.0\.0 → 1\.1\.0 makes `words: a paragraph` \*\*\+[\d.]+%\*\* \(\+\d+ steps; all in `slowdep@1\.1\.0\/index\.js > tokenize` L14(, L13)?\)$/
	);
	const md = render_upgrade(result);
	assert.match(md, /\*\*slowdep\*\* 1\.0\.0 → 1\.1\.0, 3 files changed/);
	assert.match(md, /1 more case counts them and did not change|L14 \+\d+ \(changed upstream\)/);
});

test('a case that never calls the upgraded package is a control: not recounted as the upgrade', async () => {
	const { result } = await planted();
	assert.equal(result.spent.cases, 2, 'both cases of the bench file ran on both installs');
	assert.ok(!result.cases.some((c) => c.case === 'total: own code only'));
});

test('an install found where pnpm puts it, and a package diff in module ids', () => {
	const dir = temp_dir('heisenbench-upgrade-pnpm-');
	const store = join(dir, 'node_modules', '.pnpm');
	cpSync(join(FIXTURE, 'slowdep-1.0.0'), join(store, 'slowdep@1.0.0', 'node_modules', 'slowdep'), {
		recursive: true
	});
	cpSync(
		join(FIXTURE, 'slowdep-1.1.0'),
		join(store, 'slowdep@1.1.0_abc', 'node_modules', 'slowdep'),
		{ recursive: true }
	);
	mkdirSync(join(dir, 'packages', 'a', 'node_modules'), { recursive: true });
	symlinkSync(
		join(store, 'slowdep@1.1.0_abc', 'node_modules', 'slowdep'),
		join(dir, 'packages', 'a', 'node_modules', 'slowdep')
	);
	const old_dir = find_package_dir(dir, 'slowdep', '1.0.0');
	const new_dir = find_package_dir(dir, 'slowdep', '1.1.0', ['packages/a/src/x.ts']);
	assert.ok(old_dir !== null && old_dir.endsWith('slowdep@1.0.0/node_modules/slowdep'));
	assert.ok(new_dir !== null && new_dir.endsWith('slowdep@1.1.0_abc/node_modules/slowdep'));
	assert.equal(find_package_dir(dir, 'slowdep', '2.0.0'), null);
	const files = package_diffs(old_dir, new_dir, 'slowdep@1.0.0', 'slowdep@1.1.0');
	const by = new Map(files.map((f) => [f.new_path, f]));
	assert.equal(by.get('slowdep@1.1.0/lib/space.js')?.old_path, 'slowdep@1.0.0/lib/is_space.js');
	assert.deepEqual(by.get('slowdep@1.1.0/lib/space.js')?.hunks, []);
	const index = by.get('slowdep@1.1.0/index.js')!;
	assert.equal(index.old_path, 'slowdep@1.0.0/index.js');
	assert.ok(index.hunks.some((h) => h.new_start === 13 && h.new_count === 2));
});

test('the upstream draft: a script timed on both versions, the counts on its input, the line and the change', async () => {
	const { result } = await planted();
	const d = await draft_upstream({ upgrade: result, time_ms: 20 });
	assert.match(
		d.title,
		/^`tokenize` \(index\.js\) does [\d.]+× as much work in 1\.1\.0 as in 1\.0\.0$/
	);
	assert.deepEqual(d.entry, { specifier: 'slowdep', export_name: 'count_words' });
	// the recorded paragraph, repeated: it grows, so every size runs
	assert.deepEqual(d.sizes, [1, 4, 16]);
	assert.match(d.repro, /^import \{ count_words \} from 'slowdep';$/m);
	assert.match(d.repro, /const one = "w0 w1 w2 /);
	assert.match(d.repro, /return \[one\.repeat\(n\)\];/);
	// counted on the script's input: the planted loop is quadratic, so the gap widens with n
	assert.equal(d.counts.length, 3);
	for (const c of d.counts) assert.ok(c.new_self > c.old_self && c.new_total > c.old_total);
	const ratio = (c: (typeof d.counts)[number]) => c.new_self / c.old_self;
	assert.ok(ratio(d.counts[2]) > ratio(d.counts[1]) && ratio(d.counts[1]) > ratio(d.counts[0]));
	assert.equal(d.lines[0].line, 14);
	assert.equal(d.lines[0].upstream, true);
	assert.equal(d.timings.length, 3);
	assert.ok(d.timings.every((t) => t.old_ms > 0 && t.new_ms > 0));
	assert.match(d.issue, /The gap grows with the input: /);
	assert.match(
		d.issue,
		/npm i slowdep@1\.0\.0 && node repro\.ts\nnpm i slowdep@1\.1\.0 && node repro\.ts/
	);
	assert.match(d.issue, />14 \| \t\t\t\tfor \(let j = 0; j < out\.length; j\+\+\)/);
	// the change to the function, cut to it (the header lines that moved are not part of it)
	assert.match(d.issue, /```diff\n@@ -8,6 \+10,8 @@ export function tokenize\(text\) \{\n/);
	assert.match(d.issue, /^\+\t\t\t\tlet seen = 0;$/m);
	assert.doesNotMatch(d.issue, /is_space\.js/);
	// nothing names the project
	assert.doesNotMatch(d.issue + d.repro, /quillpad/i);
	assert.doesNotMatch(
		d.issue + d.repro,
		new RegExp(result.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
	);
});

test('a draft that names the project is refused, and so is one with nothing slower to report', async () => {
	const { result, base, pr, root, base_root } = await planted();
	await assert.rejects(
		draft_upstream({ upgrade: result, time_ms: 1, redact: ['paragraph', 'count_words'] }),
		/the draft names the project \("count_words"\)/
	);
	// the other way round, the upgrade is a downgrade that makes things faster
	const back = await upgrade_diff({ base: pr, pr: base, root: base_root, base_root: root });
	assert.ok(back.cases[0].delta < 0);
	await assert.rejects(draft_upstream({ upgrade: back }), /no upgrade made a case slower/);
});

test('the words that name a project: its scopes, its package names, its git remote', () => {
	const dir = temp_dir('heisenbench-upstream-words-');
	write_files(dir, {
		'package.json': JSON.stringify({ name: 'quillpad-monorepo' }),
		'packages/web/package.json': JSON.stringify({ name: '@inkwell/web' }),
		'packages/web/src/a.ts': ''
	});
	assert.deepEqual(project_words(dir, ['packages/web/src/a.ts'], 'svelte', ['Northwind']), [
		'inkwell',
		'northwind',
		'quillpad'
	]);
	assert.equal(named_in('see Inkwell docs', ['inkwell']), 'inkwell');
	assert.equal(named_in('nothing here', ['inkwell']), null);
});

test('recorded arguments as script source: paths into the checkout cut to their file name', () => {
	const got = input_source(
		{
			args: ['<p>{a}</p>', { filename: '/work/app/src/Page.svelte', dev: false }],
			this_value: undefined
		},
		{ roots: ['/work/app'], call: 'compile' }
	);
	assert.equal(got.grows, true);
	assert.equal(
		got.source,
		[
			'/** The arguments of one call to `compile`, argument 1 repeated n times. */',
			'function input(n: number): unknown[] {',
			'\tconst one = "<p>{a}</p>";',
			'\treturn [one.repeat(n), { filename: "/repro/Page.svelte", dev: false }];',
			'}'
		].join('\n')
	);
	assert.equal(
		to_source({ a: [1, -0, NaN], m: new Map([['k', new Set([1n])]]), d: new Date(0), r: /x+/g }),
		[
			'{',
			'\ta: [1, -0, NaN],',
			'\tm: new Map([["k", new Set([1n])]]),',
			'\td: new Date("1970-01-01T00:00:00.000Z"),',
			'\tr: /x+/g',
			'}'
		].join('\n')
	);
	assert.throws(() => to_source(new (class Point {})()), /an instance of Point/);
	assert.throws(
		() =>
			input_source(
				{ args: [new (class Ctx {})()], this_value: undefined },
				{ roots: [], call: 'f' }
			),
		/hold an instance of Ctx, which a script cannot rebuild: give --input/
	);
});

test('the public specifier of a function: the export whose file it is in, or one that re-exports it', () => {
	const dir = temp_dir('heisenbench-upstream-entry-');
	write_files(dir, {
		'package.json': JSON.stringify({
			name: 'pkg',
			exports: {
				'.': { types: './index.d.ts', import: './src/index.js' },
				'./compiler': { default: './src/compiler/index.js' },
				'./package.json': './package.json'
			}
		}),
		'src/index.js': "export * from './runtime.js';\n",
		'src/runtime.js': 'export function mount() {}\n',
		'src/compiler/index.js': "export { parse } from './parse.js';\nexport function compile() {}\n",
		'src/compiler/parse.js': 'export function parse() {}\nexport function hidden() {}\n'
	});
	assert.equal(import_specifier(dir, 'pkg', 'src/compiler/index.js', 'compile'), 'pkg/compiler');
	assert.equal(import_specifier(dir, 'pkg', 'src/compiler/parse.js', 'parse'), 'pkg/compiler');
	assert.equal(import_specifier(dir, 'pkg', 'src/runtime.js', 'mount'), 'pkg');
	assert.equal(import_specifier(dir, 'pkg', 'src/compiler/parse.js', 'hidden'), null);
});

test('a scratch tree with another install: the project files of one, the dependencies of the other', () => {
	const dir = temp_dir('heisenbench-upgrade-tree-');
	checkout(join(dir, 'base'), '1.0.0');
	checkout(join(dir, 'head'), '1.1.0');
	write_files(join(dir, 'head'), { 'src/only-head.ts': 'export const x = 1;\n' });
	const out = join(dir, 'mixed');
	mirror_tree(join(dir, 'head'), out, { modules_from: join(dir, 'base') });
	assert.equal(
		(
			JSON.parse(readFileSync(join(out, 'node_modules', 'slowdep', 'package.json'), 'utf8')) as {
				version: string;
			}
		).version,
		'1.0.0'
	);
	assert.equal(readFileSync(join(out, 'src', 'only-head.ts'), 'utf8'), 'export const x = 1;\n');
	remove_tree(out);
	assert.equal(
		(
			JSON.parse(
				readFileSync(join(dir, 'base', 'node_modules', 'slowdep', 'package.json'), 'utf8')
			) as { version: string }
		).version,
		'1.0.0',
		'the other install is left as it was'
	);
});
