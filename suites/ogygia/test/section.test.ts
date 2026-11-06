import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPORT_SCHEMA } from '@bench/abax';
import type { CaseReport, Report } from '@bench/abax';
import { parseComment, upsertSection } from '@bench/compare';
import { merge_reports } from '../src/run.ts';
import { HEADING, RESULT_SCHEMA, render_full_summary, render_pr_section } from '../src/section.ts';
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
			abax: null,
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
	assert.match(md, /\[Abax run\]\(https:\/\/example\.test\/run\/1\)/);
	// the shared comment takes it as its abax section
	const body = upsertSection(null, 'abax', md);
	assert.deepEqual(
		parseComment(body).map((s) => s.name),
		['abax']
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
					schema: 'abax-time/1',
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
