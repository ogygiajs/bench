import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { CaseReport, Report } from '../src/report.ts';
import { normalize } from '../src/cache/normalize.ts';
import { prune_cache } from '../src/cache/index.ts';
import { temp_dir, write_files } from './helpers.ts';

/*
 * Incremental counting (src/cache): a case is counted again only when something its counts are a
 * function of changed. Each test builds a small project and a copy of Heisenbench next to it (so a
 * test can change the engine itself), counts it once to fill the cache, changes one thing, and
 * looks at which cases were counted again and why.
 */

const PACKAGE = fileURLToPath(new URL('../', import.meta.url));

interface Project {
	dir: string;
	cache: string;
	/** The copy of Heisenbench this project is counted with. */
	engine: string;
}

function project(): Project {
	const tmp = temp_dir('heisenbench-cache-');
	const engine = join(tmp, 'hb');
	cpSync(join(PACKAGE, 'src'), join(engine, 'src'), { recursive: true });
	for (const f of ['package.json', 'prices.json', 'weights.json'])
		cpSync(join(PACKAGE, f), join(engine, f));
	symlinkSync(join(PACKAGE, 'node_modules'), join(engine, 'node_modules'), 'dir');
	const dir = join(tmp, 'proj');
	const api = JSON.stringify(pathToFileURL(join(engine, 'src', 'bench.ts')).href);
	write_files(dir, {
		'package.json': JSON.stringify({ name: 'proj', type: 'module' }),
		'src/a.ts': [
			'export function one(xs: number[]): number {',
			'\tlet s = 0;',
			'\tfor (const x of xs) s += x;',
			'\treturn s;',
			'}',
			'',
			'export function two(xs: number[]): number {',
			'\treturn xs.filter((x) => x % 2 === 0).length;',
			'}',
			'',
			'export function idle(xs: number[]): number[] {',
			'\treturn xs.map((x) => x * 2);',
			'}',
			''
		].join('\n'),
		'node_modules/dep/package.json': JSON.stringify({
			name: 'dep',
			version: '1.0.0',
			type: 'module',
			exports: './index.js'
		}),
		'node_modules/dep/index.js': [
			'export function dep_run(n) {',
			'\tlet s = 0;',
			'\tfor (let i = 0; i < n; i++) s += i;',
			'\treturn s;',
			'}',
			''
		].join('\n'),
		'bench/input.json': JSON.stringify({ n: 12 }),
		'bench/a.bench.ts': [
			`import { readFileSync } from 'node:fs';`,
			`import { bench } from ${api};`,
			`import { one, two } from '../src/a.ts';`,
			`import { dep_run } from 'dep';`,
			'',
			`const scale = ({ xs }, k) => ({ xs: Array.from({ length: xs.length * k }, (_, i) => i) });`,
			`bench('one', ({ xs }) => one(xs), { setup: () => ({ xs: [1, 2, 3, 4, 5] }), scale });`,
			`bench('two', ({ xs }) => two(xs), { setup: () => ({ xs: [1, 2, 3, 4, 5] }), scale });`,
			`bench('dep', ({ n }) => dep_run(n), {`,
			`\tsetup: () => JSON.parse(readFileSync(new URL('./input.json', import.meta.url), 'utf8'))`,
			`});`,
			''
		].join('\n'),
		'bench/b.bench.ts': [
			`import { bench } from ${api};`,
			'',
			`bench('alone', ({ s }) => s.split(',').length, { setup: () => ({ s: 'a,b,c' }) });`,
			''
		].join('\n')
	});
	return { dir, cache: join(tmp, 'cache'), engine };
}

interface Run {
	report: Report;
	status: number | null;
	stdout: string;
	stderr: string;
}

