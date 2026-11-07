import type { TrendCreep, TrendPoint, TrendResult } from './index.ts';

/*
 * Planted series for the trend model: what `heisenbench verify` (layer `trend`) and
 * test/trend.test.ts check it against. Each is a list of per-commit moves (0.01 is a commit that
 * adds 1% to the steps), turned into exact step counts; commit i is `c<i>`.
 */

export interface PlantedTrend {
	name: string;
	what: string;
	moves: number[];
	expect: {
		verdict: TrendResult['verdict'];
		/** Each creep: the commit it starts at, its status. */
		creeps: Array<{ start: string; status: TrendCreep['status'] }>;
		/** The commits with a step. */
		steps: string[];
	};
}

/** A small seeded generator (mulberry32): the same seed, the same numbers. */
export function seeded(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A standard normal draw (Box-Muller) from a seeded generator. */
export function normal(r: () => number): number {
	return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

export function sha_of(i: number): string {
	return `c${String(i).padStart(2, '0')}`;
}

/** Exact steps from the moves: commit 0 counts `base`, each next one its move more. */
export function planted_series(moves: readonly number[], base = 1_000_000): TrendPoint[] {
	let v = base;
	return moves.map((m, i) => {
		v = Math.round(v * (1 + m));
		return { sha: sha_of(i), steps: v };
	});
}

const flat = (k: number): number[] => Array.from({ length: k }, () => 0);

/** Churn on every commit (a normal move of `sd`), seeded. */
export function churn(n: number, sd: number, seed: number): number[] {
	const r = seeded(seed);
	return Array.from({ length: n }, () => sd * normal(r));
}

function noisy_creep(): number[] {
	const m = churn(40, 0.003, 13);
	for (let i = 15; i < 23; i++) m[i] += 0.01;
	return m;
}

export const PLANTED_TRENDS: PlantedTrend[] = [
	{
		name: 'flat',
		what: '30 commits, no change',
		moves: flat(30),
		expect: { verdict: 'flat', creeps: [], steps: [] }
	},
	{
		name: 'step',
		what: 'one commit adds 10%, among flat commits',
		moves: [...flat(15), 0.1, ...flat(14)],
		expect: { verdict: 'step', creeps: [], steps: ['c15'] }
	},
	{
		name: 'creep',
		what: 'five PRs that each add 1%, among flat commits',
		moves: [...flat(12), 0.01, 0, 0.01, 0, 0, 0.01, 0.01, 0, 0.01, ...flat(11)],
		expect: { verdict: 'creep', creeps: [{ start: 'c12', status: 'held' }], steps: [] }
	},
	{
		name: 'creep-revert',
		what: 'five 1% rises, then one commit takes 5% back',
		moves: [...flat(10), 0.01, 0.01, 0.01, 0, 0.01, 0.01, ...flat(5), -0.05, ...flat(8)],
		expect: {
			verdict: 'creep',
			creeps: [{ start: 'c10', status: 'reverted' }],
			steps: ['c21']
		}
	},
	{
		name: 'creep-churn',
		what: 'eight 1% rises on churn of 0.3% every commit',
		moves: noisy_creep(),
		expect: { verdict: 'creep', creeps: [{ start: 'c15', status: 'held' }], steps: [] }
	},
	{
		name: 'two-creeps',
		what: 'four 1% rises, ten flat commits, four 1.2% rises',
		moves: [
			...flat(6),
			0.01,
			0.01,
			0.01,
			0.01,
			...flat(10),
			0,
			0.012,
			0,
			0.012,
			0.012,
			0.012,
			...flat(6)
		],
		expect: {
			verdict: 'creep',
			creeps: [
				{ start: 'c06', status: 'held' },
				{ start: 'c21', status: 'held' }
			],
			steps: []
		}
	},
	{
		name: 'creep-rising',
		what: 'five 0.8% rises up to the newest commit',
		moves: [...flat(20), 0.008, 0.008, 0, 0.008, 0.008, 0.008],
		expect: { verdict: 'creep', creeps: [{ start: 'c20', status: 'rising' }], steps: [] }
	},
	{
		name: 'step-then-creep',
		what: 'an 8% step, then four 1% rises',
		moves: [...flat(5), 0.08, ...flat(5), 0.01, 0.01, 0.01, 0.01, ...flat(8)],
		expect: { verdict: 'creep', creeps: [{ start: 'c11', status: 'held' }], steps: ['c05'] }
	},
	{
		name: 'two-small-steps',
		what: 'two 1.5% rises far apart: not a trend',
		moves: [...flat(10), 0.015, ...flat(10), 0.015, ...flat(8)],
		expect: { verdict: 'flat', creeps: [], steps: [] }
	},
	{
		name: 'churn',
		what: 'churn of 0.5% every commit, no trend',
		moves: churn(40, 0.005, 5),
		expect: { verdict: 'flat', creeps: [], steps: [] }
	},
	{
		name: 'slow-descent',
		what: 'eight 1% falls: faster, not creep',
		moves: [...flat(10), ...Array.from({ length: 8 }, () => -0.01), ...flat(8)],
		expect: { verdict: 'flat', creeps: [], steps: [] }
	}
];

/** What the model said, in the same shape as `expect`. */
export function trend_answer(r: TrendResult): PlantedTrend['expect'] {
	return {
		verdict: r.verdict,
		creeps: r.creeps.map((c) => ({ start: c.start, status: c.status })),
		steps: r.steps.map((s) => s.sha)
	};
}
