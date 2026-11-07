import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPORT_SCHEMA, diffReports } from '@bench/heisenbench';
import type { CaseReport, Report } from '@bench/heisenbench';
import { parseComment, upsertSection } from '@bench/compare';
import { merge_reports } from '../src/run.ts';
import {
	CAPS,
	HEADING,
	RESULT_SCHEMA,
	env_note,
	one_line,
	render_full_summary,
	render_pr_section
} from '../src/section.ts';
import type { Result } from '../src/section.ts';
import { select_all, select_changed } from '../src/select.ts';

function case_of(name: string, steps: number): CaseReport {
	return {
		name,
		file: 'packages/router/bench/match.bench.ts',
		stable: true,
		timers: 0,
		runaway_timers: false,
		error: null,
		totals: { steps, allocations: 0, bytes: 0, calls: 1 },
		functions: [],
		edges: []
	};
}

function report(sha: string, cases: CaseReport[]): Report {
	return {
		schema: REPORT_SCHEMA,
		prices: { version: 1, hash: 'h' },
		node: 'v26',
		git: { sha, prefix: '' },
		cases
	};
}

function result(over: Partial<Result>): Result {
	return {
		schema: RESULT_SCHEMA,
		meta: {
			kind: 'pr',
			pr: 7,
			sha: 'a'.repeat(40),
			base: 'b'.repeat(40),
			merge_base: 'c'.repeat(40),
			heisenbench: null,
			node: 'v26',
			run_url: 'https://example.test/run/1',
			measure: null
		},
		selection: select_changed(new Map([['x.bench.ts', ['x.bench.ts']]]), ['y.ts']),
		head: null,
		base: null,
		diff: null,
		load_errors: { head: [], base: [] },
		time: null,
		...over
	};
}

