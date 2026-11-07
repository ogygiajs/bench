import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze_audit, audit_case, drifts, kind_of, kind_steps } from '../src/audit/fit.ts';
import type { AuditInput } from '../src/audit/fit.ts';
import { render_audit } from '../src/audit/markdown.ts';
import { load_prices } from '../src/prices.ts';
import type { Units } from '../src/units.ts';

/*
 * The price audit's detection rule on synthetic data: units at 1x / 10x / 100x, and times made
 * from them with a chosen cost per kind and multiplicative noise. A planted mispriced kind must be
 * found (and only it); noise alone, a cost per call that steps do not see, and an engine that gets
 * a little slower per step as the input grows must find nothing.
 */

const prices = load_prices();
const SIZES = [1, 10, 100];

/** A small seeded generator (sfc32), so every run of the test sees the same noise. */
function rng(seed: number): () => number {
	let a = 0x9e3779b9;
	let b = 0x243f6a88;
	let c = 0xb7e15162;
	let d = seed >>> 0;
	return () => {
		a >>>= 0;
		b >>>= 0;
		c >>>= 0;
		d >>>= 0;
		const t = (((a + b) | 0) + d) | 0;
		d = (d + 1) | 0;
		a = b ^ (b >>> 9);
		b = (c + (c << 3)) | 0;
		c = (c << 21) | (c >>> 11);
		c = (c + t) | 0;
		return (t >>> 0) / 4294967296;
	};
}

/** Normal noise as a factor: exp(N(0, sigma)). */
function noise(r: () => number, sigma: number): number {
	const u = Math.max(r(), 1e-12);
	const v = r();
	return Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
}

/** Linear op work per size: `per` of each op kind times the size. */
function ops(k: number, per: Record<string, number>): Units {
	const u: Units = {};
	for (const [op, n] of Object.entries(per)) u[op] = n * k;
	return u;
}

interface Plant {
	units: (k: number) => Units;
	/** True ns of one size's units (what the engine does). */
	ns: (u: Units, k: number) => number;
}

function input(name: string, p: Plant, seed: number, sigma = 0.03, rounds = 5): AuditInput {
	const r = rng(seed);
	const units = SIZES.map((k) => p.units(k));
	return {
		file: 'synthetic.bench.ts',
		name,
		sizes: SIZES,
		units,
		rounds: Array.from({ length: rounds }, () =>
			SIZES.map((k, i) => p.ns(units[i], k) * noise(r, sigma))
		)
	};
}

/** ns of the units when every price is right: 0.1 ns per step, whatever the kind. */
const fair = (u: Units): number =>
	0.1 * [...kind_steps(u, prices.prices).values()].reduce((s, v) => s + v, 0);

const OPS = { call: 2000, prop_read: 6000, compare: 3000, assign: 2500, branch: 1500 };

test('audit: the kind of a unit key', () => {
	assert.equal(kind_of('call'), 'call');
	assert.equal(kind_of('dyn.string_char'), 'dyn.string_char');
	assert.equal(kind_of('bi.Array.prototype.sort.nlogn'), 'bi.Array.prototype.sort');
	assert.equal(kind_of('bi.JSON.parse.calls'), 'bi.JSON.parse');
});

test('audit: a kind is tested only when it grows apart from the rest', () => {
	assert.equal(drifts([10, 100, 1000], [110, 1100, 11000]), false);
	assert.equal(drifts([10, 1000, 100000], [110, 2000, 110000]), true);
	// the rest grows faster than the kind: also apart
	assert.equal(drifts([500, 600, 700], [600, 1600, 10700]), true);
	// the kind is all of the case: nothing to compare it with
	assert.equal(drifts([10, 100, 1000], [10, 100, 1000]), false);
});

// Joins charged per character of the whole result: the characters grow n^2, the engine's work n.
const old_joins: Plant = {
	units: (k) => ({ ...ops(k, OPS), 'dyn.string_char': 40_000 * k * k * 50 }),
	// the engine: the ops cost what their steps say, the characters nothing (cons strings)
	ns: (u) => fair({ ...u, 'dyn.string_char': 0 })
};

test('audit: a planted mispriced kind is found, with how far off it is', () => {
	const c = audit_case(input('page: built with +=', old_joins, 1), prices.prices);
	assert.ok(c.suspect, `no suspect (misfit ${c.misfit})`);
	assert.equal(c.suspect.kind, 'dyn.string_char');
	assert.ok(c.suspect.factor < 0.01, `factor ${c.suspect.factor}`);
	assert.ok(Math.abs(c.suspect.kind_exponent - 2) < 0.05);
	assert.equal(c.suspect.kind_class, 'quadratic');
	assert.equal(c.time_class, 'linear');
	const a = analyze_audit([input('page: built with +=', old_joins, 1)], {
		sizes: SIZES,
		rounds: 5,
		prices
	});
	assert.equal(a.findings.length, 1);
	const f = a.findings[0];
	assert.equal(f.kind, 'dyn.string_char');
	assert.equal(f.direction, 'over');
	assert.match(f.text, /^price suspect: dyn\.string_char: steps grow quadratic in page: built/);
	assert.match(f.text, /time grows linear/);
	assert.match(f.text, /charges work the engine does not do/);
	assert.match(render_audit(a, { quiet: true }), /price suspect: `dyn\.string_char`/);
});

