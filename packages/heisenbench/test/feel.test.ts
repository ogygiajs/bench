import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auc, brier, fit_logistic, reliability, solve_spd } from '../src/models/logistic.ts';
import {
	DEFAULT_DATASET_VERSION,
	FEATURES,
	changed_rows,
	feel_input,
	feel_probability,
	feel_text,
	fold_of_groups,
	held_out,
	load_feel_model,
	odds_text,
	read_feel_dataset,
	train_feel
} from '../src/models/feel.ts';
import { feel_command } from '../src/models/cli.ts';
import { package_file } from '../src/own.ts';
import { load_prices } from '../src/prices.ts';
import { diff_reports } from '../src/diff/index.ts';
import { render_markdown } from '../src/diff/markdown.ts';
import type { CaseReport, Report } from '../src/report.ts';
import { load_module, measure } from './helpers.ts';

/*
 * The odds that a step change shows up on the clock (models/feel.ts): the fit itself, the model
 * file fitted again byte for byte, the held-out scores against "every step change shows", and the
 * odds in the PR comment's case table, which never change what the diff finds.
 */

test('logistic regression: Cholesky solve, a fit that separates, AUC, Brier and bins', () => {
	assert.deepEqual(
		solve_spd(
			[
				[4, 2],
				[2, 3]
			],
			[2, 1]
		).map((v) => Math.round(v * 1e9) / 1e9),
		[0.5, 0]
	);
	const x = [[-2], [-1], [-0.5], [0.5], [1], [2]];
	const y = [0, 0, 1, 0, 1, 1];
	const fit = fit_logistic(x, y, { l2: 0.1 });
	assert.ok(fit.weights[0] > 0, 'the label rises with x');
	assert.equal(auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1]), 0.75);
	assert.equal(auc([1, 1, 1], [0, 1, 1]), 0.5, 'ties count half');
	assert.equal(brier([1, 0], [1, 1]), 0.5);
	const bins = reliability([0.1, 0.15, 0.9, 1], [0, 1, 1, 1], 2);
	assert.deepEqual(
		bins.map((b) => [b.rows, b.observed]),
		[
			[2, 0.5],
			[2, 1]
		]
	);
});

const data = read_feel_dataset(DEFAULT_DATASET_VERSION);

test('the committed model is the dataset fitted again, byte for byte, and names its dataset', () => {
	const committed = readFileSync(package_file('feel.json'), 'utf8');
	const a = feel_text(train_feel(data));
	const b = feel_text(train_feel(read_feel_dataset(2)));
	assert.equal(a, b, 'two fits, the same bytes');
	assert.equal(a, committed, 'feel.json is what `heisenbench feel train` writes');
	const m = load_feel_model()!;
	assert.equal(m.dataset.version, 2);
	assert.equal(m.dataset.counts, 'training-counts-2.json');
	// version 1 (the busy machine) stays readable, for comparison
	assert.equal(read_feel_dataset(1).rows.length, 475);
	assert.deepEqual(
		m.features,
		FEATURES.map((f) => f.name)
	);
	assert.ok(committed.length < 4096, `small: ${committed.length} bytes`);
	assert.equal(feel_command(['check'], new Map()), 0);
});

test('held-out folds split by commit and by planted change: no change on both sides', () => {
	const rows = changed_rows(data.rows);
	const fold = fold_of_groups(
		rows.map((r) => r.group),
		5,
		1
	);
	for (const r of rows) {
		if (r.id.startsWith('history/')) assert.match(r.group, /^history\/[0-9a-f]{40}$/);
		else assert.match(r.group, /^planted\/[a-z]+\/[\w.-]+$/);
	}
	// every size of one planted change is one group (answer-extra-loop-n20, -n200, -n2000)
	const sizes = rows.filter((r) => r.group === 'planted/answer/extra-loop');
	assert.equal(sizes.length, 3);
	assert.equal(new Set(sizes.map((r) => fold.get(r.group))).size, 1);
	const per_fold = [0, 1, 2, 3, 4].map((k) => rows.filter((r) => fold.get(r.group) === k).length);
	assert.ok(Math.min(...per_fold) > 0, `every fold holds rows: ${per_fold.join(', ')}`);
	assert.deepEqual(fold_of_groups(['a', 'b', 'c'], 2, 7), fold_of_groups(['c', 'b', 'a'], 2, 7));
});

