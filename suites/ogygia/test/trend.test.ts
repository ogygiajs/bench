import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHARDS_DIR, split_result } from '@bench/compare';
import { REPORT_SCHEMA } from '@bench/heisenbench';
import type { CaseReport } from '@bench/heisenbench';
import { RESULT_SCHEMA, render_full_summary, trend_lines } from '../src/section.ts';
import type { Result } from '../src/section.ts';
import { select_all } from '../src/select.ts';
import { run_trend, trend_of } from '../src/trend.ts';
import type { RunPoint, TrendRun } from '../src/trend.ts';

const sha = (i: number) => i.toString(16).padStart(2, '0').repeat(20);

/** Main commits 0..n-1: `creeping` adds 1% at 12, 14, 17, 18 and 20; `stepped` 10% at 15. */
function points(n = 30, counter = (_i: number) => 'hb v26'): RunPoint[] {
	const creep = new Set([12, 14, 17, 18, 20]);
	let c = 1_000_000;
	return Array.from({ length: n }, (_, i) => {
		if (creep.has(i)) c = Math.round(c * 1.01);
		return {
			sha: sha(i),
			counter: counter(i),
			cases: { creeping: c, flat: 500_000, stepped: i >= 15 ? 220_000 : 200_000 }
		};
	});
}

test('trend over main: a creep is found where it started, a step is listed as a step', () => {
	const t = trend_of(points());
	assert.equal(t.cases, 3);
	assert.equal(t.runs.length, 30);
	assert.deepEqual(
		t.creeps.map((c) => [c.case, c.start, c.end, c.commits, c.rises, c.status]),
		[['creeping', sha(12), sha(20), 9, 5, 'held']]
	);
	assert.deepEqual(t.steps, [{ sha: sha(15), cases: 1, up: 1, down: 0, counter_changed: false }]);
	assert.equal(t.note, null);
	// the same points, the same answer
	const again = trend_of(points());
	assert.equal(JSON.stringify({ ...again, ms: 0 }), JSON.stringify({ ...t, ms: 0 }));
});

test('trend over main: the summary says the creep in one line, and the steps in one more', () => {
	const t = trend_of(points(30, (i) => (i < 15 ? 'hb1 v26' : 'hb2 v26')));
	const md = trend_lines(t).join('\n');
	assert.equal(
		md,
		[
			'**Trend over main** (30 full runs of main, `0000000` to `1d1d1d1`, 3 cases): steps that rose in small moves, none of them a step of 2% or more:',
			'',
			'- steps of `creeping` started rising at `0c0c0c0` (+5.1% over 9 commits, in 5 rises; to `1414141`, still there)',
			'',
			"Cases that took a step, 2% or more in one commit (each PR's comment has its own): `0f0f0f0` 1 up (a newer Heisenbench too).",
			''
		].join('\n')
	);
});

test('trend over main: still rising, given back, and a quiet history each read plainly', () => {
	const rising = trend_of(points(21));
	assert.match(
		trend_lines(rising).join('\n'),
		/- ⚠️ steps of `creeping` started rising at `0c0c0c0` \(\+5\.1% over 9 commits, in 5 rises; still rising\)/
	);
	const back = points(30).map((p, i) =>
		i >= 25 ? { ...p, cases: { ...p.cases, creeping: 1_000_000 } } : p
	);
	assert.match(
		trend_lines(trend_of(back)).join('\n'),
		/- steps of `creeping` rose from `0c0c0c0` \(\+5\.1% over 9 commits, in 5 rises\), given back at `1919191`/
	);
	const quiet = points(30).map((p) => ({ ...p, cases: { flat: 1 } }));
	assert.deepEqual(trend_lines(trend_of(quiet)), [
		'**Trend over main** (30 full runs of main, `0000000` to `1d1d1d1`, 1 case): no case is creeping.',
		''
	]);
	assert.deepEqual(trend_lines(trend_of(points(1))), [
		'**Trend over main**: one full run of main so far, nothing to compare.',
		''
	]);
	const failed: TrendRun = { ...trend_of([]), error: 'fatal: bad object\nmore' };
	assert.deepEqual(trend_lines(failed), ['**Trend over main failed**: `fatal: bad object`', '']);
});

function case_of(name: string, steps: number): CaseReport {
	return {
		name,
		file: 'packages/core/bench/x.bench.ts',
		stable: true,
		timers: 0,
		runaway_timers: false,
		error: null,
		totals: { steps, allocations: 0, bytes: 0, calls: 1 },
		functions: [],
		edges: []
	};
}

