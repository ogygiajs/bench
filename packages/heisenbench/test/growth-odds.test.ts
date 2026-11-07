import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fit_growth } from '../src/growth/fit.ts';
import type { GrowthCase } from '../src/growth/index.ts';
import {
	close_call,
	exact_odds,
	noisy_odds,
	odds_words,
	path_from,
	probe_size,
	top_shape
} from '../src/growth/odds.ts';
import type { GrowthOdds, Shape } from '../src/growth/odds.ts';
import { DEFAULT_PRIOR, PLANTED_COUNTS, shares } from '../src/growth/priors.ts';
import type { Report } from '../src/report.ts';
import { temp_dir, write_files } from './helpers.ts';

/*
 * Growth shape as odds (odds.ts). Every planted curve of the growth tests keeps its class with at
 * least 95% on it, under the default prior and under the planted one (the odds do not hang on the
 * prior where the points are clear). The growth findings of bench #24 on one real codebase come out
 * at least 90% superlinear, the false alarms it tuned away under 50%. Close calls count one more
 * size.
 */

const KS = [1, 10, 100];
const LADDER = [1, 2, 4, 8];

/** The planted exact curves of growth.test.ts, with the class each must keep. */
const PLANTED: Array<[Shape, number[], (k: number) => number]> = [
	['constant', KS, () => 500],
	['log', KS, (k) => 40 + 9 * Math.log(k)],
	['linear', KS, (k) => 1000 + 5 * k],
	['n log n', KS, (k) => 7 * k * Math.log(k) + 3 * k + 20],
	['quadratic', KS, (k) => 2 * k * k + 30 * k + 4],
	['cubic', KS, (k) => k * k * k + k],
	['quartic', KS, (k) => k ** 4 + 10 * k],
	['polynomial', KS, (k) => k ** 6 + 10],
	['exponential', LADDER, (k) => 20 * 2 ** (3 * k)],
	['polynomial', LADDER, (k) => 1000 + k ** 8],
	['linear', KS, (k) => 3 * (5 + 2 * k)],
	['quadratic', [1, 2, 4, 8, 16, 32], (k) => 10 + k * k]
];

function at_least(o: GrowthOdds | null, shape: Shape, p: number, what: string): void {
	assert.ok(o, `${what}: no odds`);
	assert.equal(top_shape(o), shape, `${what}: ${odds_words(o)}`);
	assert.ok(o.odds[0].p >= p, `${what}: ${odds_words(o)}`);
}

test('every planted exact curve keeps its class with at least 95% on it, and keeps it under the planted prior', () => {
	for (const [shape, ks, f] of PLANTED) {
		const ys = ks.map(f);
		assert.equal(fit_growth(ks, ys).class, shape);
		at_least(exact_odds(ks, ys, { prior: DEFAULT_PRIOR }), shape, 0.95, `${shape} ${ks.join('/')}`);
		// half the planted shapes are superlinear: a prior far from real code's still names them first
		at_least(
			exact_odds(ks, ys, { prior: shares(PLANTED_COUNTS) }),
			shape,
			0.5,
			`planted prior: ${shape} ${ks.join('/')}`
		);
	}
});

test('steps that fall have no odds; steps that start late are read from where they start', () => {
	assert.equal(exact_odds(KS, [4270184, 42654, 4231]), null);
	assert.equal(exact_odds(KS, [4270184, 42654, 423051]), null);
	// the code first runs at 10x: read from there
	const late = exact_odds(KS, [0, 300, 30000])!;
	assert.equal(late.points, 2);
	assert.ok(late.superlinear > 0.99, odds_words(late));
});

test('noisy points: a line is linear, a quadratic is quadratic, one trivial call is not a finding', () => {
	const xs = [40, 60, 90, 130, 200, 300, 450, 700, 1000, 1500];
	const noise = [1.1, 0.9, 1.2, 0.85, 1.05, 0.95, 1.15, 0.9, 1.1, 1];
	at_least(
		noisy_odds(
			xs,
			xs.map((x, i) => (500 + 20 * x) * noise[i])
		),
		'linear',
		0.95,
		'line'
	);
	at_least(
		noisy_odds(
			xs,
			xs.map((x, i) => (200 + x * x) * noise[i])
		),
		'quadratic',
		0.95,
		'quadratic'
	);
	const trivial = noisy_odds([10, ...xs.slice(4)], [5, ...xs.slice(4).map((x) => 3000 + 20 * x)])!;
	assert.ok(trivial.superlinear < 0.5, odds_words(trivial));
});

interface Key {
	kind: 'finding' | 'false alarm';
	name: string;
	source: 'scaled' | 'recorded';
	factors?: number[];
	sizes?: number[];
	steps: number[];
	ran?: string[][];
}

const KEY = JSON.parse(
	readFileSync(new URL('./growth-odds-key/recorded-findings.json', import.meta.url), 'utf8')
) as { cases: Key[] };

/** The odds recorded.ts reads for a key case. */
function key_odds(c: Key): GrowthOdds | null {
	if (c.source === 'scaled') {
		// as growth/index.ts points_odds: after another path, three sizes or more
		const from = path_from(c.ran!.map((r) => new Set(r)));
		if (from > 0 && c.factors!.length - from < 3) return null;
		return exact_odds(c.factors!.slice(from), c.steps.slice(from));
	}
	// noisy points: the calls that ran it
	const keep = c.steps.map((s, i) => [c.sizes![i], s] as const).filter(([, s]) => s > 0);
	return noisy_odds(
		keep.map(([x]) => x),
		keep.map(([, s]) => s)
	);
}

