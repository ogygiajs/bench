import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPORT_SCHEMA, diffReports } from '@bench/heisenbench';
import type { BlameResult, CaseReport, Report } from '@bench/heisenbench';
import { blame_paths } from '../src/blame.ts';
import { RESULT_SCHEMA, render_pr_section } from '../src/section.ts';
import type { Result } from '../src/section.ts';
import { select_all, select_changed } from '../src/select.ts';

function case_of(name: string, steps: number): CaseReport {
	return {
		name,
		file: 'packages/core/bench/compiler.bench.ts',
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

test('blame searches the files the regressed bench files reach, or every file when all ran', () => {
	const graphs = new Map([
		['packages/core/bench/compiler.bench.ts', ['packages/core/src/a.ts', 'packages/core/src/b.ts']],
		['packages/router/bench/match.bench.ts', ['packages/router/src/match.ts']]
	]);
	const sel = select_changed(graphs, ['packages/core/src/b.ts', 'packages/router/src/match.ts']);
	assert.deepEqual(blame_paths(sel, ['packages/core/bench/compiler.bench.ts']), [
		'packages/core/src/b.ts'
	]);
	assert.equal(blame_paths(select_all([], 'pnpm-lock.yaml changed'), ['x']), null);
});

test('the blame part follows the step table; a failed blame says so in one line', () => {
	const base = report('c'.repeat(40), [case_of('transformHost: twenty islands', 1000)]);
	const head = report('a'.repeat(40), [case_of('transformHost: twenty islands', 2000)]);
	const blame: BlameResult = {
		schema: 'heisenbench-blame/1',
		base: base.git.sha!,
		head: head.git.sha!,
		tolerance: 0.1,
		budget: { recounts: 60, ms: 300_000 },
		units: [
			{
				id: 0,
				kind: 'edit',
				file: 'packages/core/src/a.ts',
				lines: [3, 4],
				old_lines: [3, 3],
				text: '@@ -2,3 +2,4 @@\n a\n+b\n c'
			}
		],
		cases: [
			{
				case: 'transformHost: twenty islands',
				file: 'packages/core/bench/compiler.bench.ts',
				base_steps: 1000,
				pr_steps: 2000,
				status: 'found',
				note: null,
				anchors: { base: 1000, head: 2000 },
				extra: 1000,
				explained: 1,
				revert: { units: [0], complete: true, extra: 0 },
				apply: { units: [0], complete: true, extra: 1000 },
				shares: [{ unit: 0, revert: 1, apply: 1, runs_alone: true }],
				interacts: false,
				functions: [],
				invalid: 0
			}
		],
		groups: [{ cases: ['transformHost: twenty islands'], revert: [0], apply: [0] }],
		spent: { recounts: 3, reused: 2, ms: 4000 },
		exhausted: false,
		recounts: []
	};
	const r: Result = {
		schema: RESULT_SCHEMA,
		meta: {
			kind: 'pr',
			pr: 7,
			sha: head.git.sha!,
			base: base.git.sha!,
			merge_base: base.git.sha!,
			heisenbench: null,
			node: 'v26',
			run_url: null,
			measure: null
		},
		selection: select_changed(
			new Map([['packages/core/bench/compiler.bench.ts', ['packages/core/src/a.ts']]]),
			['packages/core/src/a.ts']
		),
		head,
		base,
		diff: { ...diffReports(base, head), engine: null, growth: null, search: null },
		load_errors: { head: [], base: [] },
		time: null,
		blame: { result: blame, error: null }
	};
	const md = render_pr_section(r);
	assert.match(
		md,
		/\*\*\+100\.0%\*\* in `transformHost: twenty islands` \(\+1000 steps\) comes from this change in `packages\/core\/src\/a\.ts` L3–4 \(\+1000 steps by itself\)\./
	);
	assert.ok(md.indexOf('Which change made it slower') > md.indexOf('Steps are exact'));
	assert.match(md, /```diff\n@@ -2,3 \+2,4 @@\n a\n\+b\n c\n```/);
	const failed = render_pr_section({ ...r, blame: { result: null, error: 'boom\nstack' } });
	assert.match(failed, /\*\*Blame failed\*\*: `boom`/);
});
