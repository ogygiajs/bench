import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fn_of, load_module, measure, rt } from './helpers.ts';
import { price_units } from '../src/units.ts';
import { recount } from '../src/recount.ts';
import { diff_reports } from '../src/diff/index.ts';
import { render_markdown } from '../src/diff/markdown.ts';
import { load_prices } from '../src/prices.ts';
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
		schema: 'abax-report/1',
		prices: { version: prices.prices.version, hash: prices.hash },
		node: process.version,
		git: { sha: null, prefix: '' },
		cases: [c]
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
	assert.ok(render_markdown(d).includes('recounted with prices v2'));
	// a report without units cannot be recounted: flagged as not comparable
	const old = structuredClone(base);
	for (const f of old.cases[0].functions) delete f.units;
	const d2 = diff_reports(old, pr, { prices: v2 });
	assert.equal(d2.prices_match, false);
});
