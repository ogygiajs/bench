import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TimeComparison, TimeStats } from '@bench/heisenbench';
import { PLANTED_FOR, planted_pairs } from '../src/planted.ts';
import { assemble, measure_planted, write_dataset } from '../src/training.ts';
import { check_counts, check_times, dataset_text, time_rows } from '../src/training-rows.ts';
import type { CountsFile, TimesFile } from '../src/training-rows.ts';

const temp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

test('planted pairs: unique ids, a real change unless planted as none, every template', () => {
	const pairs = planted_pairs();
	assert.equal(new Set(pairs.map((p) => p.id)).size, pairs.length);
	assert.deepEqual(
		[...new Set(pairs.map((p) => p.template))].sort(),
		Object.keys(PLANTED_FOR).sort()
	);
	for (const p of pairs) {
		if (p.variant === 'identical') assert.equal(p.base, p.pr, p.id);
		else assert.notEqual(p.base, p.pr, p.id);
		assert.ok(p.bench.includes(`'${p.id}'`), `${p.id}: its case is named after the pair`);
	}
	for (const planted of ['slower', 'faster', 'same'] as const)
		assert.ok(pairs.filter((p) => p.planted === planted).length >= 40, planted);
	// the same list on every call: the pairs are code, not draws
	assert.deepEqual(planted_pairs(), pairs);
});

// Three answer-key pairs (an extra loop at 20, 200 and 2000 rows) and a harmless edit.
const FILTER = 'answer-extra-loop';

test('the counted part is the same bytes on every run, in groups of any size', async () => {
	const outs: string[] = [];
	const dirs: string[] = [];
	try {
		for (const batch of [1, 24]) {
			const work = temp('heisenbench-training-');
			dirs.push(work);
			await measure_planted({ work, counts_only: true, batch, filter: FILTER });
			const [counts, times] = write_dataset({ work, out: join(work, 'out') });
			assert.equal(times, undefined, 'counts only: no timed file');
			outs.push(readFileSync(counts, 'utf8'));
		}
		assert.equal(outs[0], outs[1]);
		const f = JSON.parse(outs[0]) as CountsFile;
		assert.deepEqual(check_counts(f), []);
		assert.equal(dataset_text(f), outs[0], 'the text is a function of the value');
		assert.deepEqual(
			f.rows.map((r) => r.id),
			[
				'planted/answer-extra-loop-n20',
				'planted/answer-extra-loop-n200',
				'planted/answer-extra-loop-n2000'
			]
		);
		for (const r of f.rows) {
			assert.equal(r.planted, 'slower');
			assert.ok(r.delta.steps > 0, `${r.id}: the extra loop adds steps`);
			assert.equal(r.engine, null, 'counts only: no engine health');
			assert.ok(r.base.input_size !== null && r.base.input_size > 0);
			assert.equal(r.base.input_size, r.pr.input_size, 'the input does not change');
		}
		// more rows, more input
		const sizes = f.rows.map((r) => r.base.input_size!);
		assert.ok(sizes[0] < sizes[1] && sizes[1] < sizes[2], JSON.stringify(sizes));
	} finally {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	}
});

function stats(p50: number): TimeStats {
	return {
		p50_ns: p50,
		p99_ns: p50 * 2,
		mean_ns: p50,
		throughput: 1e9 / p50,
		cpu_ns: null,
		samples: 100
	};
}

test('timed rows: every sample kept, labeled by the p50 verdict, checked against the counts', async () => {
	const work = temp('heisenbench-training-');
	try {
		await measure_planted({ work, counts_only: true, filter: `${FILTER}-n20` });
		const { counts } = assemble({ work });
		const rows = counts.rows.filter((r) => r.id.endsWith('-n20'));
		assert.equal(rows.length, 1);
		const verdict = (regressed: boolean) => ({
			pr: 1300,
			base: 1000,
			diff: 300,
			regressed,
			improved: false
		});
		const t: TimeComparison = {
			schema: 'heisenbench-time/1',
			repeats: 3,
			node: process.version,
			cases: [
				{
					name: rows[0].name,
					order: ['base', 'pr', 'base'],
					base: [stats(1000), stats(1010), stats(990)],
					pr: [stats(1300), stats(1290), stats(1310)],
					verdicts: {
						p50_ns: verdict(true),
						p99_ns: verdict(true),
						throughput: verdict(false),
						cpu_ns: { ...verdict(false), unjudged: true }
					}
				},
				// a case no counted row has: left out
				{ name: 'other', order: [], base: [], pr: [], verdicts: {} as never }
			],
			missing: { base: [], pr: [] },
			errors: []
		};
		const timed = time_rows('g1', rows, t);
		assert.equal(timed.length, 1);
		assert.equal(timed[0].label, 'slower');
		assert.equal(timed[0].beyond_noise, true);
		assert.equal(timed[0].verdicts.p50_ns.diff_pct, 30);
		assert.deepEqual(timed[0].base[0], [1000, 1000, 2000, null, 100]);
		const file: TimesFile = {
			schema: 'heisenbench-training-times/1',
			date: '2026-11-07T00:00:00.000Z',
			machine: { cpu: 'x', cores: 1, os: 'x', node: process.version, v8: 'x' },
			heisenbench: null,
			repeats: 3,
			time_ms: 150,
			sample_fields: ['p50_ns', 'mean_ns', 'p99_ns', 'cpu_ns', 'samples'],
			groups: [
				{
					id: 'g1',
					kind: 'planted',
					started: '2026-11-07T00:00:00.000Z',
					seconds: 10,
					load: { start: 1, end: 2, min: 1, max: 2, mean: 1.5 },
					series: [
						[0, 1],
						[10, 2]
					],
					error: null
				}
			],
			rows: timed
		};
		assert.deepEqual(check_times(file, counts), []);
		const wrong: TimesFile = {
			...file,
			rows: [{ ...timed[0], id: 'planted/nothing', label: 'same', group: 'g9' }]
		};
		assert.deepEqual(check_times(wrong, counts), [
			'rows[planted/nothing]: no counted row',
			'rows[planted/nothing].group: g9 not in groups',
			'rows[planted/nothing].beyond_noise'
		]);
		const broken: CountsFile = {
			...counts,
			rows: [{ ...rows[0], delta: { ...rows[0].delta, steps: rows[0].delta.steps + 1 } }]
		};
		assert.deepEqual(check_counts(broken), [`rows[${rows[0].id}].delta.steps: not pr - base`]);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});
