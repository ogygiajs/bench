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
import { context_path } from '../src/identity.ts';

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
	const root = temp_dir('heisenbench-gate-');
	write_files(root, { 'packages/p/src/lib.ts': LIB });
	const inv = source_inventory(root, [join(root, 'packages/p/src/lib.ts')]);
	assert.deepEqual(inv.errors, []);
	assert.deepEqual(
		inv.functions.map((f) => context_path(f.path)),
		['arrow', 'arrow > map:0', 'benched', 'later', 'nothing', 'stateful', 'tested']
	);
	// a callback is named by its place and its shape
	assert.match(inv.functions[1].path, /^arrow > map:0~[0-9a-f]{6}$/);
	assert.equal(inv.functions[2].id, 'packages/p/src/lib.ts > benched');
	const targets = record_targets(
		inv,
		bench_reached([report_with(['packages/p/src/lib.ts > benched'])])
	);
	assert.equal(targets['packages/p/src/lib.ts'].includes('benched'), false);
	assert.equal(targets['packages/p/src/lib.ts'].length, 6);
});

test('sources and the gate: only new unmeasured functions fail; exemptions need a reason', () => {
	const root = temp_dir('heisenbench-gate-');
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
	// exempting `arrow` covers the closure nested in it
	assert.deepEqual(
		g.new_unmeasured.map((f) => f.path),
		['stateful']
	);
	assert.deepEqual(
		g.exempted.map((f) => context_path(f.path)),
		['arrow', 'arrow > map:0']
	);
	assert.deepEqual(
		g.stale_exemptions.map((e) => e.id),
		[m + 'gone']
	);
	assert.deepEqual(g.old_unmeasured.map((f) => f.path).sort(), ['later', 'nothing']);
	const md = render_gate(g);
	assert.ok(md.includes('1 new function with no measurement source'), md);
	assert.ok(md.includes('`stateful`'), md);
	// `nested: false` exempts the function alone
	const own = gate(measured, base, [{ id: m + 'arrow', reason: 'startup', nested: false }]);
	assert.deepEqual(
		own.new_unmeasured.map((f) => context_path(f.path)),
		['arrow > map:0', 'stateful']
	);
	// without a base (a full run), nothing is new
	assert.equal(gate(measured, null).pass, true);
});

test('the gate: a moved file keeps its history; a new file nothing can read fails', () => {
	const root = temp_dir('heisenbench-gate-');
	write_files(root, { 'packages/p/src/moved.ts': LIB });
	const inv = source_inventory(root, [join(root, 'packages/p/src/moved.ts')]);
	const measured = measurement_sources(inv, new Set(), [], [], new Set());
	const base = new Set(inv.functions.map((f) => f.id.replace('moved.ts', 'lib.ts')));
	assert.equal(gate(measured, base).pass, false, 'without the rename every function is new');
	const renames = new Map([['packages/p/src/lib.ts', 'packages/p/src/moved.ts']]);
	const g = gate(measured, base, [], { renames });
	assert.equal(g.pass, true);
	assert.equal(g.new_unmeasured.length, 0);

	const bad = gate(measured, base, [], {
		renames,
		unreadable: [{ file: 'packages/p/src/new.ts', error: 'cannot parse | here' }]
	});
	assert.equal(bad.pass, false);
	const md = render_gate(bad);
	assert.ok(md.includes('1 new file Heisenbench could not read'), md);
	assert.ok(md.includes('cannot parse \\| here'), md);
});

test('the gate: an old callback is not new when a new one comes before it, or when its own code changed', () => {
	const ids = (source: string): { inv: ReturnType<typeof source_inventory>; ids: string[] } => {
		const root = temp_dir('heisenbench-gate-');
		write_files(root, { 'src/lower.ts': source });
		const inv = source_inventory(root, [join(root, 'src/lower.ts')]);
		return { inv, ids: inv.functions.map((f) => f.id) };
	};
	const base = ids(`export function lower(xs: number[], ys: string[]) {
	ys.sort((a, b) => a.localeCompare(b));
	return xs.map((x) => x + 1);
}
`);
	// a sort added before the old one, and the old map callback edited
	const head = ids(`export function lower(xs: number[], ys: string[]) {
	xs.sort((a, b) => a - b);
	ys.sort((a, b) => a.localeCompare(b));
	return xs.map((x) => x * 2 + 1);
}
`);
	const old_sort = base.ids.find((id) => id.includes('sort:0'))!;
	assert.ok(head.ids.includes(old_sort), 'the old sort callback keeps its id');
	const g = gate(measurement_sources(head.inv, new Set()), new Set(base.ids));
	assert.deepEqual(
		g.new_unmeasured.map((f) => [context_path(f.path), f.line]),
		[['lower > sort:0', 2]],
		'only the added sort is new'
	);
	assert.deepEqual(g.old_unmeasured.map((f) => context_path(f.path)).sort(), [
		'lower',
		'lower > map:0',
		'lower > sort:0'
	]);
	// an exemption may name a place: it covers the callbacks there through their edits
	const place = gate(measurement_sources(head.inv, new Set()), new Set(base.ids), [
		{ id: 'src/lower.ts > lower > sort:0', reason: 'comparators' }
	]);
	assert.equal(place.pass, true);
	assert.equal(place.exempted.length, 2);
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
