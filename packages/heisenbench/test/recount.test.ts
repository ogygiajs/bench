import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fn_of, load_module, measure, rt } from './helpers.ts';
import { price_units } from '../src/units.ts';
import { recount } from '../src/recount.ts';
import { diff_reports } from '../src/diff/index.ts';
import { render_markdown } from '../src/diff/markdown.ts';
import { SIZE_TERMS, load_prices } from '../src/prices.ts';
import type { Prices } from '../src/prices.ts';
import type { CaseReport, Report } from '../src/report.ts';

const SOURCE = `export function work(rows: Array<{ id: number; tags: string[] }>) {
	const ids = rows.map((r) => r.id).sort((a, b) => b - a);
	const copy = { ...rows[0], extra: 1 };
	let s = '';
	for (const r of rows) s += \`\${r.id}:\${r.tags.join(',')};\`;
	return [ids.length, Object.keys(copy).length, s.length, ...ids.slice(0, 2)];
}
`;

const rows = Array.from({ length: 12 }, (_, i) => ({ id: i, tags: ['a', 'b' + i] }));

function report_of(c: CaseReport, prices = load_prices()): Report {
	return {
		schema: 'heisenbench-report/1',
		prices: { version: prices.prices.version, hash: prices.hash },
		node: process.version,
		git: { sha: null, prefix: '' },
		cases: [c],
		unit_terms: [...SIZE_TERMS]
	};
}

function variant(change: (p: Prices) => void): { prices: Prices; hash: string } {
	const p = structuredClone(load_prices().prices);
	p.version += 1;
	change(p);
	return {
		prices: p,
		hash: createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16)
	};
}

test('units priced again give back every step: functions, lines, totals', async () => {
	const m = await load_module(SOURCE);
	const r = await measure(() => m.work(rows as never), true);
	const prices = rt.prices;
	let total = 0;
	for (const f of r.functions) {
		assert.ok(f.units, `${f.id} has units`);
		assert.equal(price_units(f.units, prices), f.self_steps, f.id);
		for (const l of f.lines)
			assert.equal(price_units(l.units!, prices), l.steps, `${f.id}:${l.line}`);
		for (const b of f.blocks) assert.equal(price_units(b.ops!, prices), b.price);
		total += f.self_steps;
	}
	assert.equal(Math.round(total * 1e6) / 1e6, r.totals.steps);
	const work = fn_of(r, 'work');
	assert.ok(work.units!['bi.Array.prototype.sort.calls'] === 1);
	assert.equal(work.units!['dyn.spread_key'], 2, 'object spread copies id and tags');
	assert.ok(work.units!['dyn.string_char']! > 0);
});

test('a recount moves each count by exactly its units, and recounting back restores it', async () => {
	const m = await load_module(SOURCE);
	const r = await measure(() => m.work(rows as never), true);
	const v1 = load_prices();
	const v2 = variant((p) => {
		p.ops.call += 3;
		p.dynamic.string_char = 1;
		// a model change: n log n -> n^2
		p.builtins['Array.prototype.sort'] = { model: 'n2', base: 5, k: 3 };
	});
	const re = recount(report_of(r), v2).cases[0];
	const work0 = fn_of(r, 'work');
	const work = re.functions.find((f) => f.path === 'work')!;
	const u = work0.units!;
	const sort_old = v1.prices.builtins['Array.prototype.sort'];
	const expected =
		work0.self_steps +
		3 * u.call +
		(1 - v1.prices.dynamic.string_char) * u['dyn.string_char'] +
		(5 + 3 * u['bi.Array.prototype.sort.n2']) -
		(sort_old.base + sort_old.k * u['bi.Array.prototype.sort.nlogn']);
	assert.ok(Math.abs(work.self_steps - expected) < 1e-6, `${work.self_steps} vs ${expected}`);
	assert.equal(u['bi.Array.prototype.sort.n2'], 144, 'sorted 12 ids');
	assert.equal(
		re.totals.steps,
		Math.round(re.functions.reduce((s, f) => s + f.self_steps, 0) * 1e6) / 1e6
	);
	const back = recount({ ...report_of(re), prices: { version: 2, hash: v2.hash } }, v1).cases[0];
	for (const f of back.functions) {
		const o = fn_of(r, f.path);
		assert.equal(f.self_steps, o.self_steps, f.id);
		assert.deepEqual(
			f.lines.map((l) => l.steps),
			o.lines.map((l) => l.steps)
		);
		assert.deepEqual(f.shape, o.shape);
	}
	assert.equal(back.totals.steps, r.totals.steps);
});