function count(
	p: Project,
	extra: string[] = [],
	env: Record<string, string> = {},
	command = 'run'
): Run {
	const out = join(p.dir, '..', `report-${Math.random().toString(36).slice(2)}.json`);
	const r = spawnSync(
		process.execPath,
		[
			'--no-warnings',
			join(p.engine, 'src', 'cli.ts'),
			command,
			'bench/a.bench.ts',
			'bench/b.bench.ts',
			'--root',
			p.dir,
			'--out',
			out,
			'--cache',
			p.cache,
			...extra
		],
		{ cwd: p.dir, encoding: 'utf8', env: { ...process.env, ...env } }
	);
	let report: Report;
	try {
		report = JSON.parse(readFileSync(out, 'utf8')) as Report;
	} catch {
		throw new Error(`no report (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
	}
	return { report, status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function reused(r: Run): string[] {
	return r.report.cases.filter((c) => c.reused).map((c) => c.name);
}

function counted(r: Run): string[] {
	return r.report.cases.filter((c) => !c.reused).map((c) => c.name);
}

function why(r: Run, name: string): string {
	return r.report.cache?.why.find((w) => w.name === name)?.why.join('; ') ?? '';
}

function edit(p: Project, file: string, from: string, to: string): void {
	const path = join(p.dir, file);
	const text = readFileSync(path, 'utf8');
	assert.ok(text.includes(from), `${file} has ${from}`);
	writeFileSync(path, text.replace(from, to));
}

/** The counts without what only a run adds (the reuse mark, the time estimates). */
function counts(c: CaseReport): string {
	const { reused: _r, measure: _m, ...rest } = c;
	return JSON.stringify(rest);
}

test('a warm cache counts nothing again, and a file whose cases all hit is not even loaded', () => {
	const p = project();
	const cold = count(p);
	assert.equal(cold.status, 0, cold.stdout + cold.stderr);
	assert.deepEqual(counted(cold), ['one', 'two', 'dep', 'alone']);
	assert.deepEqual(
		cold.report.cache?.why.map((w) => w.why[0]),
		Array(4).fill('not in the cache')
	);
	const warm = count(p);
	assert.equal(warm.status, 0);
	assert.deepEqual(reused(warm), ['one', 'two', 'dep', 'alone']);
	assert.equal(warm.report.cache?.counted, 0);
	assert.ok(!warm.stdout.includes('NO CASES'), warm.stdout);
	for (let i = 0; i < cold.report.cases.length; i++)
		assert.equal(counts(warm.report.cases[i]), counts(cold.report.cases[i]));
});

test('a change to one function counts again only the cases that ran it', () => {
	const p = project();
	count(p);
	// `one` gets a second loop: only the `one` case runs it
	edit(
		p,
		'src/a.ts',
		'\treturn s;\n}\n\nexport function two',
		'\tfor (const x of xs) s -= 0;\n\treturn s;\n}\n\nexport function two'
	);
	const r = count(p);
	assert.equal(r.status, 0);
	assert.deepEqual(counted(r), ['one']);
	assert.deepEqual(reused(r), ['two', 'dep', 'alone']);
	assert.match(why(r, 'one'), /src\/a\.ts changed/);
	// and its count did change
	const fresh = r.report.cases.find((c) => c.name === 'one')!;
	assert.ok(fresh.totals.steps > 0);

	// a function no case runs: nothing is counted again
	edit(p, 'src/a.ts', 'xs.map((x) => x * 2)', 'xs.map((x) => x * 3).reverse()');
	const idle = count(p);
	assert.deepEqual(counted(idle), []);
});

test('a comment-only change counts nothing again; the reused lines are where the code is now', () => {
	const p = project();
	const cold = count(p);
	edit(
		p,
		'src/a.ts',
		'export function one',
		'/**\n * A comment\n * of three lines.\n */\nexport function one'
	);
	edit(p, 'src/a.ts', '\tlet s = 0;', '\t// a comment inside\n\tlet s = 0; // and after code');
	const r = count(p);
	assert.deepEqual(counted(r), []);
	const before = cold.report.cases
		.find((c) => c.name === 'one')!
		.functions.find((f) => f.path === 'one')!;
	const after = r.report.cases
		.find((c) => c.name === 'one')!
		.functions.find((f) => f.path === 'one')!;
	assert.equal(after.line, before.line + 4);
	assert.equal(after.end_line, before.end_line + 5);
	assert.deepEqual(
		after.lines.map((l) => l.line),
		before.lines.map((l) => l.line + (l.line >= 2 ? 5 : 4))
	);
	// what a recount says, line for line
	const check = count(p, ['--cache-verify', '100']);
	assert.equal(check.status, 0, check.stdout + check.stderr);
	assert.equal(check.report.cache?.verified, 4);
	assert.deepEqual(check.report.cache?.mismatches, []);
	for (let i = 0; i < r.report.cases.length; i++)
		assert.equal(counts(r.report.cases[i]), counts(check.report.cases[i]));
});

test('each part of the key misses when it changes', () => {
	const p = project();
	count(p);

	// the source of a function a dependency runs for the case: a dependency is keyed by its bytes,
	// so every case that loads it counts again (the cases of the other file do not)
	edit(p, 'node_modules/dep/index.js', 's += i;', 's += i * 2;');
	let r = count(p);
	assert.deepEqual(counted(r), ['one', 'two', 'dep']);
	assert.deepEqual(reused(r), ['alone']);
	assert.match(why(r, 'dep'), /node_modules\/dep\/index\.js changed/);

	// what setup builds: a file it reads, then its own code
	writeFileSync(join(p.dir, 'bench/input.json'), JSON.stringify({ n: 13 }));
	r = count(p);
	assert.deepEqual(counted(r), ['dep']);
	assert.match(why(r, 'dep'), /bench\/input\.json \(read\) changed/);
	edit(
		p,
		'bench/a.bench.ts',
		"[1, 2, 3, 4, 5] }), scale });\nbench('two'",
		"[1, 2, 3, 4, 5, 6] }), scale });\nbench('two'"
	);
	r = count(p);
	assert.deepEqual(counted(r), ['one', 'two', 'dep']);
	assert.match(why(r, 'one'), /bench\/a\.bench\.ts changed/);
	assert.deepEqual(reused(r), ['alone']);

	// the prices
	const prices = JSON.parse(readFileSync(join(p.engine, 'prices.json'), 'utf8')) as {
		ops: Record<string, number>;
	};
	const op = Object.keys(prices.ops)[0];
	prices.ops[op] += 1;
	const other = join(p.dir, '..', 'prices-other.json');
	writeFileSync(other, JSON.stringify(prices));
	r = count(p, [], { HEISENBENCH_PRICES: other });
	assert.deepEqual(counted(r), ['one', 'two', 'dep', 'alone']);
	assert.match(why(r, 'alone'), /prices changed/);

	// the engine: one comment in Heisenbench's own source
	const report_ts = join(p.engine, 'src', 'report.ts');
	writeFileSync(report_ts, readFileSync(report_ts, 'utf8') + '\n// another engine\n');
	r = count(p);
	assert.deepEqual(counted(r), ['one', 'two', 'dep', 'alone']);
	assert.match(why(r, 'alone'), /engine changed/);
});

test('the check counts reused cases again, and a corrupted entry fails as a cache bug', () => {
	const p = project();
	count(p);
	// one stored value says `one` cost one step more than it does
	const values = join(p.cache, 'v1', 'values');
	let corrupted = 0;
	for (const d of readdirSync(values)) {
		for (const f of readdirSync(join(values, d))) {
			const path = join(values, d, f);
			const v = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as {
				report: CaseReport;
			};
			if (v.report.name !== 'one') continue;
			v.report.totals.steps += 1;
			writeFileSync(path, gzipSync(JSON.stringify(v)));
			corrupted++;
		}
	}
	assert.equal(corrupted, 1);
	const plain = count(p);
	assert.equal(plain.report.cases.find((c) => c.name === 'one')!.reused, true);
	const r = count(p, ['--cache-verify', '100']);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /CACHE BUG: a reused case differs from its recount: one: totals\.steps/);
	const one = r.report.cases.find((c) => c.name === 'one')!;
	assert.match(one.error ?? '', /a cache bug/);
	assert.deepEqual(r.report.cache?.mismatches.length, 1);
	// the recount replaced the bad entry
	const again = count(p, ['--cache-verify', '100']);
	assert.equal(again.status, 0, again.stderr);
});

test('growth reuses the curve of a case whose code did not change, and grows the rest', () => {
	const p = project();
	const grow = (extra: string[] = []) => count(p, ['--scaled', 'on', ...extra], {}, 'growth');
	const names = (r: Run, reused: boolean) =>
		(r.report.growth?.cases ?? []).filter((g) => (g.reused ?? false) === reused).map((g) => g.name);
	const cold = grow();
	assert.equal(cold.status, 0, cold.stdout + cold.stderr);
	assert.deepEqual(names(cold, false), ['one', 'two']);
	const warm = grow();
	assert.deepEqual(names(warm, true), ['one', 'two']);
	assert.deepEqual(
		warm.report.growth?.cases.map((g) => [g.class, g.steps]),
		cold.report.growth?.cases.map((g) => [g.class, g.steps])
	);
	// the counts and the growth of one case are kept apart: a count does not reuse a curve
	assert.deepEqual(counted(count(p)), ['one', 'two', 'dep', 'alone']);
	edit(
		p,
		'src/a.ts',
		'\treturn s;\n}\n\nexport function two',
		'\tfor (const x of xs) s -= 0;\n\treturn s;\n}\n\nexport function two'
	);
	const changed = grow(['--cache-verify', '1']);
	assert.equal(changed.status, 0, changed.stderr);
	assert.deepEqual(names(changed, false), ['one', 'two']);
	assert.equal(changed.report.growth?.cache?.verified, 1);
	assert.equal(changed.report.growth?.cache?.counted, 2);
	assert.equal(changed.report.growth?.cache?.reused, 0);
	// `two` was the reused case counted again (and the same)
	assert.deepEqual(changed.report.growth?.cache?.mismatches, []);
});

test('normalizing keeps what can change a count and drops what cannot', () => {
	const n = (s: string) => normalize(s, 'x.ts')!.text;
	assert.equal(n('let a = 1; // c\nlet b = 2;'), n('let a = 1;\n/* c */\n\n\tlet b = 2;'));
	assert.equal(n('f(a,  b)'), n('f(a, /* x */ b)'));
	// a line break is not a space: `return\nx` returns undefined
	assert.notEqual(n('function f(){ return\nx }'), n('function f(){ return x }'));
	assert.notEqual(n('function f(){ return/*\n*/x }'), n('function f(){ return x }'));
	// literals keep their bytes
	assert.notEqual(n("const s = 'a  b';"), n("const s = 'a b';"));
	assert.notEqual(n('const t = `a  ${x}  b`;'), n('const t = `a ${x} b`;'));
	assert.notEqual(n('const r = /a  b/;'), n('const r = /a b/;'));
	// a skipped body is one placeholder whatever it says
	const code1 = 'function f() { return 1; }\nf;';
	const code2 = 'function f() {\n\treturn 2 + 2;\n}\nf;';
	const body = (c: string) => [c.indexOf('{'), c.indexOf('}') + 1] as const;
	assert.equal(
		normalize(code1, 'x.ts', [body(code1)])!.text,
		normalize(code2, 'x.ts', [body(code2)])!.text
	);
	assert.equal(normalize('let x = ;', 'x.ts'), null);
});

test('pruning drops entries no run used lately', () => {
	const p = project();
	count(p);
	const kept = prune_cache(p.cache, 30);
	assert.equal(kept.removed, 0);
	assert.ok(kept.kept > 0);
	const later = prune_cache(p.cache, 30, Date.now() + 31 * 86_400_000);
	assert.equal(later.kept, 0);
	assert.ok(statSync(p.cache).isDirectory());
});