test('a PR that reaches no bench file says so, with the run link, and fits the comment', () => {
	const md = render_pr_section(result({}));
	assert.ok(md.startsWith(HEADING + '\n'));
	assert.match(md, /No bench file reaches the files this PR changes \(1 bench file checked/);
	assert.match(md, /\[Heisenbench run\]\(https:\/\/example\.test\/run\/1\)/);
	// the shared comment takes it as its heisenbench section
	const body = upsertSection(null, 'heisenbench', md);
	assert.deepEqual(
		parseComment(body).map((s) => s.name),
		['heisenbench']
	);
});

test('a bench file that never loaded is listed, with its first error line', () => {
	const md = render_pr_section(
		result({
			selection: select_changed(new Map([['x.bench.ts', ['x.bench.ts', 'y.ts']]]), ['y.ts']),
			head: report('a', [case_of('c', 10)]),
			base: report('c', []),
			load_errors: {
				head: [],
				base: [
					{ file: 'x.bench.ts', command: 'run', error: '\nSyntaxError: no export named x\n  at …' }
				]
			}
		})
	);
	assert.match(md, /- base: `x\.bench\.ts` \(run\): `SyntaxError: no export named x`/);
	assert.match(md, /The base has none of these cases yet/);
});

test('the time layer’s table follows the steps; a failed time layer says so', () => {
	const sel = select_changed(new Map([['x.bench.ts', ['x.bench.ts', 'y.ts']]]), ['y.ts']);
	const timed = render_pr_section(
		result({
			selection: sel,
			time: {
				comparison: {
					schema: 'heisenbench-time/1',
					repeats: 5,
					node: 'v26',
					cases: [{ name: 'c' } as never],
					missing: { base: [], pr: [] },
					errors: []
				},
				markdown: '#### Time (plain build, PR and base taking turns)\n\n| Case |',
				error: null
			}
		})
	);
	assert.match(timed, /#### Time \(plain build, PR and base taking turns\)/);
	const failed = render_pr_section(
		result({ selection: sel, time: { comparison: null, markdown: '', error: '\nboom\nat x' } })
	);
	assert.match(failed, /\*\*Time layer failed\*\*: `boom`/);
});

test('reports of several bench files merge into one per tree', () => {
	const a = {
		...report('s', [case_of('one', 1)]),
		engine: { schema: 'e', cases: [{ name: 'one' }] }
	};
	const b = {
		...report('s', [case_of('two', 2)]),
		engine: { schema: 'e', cases: [{ name: 'two' }] }
	};
	const merged = merge_reports([a, b] as unknown as Report[], 'f'.repeat(40))!;
	assert.deepEqual(
		merged.cases.map((c) => c.name),
		['one', 'two']
	);
	assert.equal(merged.engine!.cases.length, 2);
	assert.equal(merged.growth, undefined);
	assert.equal(merged.git.sha, 'f'.repeat(40));
	assert.equal(merge_reports([], 'x'), null);
});

test('the merged report keeps the environment and every file that did not load', () => {
	const env = { node: 'v26', v8: '14', platform: 'linux', arch: 'x64', weights: null };
	const a = { ...report('s', [case_of('one', 1)]), env, load_errors: [{ file: 'a', error: 'x' }] };
	const b = { ...report('s', []), env, load_errors: [{ file: 'b', error: 'y' }] };
	const merged = merge_reports([a, b], 'f'.repeat(40))!;
	assert.deepEqual(merged.env, env);
	assert.deepEqual(
		merged.load_errors?.map((e) => e.file),
		['a', 'b']
	);
	assert.equal(merge_reports([report('s', [])], 'x')!.load_errors, undefined);
});

const sel_one = () => select_changed(new Map([['x.bench.ts', ['x.bench.ts', 'y.ts']]]), ['y.ts']);

test('case names and errors are escaped for a table cell, errors on one line', () => {
	const failed = { ...case_of('a | b `c`', 1), error: '\n  TypeError: x | y\n    at z\n' };
	const md = render_full_summary(
		result({
			meta: { ...result({}).meta, kind: 'main', pr: null, base: null, merge_base: null },
			selection: select_all(['x.bench.ts'], 'a full run'),
			head: report('a', [failed])
		})
	);
	const row = md.split('\n').find((l) => l.startsWith('| `a'))!;
	assert.equal(row.split(/(?<!\\)\|/).length, 10, 'the row keeps its 8 cells');
	assert.match(row, /\| `a \\\| b 'c'` \|/);
	assert.match(row, /failed: `TypeError: x \\\| y` \|$/);
});

test('every list is capped, with a count of the rest', () => {
	const benches = Array.from({ length: 30 }, (_, i) => `packages/p/bench/b${i}.bench.ts`);
	const graphs = new Map(benches.map((b) => [b, [b, 'packages/p/src/x.ts']]));
	const errors = benches.map((file) => ({ file, command: 'run' as const, error: 'boom' }));
	const md = render_pr_section(
		result({
			selection: select_changed(graphs, ['packages/p/src/x.ts']),
			load_errors: { head: errors, base: [] }
		})
	);
	assert.equal(
		md.split('\n').filter((l) => l.startsWith('- `packages/p/bench/')).length,
		CAPS.selection
	);
	assert.match(md, /- and 10 more bench files \(in result\.json\)/);
	assert.equal(md.split('\n').filter((l) => l.startsWith('- PR: ')).length, CAPS.load_errors);
	assert.match(md, /- and 20 more files \(in result\.json\)/);
});

test('bench files the report says did not load are listed', () => {
	const head = {
		...report('a', [case_of('c', 1)]),
		load_errors: [{ file: 'z.bench.ts', error: 'SyntaxError: enum\nmore' }]
	};
	const md = render_pr_section(result({ selection: sel_one(), head, base: report('c', []) }));
	assert.match(md, /- PR: `z\.bench\.ts` \(load\): `SyntaxError: enum`\n/);
});

test('head and base from different environments: one note, said once', () => {
	const env = (node: string) => ({ node, v8: '14', platform: 'linux', arch: 'x64', weights: null });
	const base = { ...report('c', [case_of('c', 1)]), node: 'v26.1.0', env: env('v26.1.0') };
	const head = { ...report('a', [case_of('c', 2)]), node: 'v26.2.0', env: env('v26.2.0') };
	const diff = {
		...diffReports(base, head, { files: null }),
		engine: null,
		growth: null,
		search: null
	};
	assert.ok(diff.env && diff.env.length > 0);
	const md = render_pr_section(result({ selection: sel_one(), head, base, diff }));
	assert.equal(md.match(/different environments/g)?.length, 1);
	assert.match(
		md,
		/⚠️ PR and base were counted in different environments \(Node v26\.1\.0 vs v26\.2\.0\)/
	);
	assert.equal(env_note({ ...diff, env: [] }), null);
});

test('engine and growth findings are capped', () => {
	const finding = (i: number) => ({
		case: 'c',
		kind: 'deopt' as never,
		module: 'm.ts',
		function: 'f',
		line: i,
		text: `finding ${i}`
	});
	const diff = {
		...diffReports(report('c', []), report('a', []), { files: null }),
		engine: {
			findings: Array.from({ length: 40 }, (_, i) => finding(i)),
			better: [],
			unstable: [],
			failed: []
		},
		growth: null,
		search: null
	};
	const md = render_pr_section(result({ selection: sel_one(), diff }));
	assert.equal(md.split('\n').filter((l) => l.startsWith('- finding ')).length, CAPS.engine);
	assert.match(md, /25 more engine entries are in result\.json\./);
});

test('the weight line comes before the step table, the search line after it', () => {
	const diff = {
		...diffReports(report('c', [case_of('c', 1)]), report('a', [case_of('c', 2)]), {
			files: null
		}),
		engine: null,
		growth: null,
		search: null
	};
	const md = render_pr_section(
		result({
			selection: sel_one(),
			head: report('a', [case_of('c', 2)]),
			base: report('c', [case_of('c', 1)]),
			diff,
			weights: {
				status: 'missing',
				sha: null,
				note: 'no stored weights from a main run yet',
				ranked: [],
				shown: 0,
				suppressed: 0
			},
			search: { budget_ms: 240_000, spent_ms: 0, cases: [], no_input: 1, skipped: 0 }
		})
	);
	const weight = md.indexOf('**Real-app weight**: not ranked');
	const steps = md.indexOf('function changed');
	const search = md.indexOf('**Worst-case search**');
	assert.ok(weight !== -1 && steps !== -1 && search !== -1, md);
	assert.ok(weight < steps && steps < search);
});

test('one_line: the first line that says something, trimmed and shortened', () => {
	assert.equal(one_line('\n\n  Error: x  \nat y'), 'Error: x');
	assert.equal(one_line('x'.repeat(300), 10), 'xxxxxxx...');
});

test('a full run lists every case with its counts', () => {
	const md = render_full_summary(
		result({
			meta: { ...result({}).meta, kind: 'main', pr: null, base: null, merge_base: null },
			selection: select_all(['x.bench.ts'], 'a full run'),
			head: report('a', [case_of('match', 1234.4)])
		})
	);
	assert.match(md, /1 case in 1 bench file/);
	assert.match(md, /\| `match` \| 1,234 \|/);
});