function result_of(p: RunPoint): Result {
	return {
		schema: RESULT_SCHEMA,
		meta: {
			kind: 'main',
			pr: null,
			sha: p.sha,
			base: null,
			merge_base: null,
			heisenbench: 'hb',
			node: 'v26',
			run_url: null,
			measure: null
		},
		selection: select_all(['packages/core/bench/x.bench.ts'], 'a full run'),
		head: {
			schema: REPORT_SCHEMA,
			prices: { version: 1, hash: 'h' },
			node: 'v26',
			git: { sha: p.sha, prefix: '' },
			cases: Object.entries(p.cases).map(([n, s]) => case_of(n, s!))
		},
		base: null,
		diff: null,
		load_errors: { head: [], base: [] },
		time: null
	};
}

const git = (cwd: string, args: string[]) =>
	execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** An ogygia-like repo whose first-parent line is `n` commits, and their shas oldest first. */
function repo_of(dir: string, n: number): string[] {
	mkdirSync(dir, { recursive: true });
	git(dir, ['init', '-q', '-b', 'main']);
	const shas: string[] = [];
	for (let i = 0; i < n; i++) {
		git(dir, [
			'-c',
			'user.name=t',
			'-c',
			'user.email=t@t',
			'commit',
			'-q',
			'--allow-empty',
			'-m',
			`c${i}`
		]);
		shas.push(git(dir, ['rev-parse', 'HEAD']));
	}
	return shas;
}

test('trend over main: the stored runs are read in first-parent order, this run the newest', () => {
	const dir = mkdtempSync(join(tmpdir(), 'hb-trend-'));
	try {
		const repo = join(dir, 'ogygia');
		const shas = repo_of(repo, 30);
		const pts = points(30).map((p, i) => ({ ...p, sha: shas[i] }));
		// the history as a checkout of the results branch: every run but the last, and one
		// commit that has no run (it is skipped), written newest first so file order is no help
		const files = join(dir, 'results');
		mkdirSync(join(files, 'heisenbench', 'main'), { recursive: true });
		mkdirSync(join(files, 'heisenbench', SHARDS_DIR), { recursive: true });
		for (let i = 28; i >= 0; i--) {
			if (i === 3) continue;
			const path = join(files, 'heisenbench', 'main', `${shas[i]}.json`);
			// the newer runs as manifests of shards, the older ones whole, as written before shards
			if (i < 15) {
				writeFileSync(path, JSON.stringify(result_of(pts[i])));
				continue;
			}
			const split = split_result(result_of(pts[i]) as unknown as Record<string, unknown>);
			writeFileSync(path, split.text);
			for (const [name, text] of split.files)
				writeFileSync(join(files, 'heisenbench', SHARDS_DIR, name), text);
		}
		writeFileSync(join(files, 'heisenbench', 'main', 'latest.json'), '{}');
		const own = result_of(pts[29]);
		const t = run_trend({ repo, history: files, result: own });
		assert.equal(t.error, null);
		assert.deepEqual(t.runs, [...shas.slice(0, 3), ...shas.slice(4)]);
		assert.deepEqual(
			t.creeps.map((c) => [c.case, c.start]),
			[['creeping', shas[12]]]
		);
		// the same history as a git directory (the blobless clone the nightly job makes)
		git(files, ['init', '-q', '-b', 'results']);
		git(files, ['add', '-A']);
		git(files, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'runs']);
		const from_git = run_trend({ repo, history: files, result: own });
		assert.deepEqual({ ...from_git, ms: 0 }, { ...t, ms: 0 });
		// a cap on the runs read keeps the newest
		assert.deepEqual(
			run_trend({ repo, history: files, result: own, runs: 5 }).runs,
			shas.slice(25)
		);
		// the summary of the full run carries it
		const md = render_full_summary({ ...own, trend: t });
		assert.match(md, /\*\*Trend over main\*\* \(29 full runs of main/);
		assert.match(md, /steps of `creeping` started rising at/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('trend over main: no history, a missing one, or a bad repo is said, never thrown', () => {
	const own = result_of(points(1)[0]);
	assert.equal(
		run_trend({ repo: '/nonexistent', history: null, result: own }).note,
		'no history of main was given'
	);
	assert.equal(
		run_trend({ repo: '/nonexistent', history: '/nonexistent/results', result: own }).note,
		'the history of main is not there'
	);
	const dir = mkdtempSync(join(tmpdir(), 'hb-trend-'));
	try {
		const t = run_trend({ repo: join(dir, 'no-repo'), history: dir, result: own });
		assert.ok(t.error);
		assert.deepEqual(t.creeps, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
