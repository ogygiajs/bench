import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHARDS_DIR, SHARDS_FORMAT, load_result_file } from '@bench/compare';
import type { EngineSite, Report } from '@bench/heisenbench';
import { STORED_DETAIL, stored_report, stored_result, write_stored } from '../src/stored.ts';
import type { Result } from '../src/section.ts';

const site = (id: string, state: string, unstable?: string) =>
	({ id, state, ...(unstable ? { unstable } : {}) }) as unknown as EngineSite;

const report = (): Report =>
	({
		schema: 'heisenbench-report/1',
		cases: [
			{
				name: 'a case',
				totals: { steps: 10 },
				edges: [{ from: 'f', to: 'g', calls: 1 }],
				functions: [
					{
						id: 'm.ts > f',
						lines: [{ line: 1, steps: 10 }],
						units: { prop_read: 2 },
						builtins: [{ name: 'push' }],
						blocks: [{ index: 0, line: 1, steps: 10 }]
					}
				]
			}
		],
		engine: {
			schema: 'heisenbench-engine/1',
			cases: [
				{
					name: 'a case',
					functions: [{ id: 'm.ts > f' }],
					sites: [
						site('mono', 'monomorphic'),
						site('poly', 'polymorphic'),
						site('mega', 'megamorphic'),
						site('mono, unstable', 'monomorphic', 'state')
					]
				}
			]
		}
	}) as unknown as Report;

test('a stored report leaves out blocks and monomorphic engine sites, nothing else', () => {
	const whole = report();
	const kept = stored_report(whole)!;
	const f = kept.cases[0].functions[0];
	assert.deepEqual(f.blocks, []);
	assert.deepEqual(f.lines, whole.cases[0].functions[0].lines);
	assert.deepEqual(f.units, whole.cases[0].functions[0].units);
	assert.deepEqual(f.builtins, whole.cases[0].functions[0].builtins);
	assert.deepEqual(kept.cases[0].edges, whole.cases[0].edges);
	assert.deepEqual(kept.cases[0].totals, whole.cases[0].totals);
	assert.deepEqual(kept.engine!.cases[0].functions, whole.engine!.cases[0].functions);
	assert.deepEqual(
		kept.engine!.cases[0].sites.map((s) => s.id),
		['poly', 'mega', 'mono, unstable']
	);
	// the whole report is not changed: the section and the diff are made from it
	assert.equal(whole.cases[0].functions[0].blocks.length, 1);
	assert.equal(whole.engine!.cases[0].sites.length, 4);
});

test('a report without an engine layer stays without one; no report stays null', () => {
	const { engine: _, ...plain } = report();
	assert.equal('engine' in stored_report(plain as Report)!, false);
	assert.equal(stored_report(null), null);
});

test('result.json trims both reports and says what it left out', () => {
	const r = { schema: 'ogygia-heisenbench/1', head: report(), base: null } as unknown as Result;
	const s = stored_result(r);
	assert.deepEqual(s.head!.cases[0].functions[0].blocks, []);
	assert.equal(s.base, null);
	assert.deepEqual(s.detail, STORED_DETAIL);
	assert.equal(s.schema, 'ogygia-heisenbench/1');
});

test('result.json is written as a manifest of shards that loads back as the stored result', () => {
	const out = mkdtempSync(join(tmpdir(), 'stored-'));
	const r = {
		schema: 'ogygia-heisenbench/1',
		meta: { sha: 'a'.repeat(40) },
		head: report(),
		base: report()
	} as unknown as Result;
	const split = write_stored(out, r);
	assert.equal(split.manifest.format, SHARDS_FORMAT);
	assert.deepEqual(readdirSync(join(out, SHARDS_DIR)).sort(), [...split.files.keys()].sort());
	assert.deepEqual(load_result_file(join(out, 'result.json')), stored_result(r));
	// the two sides counted the same: their shards are the same files
	assert.equal(split.files.size, 3);
});