test('a built-in priced by a second size: split by its parts, recounted exactly both ways', async () => {
	const m = await load_module(`export function cut(s: string) {
	return s.split(',').length + s.split(/\\n/).length;
}
`);
	const text = 'ab,cd,ef\ngh,ij\nkl';
	const r = await measure(() => m.cut(text as never), true);
	const cut = fn_of(r, 'cut');
	// four parts by ',' and three by the line break: kept whatever split's price says
	assert.equal(cut.units!['bi.String.prototype.split.parts'], 7);
	assert.equal(cut.units!['bi.String.prototype.split.calls'], 2);
	const now = load_prices();
	const split = now.prices.builtins['String.prototype.split'];
	const per = (split.terms?.parts ?? 0) + 40;
	const v2 = variant((p) => {
		p.builtins['String.prototype.split'] = { ...split, terms: { ...split.terms, parts: per } };
	});
	const re = recount(report_of(r), v2).cases[0];
	const after = re.functions.find((f) => f.path === 'cut')!;
	assert.equal(after.self_steps, cut.self_steps + 40 * 7);
	const line = after.builtins.filter((b) => b.name === 'split');
	assert.equal(
		line.reduce((s, b) => s + b.steps, 0),
		cut.builtins.filter((b) => b.name === 'split').reduce((s, b) => s + b.steps, 0) + 40 * 7
	);
	const back = recount({ ...report_of(re), prices: { version: 9, hash: v2.hash } }, now).cases[0];
	assert.equal(back.functions.find((f) => f.path === 'cut')!.self_steps, cut.self_steps);
	// A report from before size terms were kept has no parts to price: not recounted.
	const { unit_terms: _, ...old } = report_of(r);
	assert.throws(() => recount(old as Report, v2), /no units to recount from/);
});

test('two calls of one built-in on one line are recounted apart, not both charged the line', async () => {
	const m = await load_module(`export function twice(xs: number[], s: string) {
	return [xs.map((x) => x + 1).map((x) => x * 2), xs.slice(1), s.slice(1)];
}
`);
	const r = await measure(
		() => m.twice([1, 2, 3, 4, 5, 6, 7, 8] as never, 'abcdef' as never),
		true
	);
	const v2 = variant((p) => {
		p.builtins['Array.prototype.map'] = { ...p.builtins['Array.prototype.map'], base: 40 };
	});
	const before = fn_of(r, 'twice').builtins;
	const after = recount(report_of(r), v2).cases[0].functions.find((f) => f.path === 'twice')!;
	const sum = (bs: typeof before) => bs.reduce((s, b) => s + b.steps, 0);
	const maps = after.builtins.filter((b) => b.name === 'map');
	assert.equal(maps.length, 2);
	const old_map = load_prices().prices.builtins['Array.prototype.map'].base;
	for (const b of maps) {
		const was = before.find((x) => x.name === 'map' && x.line === b.line && x.calls === b.calls)!;
		assert.equal(b.steps, was.steps + (40 - old_map), 'each map moves by its own base only');
	}
	const slices = after.builtins.filter((b) => b.name === 'slice');
	assert.deepEqual(
		slices.map((b) => b.steps),
		before.filter((b) => b.name === 'slice').map((b) => b.steps),
		'Array and String slice on one line keep their own steps'
	);
	assert.ok(Math.abs(sum(after.builtins) - (sum(before) + 2 * (40 - old_map))) < 1e-6);
});

test('object spread counts own enumerable symbol keys', async () => {
	const m = await load_module(`const S = Symbol('s');
const H = Symbol('hidden');
export function spread() {
	const o: Record<string | symbol, number> = { a: 1, [S]: 2 };
	Object.defineProperty(o, H, { value: 3, enumerable: false });
	return { ...o };
}
`);
	const r = await measure(() => m.spread());
	const f = fn_of(r, 'spread');
	assert.equal(f.units!['dyn.spread_key'], 2);
	assert.equal(rt.prices.dynamic.spread_key * 2 <= f.self_steps, true);
});

test('diff: different price files recount both sides; an unchanged case shows nothing', async () => {
	const m = await load_module(SOURCE);
	const r = await measure(() => m.work(rows as never), true);
	const v2 = variant((p) => {
		p.ops.call = 9;
	});
	const base = report_of(r);
	const pr = recount(report_of(r), v2);
	pr.prices = { version: v2.prices.version, hash: v2.hash };
	// counted with different prices, same code: without the recount every function would differ
	const d = diff_reports(base, pr, { prices: v2 });
	assert.equal(d.prices_match, true);
	assert.deepEqual(d.recounted, { version: v2.prices.version, hash: v2.hash });
	assert.deepEqual(d.findings, []);
	assert.ok(render_markdown(d).includes(`recounted with prices v${v2.prices.version}`));
	// a report without units cannot be recounted: flagged as not comparable
	const old = structuredClone(base);
	for (const f of old.cases[0].functions) delete f.units;
	const d2 = diff_reports(old, pr, { prices: v2 });
	assert.equal(d2.prices_match, false);
});
