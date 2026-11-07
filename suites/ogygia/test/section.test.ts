import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	REPORT_SCHEMA,
	analyzeAudit,
	diffContracts,
	diffReports,
	loadPrices
} from '@bench/heisenbench';
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

/** An audit section of one bench file: one case whose steps grow n² and its time n, or not. */
function audit_part(name: string, mispriced: boolean): Report['audit'] {
	const sizes = [1, 10, 100];
	const units = sizes.map((k) => ({
		call: 1000 * k,
		prop_read: 3000 * k,
		...(mispriced ? { 'dyn.string_char': 400_000 * k * k } : {})
	}));
	const ns = sizes.map((k) => 800 * k);
	const input = {
		file: `packages/${name}/bench/x.bench.ts`,
		name,
		sizes,
		units,
		rounds: [0.99, 1.01, 1, 1.02, 0.98].map((f) => ns.map((v) => v * f))
	};
	return analyzeAudit([input], { sizes, rounds: 5, prices: loadPrices() });
}

test('a full run audits every bench file together and shows Prices only when one is suspect', () => {
	const a = { ...report('s', [case_of('page', 1)]), audit: audit_part('page', true) };
	const b = { ...report('s', [case_of('rows', 1)]), audit: audit_part('rows', false) };
	const merged = merge_reports([a, b], 'f'.repeat(40))!;
	assert.equal(merged.audit!.cases.length, 2);
	assert.deepEqual(
		merged.audit!.findings.map((f) => [f.kind, f.cases.map((c) => c.name)]),
		[['dyn.string_char', ['page']]]
	);
	const full = (head: Report) =>
		render_full_summary(
			result({
				meta: { ...result({}).meta, kind: 'main', pr: null, base: null, merge_base: null },
				selection: select_all(['x.bench.ts'], 'a full run'),
				head
			})
		);
	assert.match(full(merged), /#### Prices[\s\S]*price suspect: `dyn\.string_char`/);
	const quiet = merge_reports([b], 'f'.repeat(40))!;
	assert.doesNotMatch(full(quiet), /Prices/);
});

test('growth from recorded calls: a full run lists its findings; a PR with none in its files says nothing', () => {
	const recorded = (findings: number, scope: 'all' | 'changed', markdown: string) => ({
		scope,
		markdown,
		error: null,
		grown: 10,
		decided: 9,
		findings: Array.from({ length: findings }, () => ({}) as never),
		seconds: { build: 1, record: 2, grow: 3 }
	});
	const grows = '#### Growth from recorded calls\n\n- `x.ts > f` grows n^2.00 (quadratic)\n';
	const full = render_full_summary(
		result({
			meta: { ...result({}).meta, kind: 'main', pr: null, base: null, merge_base: null },
			selection: select_all(['x.bench.ts'], 'a full run'),
			recorded: recorded(1, 'all', grows)
		})
	);
	assert.match(full, /#### Growth from recorded calls/);
	assert.match(full, /`x\.ts > f` grows n\^2\.00/);
	const quiet = render_pr_section(
		result({ recorded: recorded(0, 'changed', '#### Growth from recorded calls\n\nNothing.\n') })
	);
	assert.doesNotMatch(quiet, /recorded calls/);
	const pr = render_pr_section(result({ recorded: recorded(1, 'changed', grows) }));
	assert.match(pr, /`x\.ts > f` grows/, 'shown even when no bench file reaches the change');
	const failed = render_pr_section(
		result({ recorded: { ...recorded(0, 'changed', ''), error: 'the packages did not build' } })
	);
	assert.match(failed, /\*\*Growth from recorded calls failed\*\*: `the packages did not build`/);
});

test('complexity contracts: a PR shows the ones it changes or breaks, a full run lists them all', () => {
	const contract = (path: string, text: string, verdict: 'holds' | 'broken') => ({
		id: `x.ts > ${path}`,
		module: 'x.ts',
		path,
		line: 2,
		tag_line: 1,
		class: 'linear' as const,
		param: 'rows',
		argument: 0,
		text,
		verdict,
		sources: []
	});
	const check = (cs: ReturnType<typeof contract>[]) => ({
		schema: 'heisenbench-contracts/1' as const,
		bar: 0.9,
		contracts: cs,
		errors: [],
		pass: cs.every((c) => c.verdict === 'holds')
	});
	const base = check([contract('a', 'linear in rows', 'holds')]);
	const same = render_pr_section(
		result({ contracts: { head: base, base, diff: diffContracts(base, base), error: null } })
	);
	assert.doesNotMatch(same, /Complexity contracts/, 'nothing changed and all hold: no part');
	const head = check([
		contract('a', 'linear in rows', 'broken'),
		contract('b', 'linear in rows', 'holds')
	]);
	const pr = render_pr_section(
		result({ contracts: { head, base, diff: diffContracts(base, head), error: null } })
	);
	assert.match(pr, /#### Complexity contracts/);
	assert.match(pr, /- \*\*broken\*\*: `x\.ts > a` `@heisenbench linear in rows` is broken/);
	assert.match(pr, /- new: `x\.ts > b`/);
	const full = render_full_summary(
		result({
			meta: { ...result({}).meta, kind: 'main', pr: null, base: null, merge_base: null },
			selection: select_all(['x.bench.ts'], 'a full run'),
			contracts: { head, base: null, diff: null, error: null }
		})
	);
	assert.match(full, /1 of 2 contracts hold/);
	const failed = render_pr_section(
		result({ contracts: { head: null, base: null, diff: null, error: 'it crashed' } })
	);
	assert.match(failed, /\*\*Complexity contracts failed\*\*: `it crashed`/);
});
