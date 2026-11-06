import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineMap, parse_diff } from '../src/diff/git.ts';
import { diff_reports, shape_similarity } from '../src/diff/index.ts';
import type { CaseReport, FunctionReport, Report } from '../src/report.ts';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -3,0 +4,2 @@ function f() {
+	added();
+	added();
@@ -10 +12 @@ function g() {
-	old();
+	new_one();
@@ -20,2 +21,0 @@
-	gone();
-	gone();
diff --git a/src/old.ts b/src/new.ts
similarity index 95%
rename from src/old.ts
rename to src/new.ts
`;

test('zero-context git diff: hunks, renames, line mapping both ways', () => {
	const files = parse_diff(DIFF);
	assert.equal(files.length, 2);
	assert.deepEqual(files[1], { old_path: 'src/old.ts', new_path: 'src/new.ts', hunks: [] });
	const m = new LineMap(files[0].hunks);
	assert.equal(m.forward(3), 3);
	assert.equal(m.forward(4), 6, 'after the insertion');
	assert.equal(m.forward(10), null, 'changed line');
	assert.equal(m.forward(11), 13);
	assert.equal(m.forward(20), null);
	assert.equal(m.forward(19), 21);
	assert.equal(m.forward(22), 22, 'after the deletion: +2 inserted, -2 deleted');
	assert.equal(m.backward(5), null);
	assert.equal(m.backward(6), 4);
	assert.equal(m.backward(13), 11);
	assert.equal(m.backward(21), 19);
	assert.equal(m.backward(22), 22);
	assert.equal(m.added_in(4), 0);
	assert.equal(m.added_in(12), 1);
	assert.equal(m.removed_in(10), 1);
	assert.equal(m.removed_in(21), 2);
	assert.equal(m.removed_in(11), -1);
});

test('shape similarity', () => {
	assert.equal(shape_similarity([1, 2, 3], [1, 2, 3]), 1);
	assert.equal(shape_similarity([], []), 1);
	assert.equal(shape_similarity([1, 2, 3, 4], [1, 2, 9, 4]), 0.75);
	assert.equal(shape_similarity([1], [2]), 0);
});

function fn(module: string, path: string, self: number, line = 1): FunctionReport {
	return {
		id: `${module} > ${path}`,
		module,
		path,
		kind: 'function',
		line,
		end_line: line + 3,
		calls: 1,
		self_steps: self,
		inclusive_steps: self,
		allocations: 0,
		bytes: 0,
		shape: [self],
		blocks: [{ index: 0, line, count: 1, price: self, steps: self }],
		sites: [],
		builtins: [],
		lines: [{ line: line + 1, steps: self, allocations: 0, bytes: 0 }]
	};
}

function report(functions: FunctionReport[], stable = true): Report {
	const c: CaseReport = {
		name: 'case',
		file: 'x.bench.ts',
		stable,
		timers: 0,
		runaway_timers: false,
		error: null,
		totals: { steps: 0, allocations: 0, bytes: 0, calls: 0 },
		functions,
		edges: []
	};
	return {
		schema: 'abax-report/1',
		prices: { version: 1, hash: 'h' },
		node: 'v26',
		git: { sha: null, prefix: 'pkg' },
		cases: [c]
	};
}

test('functions follow a file renamed in git', () => {
	const base = report([fn('old.ts', 'f', 10)]);
	const pr = report([fn('new.ts', 'f', 10)]);
	const files = parse_diff(DIFF.split('src/').join('pkg/'));
	assert.deepEqual(diff_reports(base, pr, { files }).findings, []);
	const slower = report([fn('new.ts', 'f', 12)]);
	const d = diff_reports(base, slower, { files });
	assert.equal(d.findings.length, 1);
	assert.equal(d.findings[0].kind, 'changed');
	assert.equal(d.findings[0].delta.steps, 2);
	assert.equal(d.findings[0].line, 2);
});

test('without git, lines are compared as they are; unstable cases are reported', () => {
	const base = report([fn('a.ts', 'f', 10), fn('a.ts', 'gone', 4, 20)]);
	const pr = report([fn('a.ts', 'f', 10), fn('a.ts', 'brand_new', 7, 30)], false);
	const d = diff_reports(base, pr);
	assert.deepEqual(d.unstable, ['case']);
	assert.deepEqual(
		d.findings.map((f) => [f.kind, f.function, f.line, f.delta.steps]),
		[
			['new function', 'brand_new', 30, 7],
			['removed function', 'gone', 20, -4]
		]
	);
});