/** `i` with one round's size timed `by` times slow, as a burst of other work on a shared runner does. */
function bent(i: AuditInput, round: number, size: number, by: number): AuditInput {
	return {
		...i,
		rounds: i.rounds.map((r, j) => (j === round ? r.map((v, s) => (s === size ? v * by : v)) : r))
	};
}

test('audit: a round a burst of other work bent abstains, the others still decide', () => {
	// What failed on a busy 2-vCPU CI runner: one round's 10x timed 1.9x slow. No model explains
	// that round, and it used to veto the finding every other round agreed on.
	const i = bent(input('page: built with +=', old_joins, 1, 0.03, 3), 0, 1, 1.9);
	const c = audit_case(i, prices.prices);
	assert.equal(c.suspect?.kind, 'dyn.string_char');
	// Two rounds out of three bent so far that no model explains them leave one vote: not enough
	// for a finding.
	const two = bent(bent(input('page: built with +=', old_joins, 1, 0.03, 3), 0, 1, 3), 1, 1, 3);
	assert.equal(audit_case(two, prices.prices).suspect, null);
});

test('audit: a bent round cannot make a finding the others do not', () => {
	// Fair prices, three rounds, every one of them bent at a different size: nothing to find.
	const fair_case: Plant = { units: (k) => ops(k, OPS), ns: (u) => fair(u) };
	let i = input('fair: three bent rounds', fair_case, 3, 0.03, 3);
	for (let r = 0; r < 3; r++) i = bent(i, r, r, 1.9);
	assert.equal(audit_case(i, prices.prices).suspect, null);
});

test('audit: a planted underpriced built-in is found', () => {
	// splice is priced as a constant; here each call moves n elements, and n grows with the input
	const plant: Plant = {
		units: (k) => ({
			...ops(k, OPS),
			'bi.Array.prototype.splice.calls': 20 * k,
			'bi.Array.prototype.splice.n': 20 * k * 400 * k
		}),
		ns: (u, k) => fair(u) + 20 * k * 400 * k * 0.4
	};
	const a = analyze_audit([input('splice: remove from the middle', plant, 2)], {
		sizes: SIZES,
		rounds: 5,
		prices
	});
	assert.deepEqual(
		a.findings.map((f) => [f.kind, f.direction]),
		[['bi.Array.prototype.splice', 'under']]
	);
	assert.match(a.findings[0].text, /misses work the engine does/);
});

test('audit: noise alone finds nothing (300 synthetic cases, 3% to 10% noise)', () => {
	const r = rng(7);
	const inputs: AuditInput[] = [];
	for (let i = 0; i < 300; i++) {
		// a random mix of linear, n log n and quadratic work, every price right
		const lin = 500 + Math.floor(r() * 5000);
		const sort = r() < 0.5 ? Math.floor(r() * 300) : 0;
		const quad = r() < 0.3 ? Math.floor(r() * 50) : 0;
		const chars = Math.floor(r() * 2000);
		const plant: Plant = {
			units: (k) => {
				const u: Units = {
					...ops(k, { call: lin, prop_read: 3 * lin, compare: lin, assign: lin })
				};
				if (chars) u['dyn.string_char'] = chars * k;
				if (sort) {
					const n = sort * k;
					u['bi.Array.prototype.sort.calls'] = 1;
					u['bi.Array.prototype.sort.n'] = n;
					u['bi.Array.prototype.sort.nlogn'] = n * Math.log2(n);
				}
				if (quad) u['bi.Object.keys.calls'] = quad * k;
				if (quad) u['bi.Object.keys.n2'] = quad * k * (quad * k);
				return u;
			},
			ns: fair
		};
		inputs.push(input(`mix ${i}`, plant, 1000 + i, 0.03 + r() * 0.07));
	}
	const a = analyze_audit(inputs, { sizes: SIZES, rounds: 5, prices });
	assert.deepEqual(
		a.findings.map((f) => f.text),
		[]
	);
	assert.equal(render_audit(a, { quiet: true }), '');
	assert.match(render_audit(a), /No price suspect/);
});

test('audit: a cost per call that steps do not see is not a price', () => {
	// an await-heavy case: 40 µs per call whatever the input, then linear work
	const plant: Plant = {
		units: (k) => ({ ...ops(k, OPS), await: 2, 'dyn.string_char': 300 * k }),
		ns: (u) => 40_000 + fair(u)
	};
	const c = audit_case(input('async: a fixed wait, then work', plant, 3), prices.prices);
	assert.equal(c.suspect, null);
});

test('audit: an engine that slows a little per step as the input grows is not a price', () => {
	// caches: time grows as steps^1.15; one kind grows n log n, the rest linear
	const plant: Plant = {
		units: (k) => {
			const n = 2000 * k;
			return {
				...ops(k, OPS),
				'bi.Array.prototype.sort.calls': 1,
				'bi.Array.prototype.sort.n': n,
				'bi.Array.prototype.sort.nlogn': n * Math.log2(n)
			};
		},
		ns: (u) => 0.1 * fair(u) ** 1.15
	};
	for (let seed = 10; seed < 30; seed++) {
		const c = audit_case(input('sort: then walk', plant, seed), prices.prices);
		assert.equal(c.suspect, null, `seed ${seed}: blamed ${c.suspect?.kind}`);
	}
});
