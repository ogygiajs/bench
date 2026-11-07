import type { Rng } from './mutate.ts';

/*
 * The search's operator schedule as a bandit (Thompson sampling). Each mutation operator is an arm.
 *
 * Reward: the step-density gain the arm's edit made over the input it edited, squashed into
 * [0, 1): `gain / (gain + REWARD_HALF)`, where gain is new density / old density - 1. An edit that
 * made the input no denser, that the code rejected, or that did not fit the size limit, gets 0.
 *
 * Belief: each arm's reward rate has a Beta posterior. A reward r adds r to the arm's wins and
 * 1 - r to its losses. The prior is the same for every arm: the rate pooled over all arms so far,
 * worth PRIOR_TRIES tries. A flat Beta(1, 1) prior does not work here: rewards are rare (most
 * edits gain nothing), so an arm that has run a lot sits near its true low rate while one that has
 * barely run still looks like a coin flip, and the schedule drifts toward running every operator
 * equally. With the pooled prior an arm moves off the average only on its own evidence.
 *
 * Choice: each try draws a rate for every arm that can change the input and runs one at random,
 * in proportion to its share in the fixed schedule times its draw. Before any evidence that is the
 * fixed schedule; an arm that keeps making the input denser is run more, one that never does
 * less, and none is ever ruled out.
 *
 * Every draw comes from the search's seeded generator and the math is +, *, /, sqrt, log and exp,
 * which V8 computes the same on every machine: the same seed gives the same schedule.
 */

/** A density gain of this much (25%) is worth a reward of 1/2. */
export const REWARD_HALF = 0.25;
/** How many tries of evidence the pooled prior is worth. */
export const PRIOR_TRIES = 16;

/** A uniform number in (0, 1). */
function unit(r: Rng): number {
	return (r.u32() + 0.5) / 2 ** 32;
}

/** A standard normal draw (Marsaglia's polar method: no sin or cos). */
function normal(r: Rng): number {
	for (;;) {
		const u = 2 * unit(r) - 1;
		const v = 2 * unit(r) - 1;
		const s = u * u + v * v;
		if (s > 0 && s < 1) return u * Math.sqrt((-2 * Math.log(s)) / s);
	}
}

/** A Gamma(k, 1) draw (Marsaglia and Tsang; below 1, boosted by a uniform's 1/k-th power). */
function gamma(r: Rng, k: number): number {
	if (k < 1) return gamma(r, k + 1) * Math.exp(Math.log(unit(r)) / k);
	const d = k - 1 / 3;
	const c = 1 / Math.sqrt(9 * d);
	for (;;) {
		let x: number;
		let v: number;
		do {
			x = normal(r);
			v = 1 + c * x;
		} while (v <= 0);
		v = v * v * v;
		const u = unit(r);
		if (u < 1 - 0.0331 * x * x * x * x) return d * v;
		if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
	}
}

/** A Beta(a, b) draw, for a, b > 0. */
export function beta(r: Rng, a: number, b: number): number {
	const x = gamma(r, a);
	const y = gamma(r, b);
	return x / (x + y);
}

/** The reward of an edit that took the density from `before` to `after`. */
export function density_reward(before: number, after: number): number {
	if (!(after > before)) return 0;
	if (!(before > 0)) return 1;
	const gain = after / before - 1;
	return gain / (gain + REWARD_HALF);
}

export interface ArmStat {
	arm: string;
	/** Inputs this arm made that were run. */
	tries: number;
	/** Of them, the ones denser than the input they were made from. */
	gains: number;
}

interface Arm {
	wins: number;
	losses: number;
	tries: number;
	gains: number;
}

export class Bandit {
	#arms = new Map<string, Arm>();
	/** Wins and losses over all arms (the prior's evidence). */
	#wins = 0;
	#losses = 0;

	#arm(name: string): Arm {
		let a = this.#arms.get(name);
		if (!a) {
			a = { wins: 0, losses: 0, tries: 0, gains: 0 };
			this.#arms.set(name, a);
		}
		return a;
	}

	/** The arm to run next, of `choices` (each with its share in the fixed schedule). */
	pick(choices: readonly { arm: string; weight: number }[], r: Rng): string {
		const mean = (this.#wins + 1) / (this.#wins + this.#losses + 2);
		const a0 = PRIOR_TRIES * mean;
		const b0 = PRIOR_TRIES * (1 - mean);
		const cum: number[] = [];
		let total = 0;
		for (const c of choices) {
			const a = this.#arm(c.arm);
			cum.push((total += c.weight * beta(r, a0 + a.wins, b0 + a.losses)));
		}
		const at = unit(r) * total;
		for (let i = 0; i < choices.length; i++) if (at < cum[i]) return choices[i].arm;
		return choices[choices.length - 1].arm;
	}

	/** Book `reward` (in [0, 1]) for an input `name` made that was run. */
	reward(name: string, reward: number): void {
		const x = Math.min(1, Math.max(0, reward));
		this.#book(name, x);
		const a = this.#arm(name);
		a.tries++;
		if (x > 0) a.gains++;
	}

	/**
	 * `name` made an edit that did not fit (too big, or nothing it could change). No try was spent,
	 * but it gained nothing: booked as a reward of 0, so an arm that never fits fades.
	 */
	miss(name: string): void {
		this.#book(name, 0);
	}

	#book(name: string, x: number): void {
		const a = this.#arm(name);
		a.wins += x;
		a.losses += 1 - x;
		this.#wins += x;
		this.#losses += 1 - x;
	}

	/** The arms that ran, most tries first (by name on a tie). */
	stats(): ArmStat[] {
		return [...this.#arms.entries()]
			.filter(([, a]) => a.tries > 0)
			.map(([arm, a]) => ({ arm, tries: a.tries, gains: a.gains }))
			.sort((x, y) => y.tries - x.tries || (x.arm < y.arm ? -1 : x.arm > y.arm ? 1 : 0));
	}
}