test('held out, it beats "every step change shows" on AUC and on Brier, on every seed', () => {
	const m = load_feel_model()!;
	const e = m.evaluation;
	assert.ok(e.model.auc > e.baseline.auc, `AUC ${e.model.auc} vs ${e.baseline.auc}`);
	assert.ok(e.model.brier < e.baseline.brier, `Brier ${e.model.brier} vs ${e.baseline.brier}`);
	assert.ok(e.all_pairs.model.auc > e.all_pairs.baseline.auc);
	assert.ok(e.all_pairs.model.brier < e.all_pairs.baseline.brier);
	const rows = changed_rows(data.rows);
	for (let seed = 1; seed <= 10; seed++) {
		const { p, y } = held_out(rows, { seed });
		assert.ok(auc(p, y) > 0.8, `seed ${seed}: AUC ${auc(p, y)}`);
		assert.ok(brier(p, y) < 0.2, `seed ${seed}: Brier ${brier(p, y)}`);
	}
	// honest at the ends: what it calls likely mostly showed, what it calls unlikely mostly did not
	const low = e.reliability[0];
	const high = e.reliability[e.reliability.length - 1];
	assert.ok(low.observed < 0.2 && high.observed > 0.8, JSON.stringify(e.reliability));
});

test('odds rise with the size of the change, and fall for a case too small for the clock', () => {
	const m = load_feel_model()!;
	const side = (steps: number) => ({ steps, steps_by_kind: { arith: steps } });
	const odds = (base: number, pr: number) =>
		feel_probability(m, { base: side(base), pr: side(pr) })!;
	assert.equal(feel_probability(m, { base: side(1e6), pr: side(1e6) }), null, 'no change, no odds');
	assert.ok(odds(1e6, 1.01e6) < odds(1e6, 1.1e6));
	assert.ok(odds(1e6, 1.1e6) < odds(1e6, 2e6));
	assert.ok(odds(1e6, 2e6) > 0.8, `doubled: ${odds(1e6, 2e6)}`);
	// dataset v2 gives +1% of a million steps about a quarter: the fit is linear in log steps and
	// reads a small change of a big case a little high (docs/feel-odds.md, "Range")
	assert.ok(odds(1e6, 1.01e6) < 0.3, `+1%: ${odds(1e6, 1.01e6)}`);
	// v1 put this gap near 0.3, v2 near 0.15: v2's tiny cases have the same labels, but its bigger
	// cases show small changes more often, and one slope in steps_size fits both less well
	assert.ok(
		odds(900, 1400) < odds(1e6, 1.55e6) - 0.1,
		`+55% of 900 steps: ${odds(900, 1400)}, of a million: ${odds(1e6, 1.55e6)}`
	);
	assert.equal(odds_text(0.004), 'under 1%');
	assert.equal(odds_text(0.8), '80%');
	assert.equal(odds_text(0.999), 'over 99%');
});

function wrap(c: CaseReport): Report {
	const p = load_prices();
	return {
		schema: 'heisenbench-report/1',
		prices: { version: p.prices.version, hash: p.hash },
		node: process.version,
		git: { sha: null, prefix: '' },
		cases: [{ ...c, name: 'walk', file: 'walk.bench.ts' }]
	};
}

test('the PR comment shows the odds next to each changed case; the diff finds the same', async () => {
	const m = await load_module<{ walk: (n: number) => number }>(
		'export function walk(n: number) { let s = 0; for (let i = 0; i < n; i++) s += i % 7; return s; }'
	);
	const base = wrap(await measure(() => m.walk(20000)));
	const slower = wrap(await measure(() => m.walk(80000)));
	const input = feel_input(base.cases[0], slower.cases[0], load_prices().prices)!;
	const total = Object.values(input.pr.steps_by_kind).reduce((a, b) => a + b, 0);
	assert.ok(Math.abs(total - slower.cases[0].totals.steps) < 1e-6, 'kinds sum to the steps');

	const d = diff_reports(base, slower);
	assert.equal(d.feel?.dataset, 2);
	assert.ok(d.feel!.odds.walk > 0.8, `4x the steps: ${d.feel!.odds.walk}`);
	const md = render_markdown(d);
	assert.match(md, /\| Case \| Steps \| Δ \| Odds it shows on the clock \|/);
	assert.match(md, /\| walk \| [\d,]+ → [\d,]+ \| \+[\d,]+ \(\+300\.0%\) \| (over )?\d+% \|/);
	assert.match(md, /Pass or fail never uses them/);
	assert.match(md, /timed on one machine/);

	// the odds are extra words: without them the diff is the same, finding for finding
	const plain = diff_reports(base, slower, { feel: null });
	assert.equal(plain.feel, undefined);
	const { feel: _, ...rest } = d;
	assert.deepEqual(rest, plain);
	assert.match(render_markdown(plain), /\| Case \| Steps \| Δ \|\n/);

	// a case whose steps did not move gets no odds and no column
	const same = diff_reports(base, wrap(await measure(() => m.walk(20000))));
	assert.deepEqual(same.feel?.odds, {});
	assert.doesNotMatch(render_markdown(same), /Odds it shows/);
});
