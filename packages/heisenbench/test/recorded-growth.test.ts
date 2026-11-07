import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { record_transform } from '../src/coverage/record-transform.ts';
import { recorder } from '../src/coverage/recorder.ts';
import { is_superlinear } from '../src/growth/fit.ts';
import type { RecordedGrowth } from '../src/growth/recorded.ts';
import type { Report } from '../src/report.ts';
import { temp_dir, write_files } from './helpers.ts';

/*
 * Growth from recorded calls, planted: a module with quadratic and linear functions, called the
 * way a test suite would call them (varied sizes, no `scale` anywhere), recorded, then grown by
 * the CLI on the counting build. The quadratic ones are flagged with the argument that drives
 * them; the linear ones are not. Two functions were recorded over too narrow a range of sizes
 * (under 4x): those are grown by scaling their largest recorded input, one argument at a time.
 */

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

const LIB = `
// quadratic in words (every pair compared); label only adds a constant-ish prefix scan
export function count_dupes(label, words) {
	let n = label.length > 3 ? 1 : 0;
	for (let i = 0; i < words.length; i++) {
		for (let j = i + 1; j < words.length; j++) if (words[i] === words[j]) n++;
	}
	return n;
}
// linear in items
export function tally(items, weight) {
	let s = 0;
	for (const x of items) s += x.length * weight;
	return s;
}
// quadratic, but the tests only ever passed it 10 to 20 numbers
export function overlaps(xs) {
	let n = 0;
	for (let i = 0; i < xs.length; i++) for (let j = 0; j < xs.length; j++) if (xs[i] < xs[j]) n++;
	return n;
}
// linear, recorded over a narrow range too
export function total(xs) {
	let s = 0;
	for (const x of xs) s += x;
	return s;
}
`;

const words = (n: number, seed: number): string[] =>
	Array.from({ length: n }, (_, i) => `w${(i * 7 + seed) % Math.max(3, n >> 1)}`);

async function record(dir: string): Promise<void> {
	const rec_dir = join(dir, 'recording');
	const r = record_transform(LIB, { filename: join(rec_dir, 'lib.js'), id: 'lib.js' });
	write_files(rec_dir, { 'lib.js': r.code });
	const m = (await import(pathToFileURL(join(rec_dir, 'lib.js')).href)) as Record<
		string,
		(...a: unknown[]) => unknown
	>;
	recorder.reset();
	// what a test suite does: small and large inputs, in no particular order
	for (const [n, label] of [
		[12, 'short'],
		[200, 'a'],
		[40, 'a longer label'],
		[400, 'mid'],
		[25, 'x'],
		[90, 'label'],
		[150, 'b'],
		[60, 'another one']
	] as const) {
		m.count_dupes(label, words(n, label.length));
		m.tally(words(n * 3, 1), 2);
	}
	for (const n of [10, 14, 12, 20, 16]) {
		m.overlaps(Array.from({ length: n }, (_, i) => (i * 37) % 11));
		m.total(Array.from({ length: n }, (_, i) => i));
	}
	mkdirSync(join(dir, 'records'), { recursive: true });
	recorder.save(join(dir, 'records', 'tests.bin'));
	recorder.reset();
}

test('growth from recorded calls: the quadratic functions are flagged on the right argument, the linear ones are not', async () => {
	const dir = temp_dir('heisenbench-recorded-growth-');
	write_files(dir, { 'lib.js': LIB });
	await record(dir);
	const { stdout } = await run(
		process.execPath,
		[
			'--no-warnings',
			CLI,
			'growth',
			'--recorded',
			join(dir, 'records'),
			'--root',
			dir,
			'--out',
			join(dir, 'report.json'),
			'--md',
			join(dir, 'growth.md')
		],
		{ cwd: dir }
	);
	const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as Report;
	const by = new Map<string, RecordedGrowth>(
		report.recorded_growth!.functions.map((g) => [g.id.split(' > ')[1], g])
	);

	const dupes = by.get('count_dupes')!;
	assert.equal(dupes.source, 'recorded', 'eight recorded sizes spanning 33x need no scaling');
	assert.equal(dupes.confident, true);
	assert.equal(dupes.grows, true);
	assert.equal(dupes.class, 'quadratic');
	assert.equal(dupes.argument, 1, 'the words drive it, not the label');
	assert.equal(dupes.kind, 'array size');
	assert.ok(dupes.power > 1.6 && dupes.power < 2.3, String(dupes.power));
	assert.ok(dupes.r2! > 0.95);
	assert.equal(dupes.calls, 8);
	assert.equal(dupes.parts?.[0].id, 'lib.js > count_dupes');
	assert.match(dupes.lines![0].at, /^lib\.js:\d+$/);
	const label = dupes.recorded!.find((r) => r.argument === 0)!;
	assert.ok(label.r2 < dupes.r2!, 'the label explains the steps worse than the words');

	const tally = by.get('tally')!;
	assert.equal(tally.confident, true);
	assert.equal(tally.class, 'linear');
	assert.equal(tally.grows, false);
	assert.equal(is_superlinear(tally.class), false);

	const overlaps = by.get('overlaps')!;
	assert.equal(overlaps.source, 'scaled', '10 to 20 numbers span 2x: the largest is scaled');
	assert.deepEqual(overlaps.factors, [1, 4, 16]);
	assert.equal(overlaps.argument, 0);
	assert.equal(overlaps.class, 'quadratic');
	assert.equal(overlaps.grows, true);

	const total = by.get('total')!;
	assert.equal(total.source, 'scaled');
	assert.equal(total.class, 'linear');
	assert.equal(total.grows, false);

	// the odds keep every class, with at least 95% on it
	for (const g of [dupes, tally, overlaps, total]) {
		assert.equal(g.odds?.odds[0].shape, g.class, `${g.id}: ${JSON.stringify(g.odds)}`);
		assert.ok(g.odds!.odds[0].p >= 0.95, `${g.id}: ${JSON.stringify(g.odds)}`);
	}
	assert.ok(dupes.odds!.superlinear >= 0.9 && overlaps.odds!.superlinear >= 0.9);
	assert.ok(tally.odds!.superlinear < 0.1 && total.odds!.superlinear < 0.1);

	const md = readFileSync(join(dir, 'growth.md'), 'utf8');
	assert.match(
		md,
		/`lib\.js > count_dupes`: n\^\d\.\d\d \(quadratic\) in argument 1 \(array size\); seen in 8 recorded calls/
	);
	assert.match(md, /`lib\.js > overlaps` grows n\^2\.00 \(quadratic\)/);
	assert.doesNotMatch(md, /tally|total/, 'only superlinear findings are listed');
	assert.match(stdout, /GROWS {4}lib\.js > count_dupes/);
});

test('growth from recorded calls is the same on every run', async () => {
	const dir = temp_dir('heisenbench-recorded-growth-twice-');
	write_files(dir, { 'lib.js': LIB });
	await record(dir);
	const once = async (n: number) => {
		const out = join(dir, `report-${n}.json`);
		await run(
			process.execPath,
			[
				'--no-warnings',
				CLI,
				'growth',
				'--recorded',
				join(dir, 'records'),
				'--root',
				dir,
				'--out',
				out
			],
			{ cwd: dir }
		);
		const r = JSON.parse(readFileSync(out, 'utf8')) as Report;
		return r.recorded_growth;
	};
	assert.deepEqual(await once(1), await once(2));
});
