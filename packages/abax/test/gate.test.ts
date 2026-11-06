import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
	bench_reached,
	gate,
	measurement_sources,
	record_targets,
	render_gate,
	source_inventory
} from '../src/coverage/gate.ts';
import { merge_records } from '../src/coverage/replay-run.ts';
import type { FunctionRecord, ReplayResult } from '../src/coverage/recorder.ts';
import type { Report } from '../src/report.ts';
import { temp_dir, write_files } from './helpers.ts';

const LIB = `export function benched(a: number): number {
	return a + 1;
}
export function tested(a: number): number {
	return a * 2;
}
let n = 0;
export function stateful(): number {
	return ++n;
}
export async function later(): Promise<number> {
	return 1;
}
function nothing(): void {}
export const arrow = (x: number) => [1, 2].map((k) => k * x);
`;

function report_with(ids: string[]): Report {
	return {
		cases: [
			{
				name: 'x',
				error: null,
				functions: ids.map((id) => ({ id, calls: 1 }))
			}
		]
	} as unknown as Report;
}

function rec(id: string, samples = 1): FunctionRecord {
	return {
		id,
		calls: samples,
		uncloneable: 0,
		inconsistent: 0,
		samples: Array.from({ length: samples }, (_, i) => ({
			args: [i],
			this_value: undefined,
			out: i
		}))
	};
}

test('inventory: every function of a TypeScript source, nested ones too, named like a report', () => {
	const root = temp_dir('abax-gate-');
	write_files(root, { 'packages/p/src/lib.ts': LIB });
	const inv = source_inventory(root, [join(root, 'packages/p/src/lib.ts')]);
	assert.deepEqual(inv.errors, []);
	assert.deepEqual(
		inv.functions.map((f) => f.path),
		['arrow', 'arrow > map:0', 'benched', 'later', 'nothing', 'stateful', 'tested']
	);
	assert.equal(inv.functions[2].id, 'packages/p/src/lib.ts > benched');
	const targets = record_targets(
		inv,
		bench_reached([report_with(['packages/p/src/lib.ts > benched'])])
	);
	assert.equal(targets['packages/p/src/lib.ts'].includes('benched'), false);
	assert.equal(targets['packages/p/src/lib.ts'].length, 6);
});

test('sources and the gate: only new unmeasured functions fail; exemptions need a reason', () => {
	const root = temp_dir('abax-gate-');
	write_files(root, { 'packages/p/src/lib.ts': LIB });
	const inv = source_inventory(root, [join(root, 'packages/p/src/lib.ts')]);
	const m = 'packages/p/src/lib.ts > ';
	const replays: ReplayResult[] = [
		{ id: m + 'tested', status: 'reproduced', samples: 1, mismatches: 0 },
		{ id: m + 'stateful', status: 'hidden state', samples: 1, mismatches: 2 }
	];
	const measured = measurement_sources(
		inv,
		bench_reached([report_with([m + 'benched'])]),
		[rec(m + 'tested'), rec(m + 'stateful')],
		replays,
		new Set([m + 'later'])
	);
	const by = new Map(measured.map((f) => [f.path, f]));
	assert.deepEqual(by.get('benched')?.sources, ['bench']);
	assert.deepEqual(by.get('tested')?.sources, ['recorded']);
	assert.equal(by.get('stateful')?.reason, 'hidden state');
	assert.equal(by.get('later')?.reason, 'not recorded');
	assert.equal(by.get('nothing')?.reason, 'never ran');

	// the base had everything but `stateful` and `arrow`: those two are new
	const base = new Set(
		inv.functions
			.map((f) => f.id)
			.filter((id) => !id.includes('stateful') && !id.startsWith(m + 'arrow'))
	);
	const g = gate(measured, base, [
		{ id: m + 'arrow', reason: 'built once at startup' },
		{ id: m + 'gone', reason: 'removed' }
	]);
	assert.equal(g.pass, false);
	assert.deepEqual(
		g.new_unmeasured.map((f) => f.path),
		['arrow > map:0', 'stateful']
	);
	assert.deepEqual(
		g.exempted.map((f) => f.path),
		['arrow']
	);
	assert.deepEqual(
		g.stale_exemptions.map((e) => e.id),
		[m + 'gone']
	);
	assert.deepEqual(g.old_unmeasured.map((f) => f.path).sort(), ['later', 'nothing']);
	const md = render_gate(g);
	assert.ok(md.includes('2 new functions with no measurement source'), md);
	assert.ok(md.includes('`stateful`'), md);
	// without a base (a full run), nothing is new
	assert.equal(gate(measured, null).pass, true);
});

test('merge_records: one record per function, samples deduplicated, conflicts counted', () => {
	const a = rec('m > f', 2);
	const b = rec('m > f', 3);
	b.samples[0] = { args: [0], this_value: undefined, out: 'other' };
	const [r] = merge_records([[a], [b]]);
	assert.equal(r.calls, 5);
	assert.equal(r.samples.length, 3);
	assert.equal(r.inconsistent, 1);
});