for (const c of KEY.cases) {
	test(`bench #24 ${c.kind}: ${c.name}`, () => {
		const o = key_odds(c);
		if (c.kind === 'finding') {
			assert.ok(o && o.superlinear >= 0.9, `${c.name}: ${o && odds_words(o)}, ${o?.superlinear}`);
		} else {
			assert.ok(!o || o.superlinear < 0.5, `${c.name}: ${o && odds_words(o)}, ${o?.superlinear}`);
		}
	});
}

test('doc_diff took another path from 4x: functions that ran at 1x stop', () => {
	const c = KEY.cases.find((k) => k.name === 'doc_diff')!;
	assert.equal(path_from(c.ran!.map((r) => new Set(r))), 1);
	// read over all three sizes, it looks cubic: flat, then a jump
	const all = exact_odds(c.factors!, c.steps)!;
	assert.equal(top_shape(all), 'cubic', odds_words(all));
	// from 4x, where the code returns early, two sizes say only how much it rose: undecided until
	// active sizing counts 8x (the full run), never a finding
	assert.equal(key_odds(c), null);
});

test('same points, same odds, byte for byte', () => {
	for (const c of KEY.cases) assert.equal(JSON.stringify(key_odds(c)), JSON.stringify(key_odds(c)));
	const ys = KS.map((k) => 100 + 40 * k + 0.5 * k * k);
	assert.equal(JSON.stringify(exact_odds(KS, ys)), JSON.stringify(exact_odds(KS, ys)));
});

test('a prior moves the odds only where the points do not decide', () => {
	// three sizes of a quadratic inside a linear pass: a close call
	const ys = KS.map((k) => 100 + 40 * k + 0.5 * k * k);
	const flat = exact_odds(KS, ys, {
		prior: {
			constant: 1,
			log: 1,
			linear: 1,
			'n log n': 1,
			quadratic: 1,
			cubic: 1,
			quartic: 1,
			polynomial: 1,
			exponential: 1
		}
	})!;
	const found = exact_odds(KS, ys)!;
	assert.equal(top_shape(found), 'quadratic');
	assert.ok(close_call(found), odds_words(found));
	assert.notEqual(flat.odds[0].p, found.odds[0].p);
	// a fourth size decides it, whatever the prior
	const k4 = [1, 10, 30, 100];
	at_least(
		exact_odds(
			k4,
			k4.map((k) => 100 + 40 * k + 0.5 * k * k)
		),
		'quadratic',
		0.99,
		'with 30x'
	);
});

test('the one more size of active sizing sits between the two largest', () => {
	assert.equal(probe_size([1, 10, 100]), 30);
	assert.equal(probe_size([1, 4, 16]), 8);
	assert.equal(probe_size([1, 2, 4, 8]), 6);
	assert.equal(probe_size([1, 2]), null);
});

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const BENCH_API = fileURLToPath(new URL('../src/bench.ts', import.meta.url));

const LIB = `
// a heavy linear pass with a light quadratic inside: three sizes leave it a close call
export function pass_and_pairs(xs) {
	let n = 0;
	for (const x of xs) for (let r = 0; r < 40; r++) n += x;
	for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) n++;
	return n;
}
export function pass(xs) {
	let n = 0;
	for (const x of xs) n += x;
	return n;
}
`;

const BENCH = `
import { bench } from 'HEISENBENCH_BENCH';
import { pass_and_pairs, pass } from './lib.js';
bench('pass and pairs', ({ xs }) => pass_and_pairs(xs), { setup: () => ({ xs: [1] }) });
bench('pass', ({ xs }) => pass(xs), { setup: () => ({ xs: [1, 2, 3] }) });
`;

test('growth: a close call counts one more size, a clear curve does not', async () => {
	const dir = temp_dir('heisenbench-growth-odds-');
	write_files(dir, {
		'lib.js': LIB,
		'lib.bench.ts': BENCH.replace('HEISENBENCH_BENCH', BENCH_API)
	});
	const { stdout } = await run(
		process.execPath,
		['--no-warnings', CLI, 'growth', 'lib.bench.ts', '--root', dir],
		{ cwd: dir }
	);
	const report = JSON.parse(readFileSync(join(dir, 'heisenbench-report.json'), 'utf8')) as Report;
	const by = new Map<string, GrowthCase>(report.growth!.cases.map((c) => [c.name, c]));
	const pairs = by.get('pass and pairs')!;
	assert.deepEqual(
		pairs.sizes,
		[1, 10, 100],
		'the probe is not one of the sizes the class is fitted on'
	);
	assert.equal(pairs.probe?.size, 30, JSON.stringify(pairs.odds));
	at_least(pairs.odds!, 'quadratic', 0.95, 'pass and pairs with 30x');
	assert.match(stdout, /pass and pairs .*odds quadratic \S+ \(with 30x\)/);
	const pass = by.get('pass')!;
	assert.equal(pass.probe, undefined);
	at_least(pass.odds!, 'linear', 0.95, 'pass');
});
