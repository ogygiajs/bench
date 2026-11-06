// The noise rule: whether a PR build sits apart from its base build, both measured in the same job
// on the same runner. Comparing with a result from another run would compare two machines:
// GitHub-hosted runners differ by up to 2x in server throughput for the same code.

/** A metric with at least this many repeats of each build is judged against its own noise. */
export const MIN_REPEATS = 3;

/** How one metric is judged. */
export interface Rule {
	/** Which way is better. */
	better: 'lower' | 'higher';
	/**
	 * The smallest change that counts, in the metric's own unit (`abs`) and in percent of the base
	 * (`pct`); a change has to exceed both. For a timing this is only the size below which a change
	 * does not matter (the repeats decide what is noise); for a metric measured once it is the rule.
	 */
	floor?: { pct?: number; abs?: number };
	/** Measured once per build (a size, a count): exact, judged by its floor alone. */
	once?: boolean;
}

export interface Verdict {
	pr: number;
	base: number;
	diff: number;
	regressed: boolean;
	improved: boolean;
	/** Judged from repeats: the spread (max - min) of the PR's and the base's repeats. */
	spread?: [number, number];
	prSamples?: number[];
	baseSamples?: number[];
	/** Measured once: judged by its floor. */
	once?: boolean;
	/** A timing with too few repeats: not judged. */
	unjudged?: boolean;
}

export function median(xs: readonly number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export const spreadOf = (xs: readonly number[]): number => Math.max(...xs) - Math.min(...xs);

/** The floor of a change from `base`: the larger of the absolute and the relative part. */
export function floorOf(rule: Rule, base: number): number {
	const { pct = 0, abs = 0 } = rule.floor ?? {};
	return Math.max(abs, (Math.abs(base) * pct) / 100);
}

/**
 * How the PR sits against the base. With repeats of both builds, a metric changed (for the worse
 * or the better) only when
 *   1. the two sets of repeats do not overlap: every PR repeat is on the same side of every base
 *      repeat (with 5 and 5 that happens by chance once in 126 for two builds that perform the
 *      same, either way),
 *   2. the medians differ by more than the larger spread (max - min) of the two builds' repeats,
 *      the noise the runner showed for one build within this job,
 *   3. and the difference is above the metric's floor.
 * Anything else is within noise. A metric measured once is judged by its floor; a timing without
 * enough repeats is not judged.
 */
export function judge(
	rule: Rule,
	pr: number,
	base: number,
	prSamples?: readonly number[] | null,
	baseSamples?: readonly number[] | null
): Verdict {
	const sign = rule.better === 'lower' ? 1 : -1;
	const verdict = (changed: boolean, p: number, b: number) => ({
		regressed: changed && sign * (p - b) > 0,
		improved: changed && sign * (p - b) < 0
	});
	if (
		!rule.once &&
		prSamples &&
		baseSamples &&
		prSamples.length >= MIN_REPEATS &&
		baseSamples.length >= MIN_REPEATS
	) {
		const p = median(prSamples);
		const b = median(baseSamples);
		const spread: [number, number] = [spreadOf(prSamples), spreadOf(baseSamples)];
		const apart =
			Math.min(...prSamples) > Math.max(...baseSamples) ||
			Math.max(...prSamples) < Math.min(...baseSamples);
		const changed =
			apart && Math.abs(p - b) > Math.max(...spread) && Math.abs(p - b) > floorOf(rule, b);
		return {
			pr: p,
			base: b,
			diff: p - b,
			spread,
			prSamples: [...prSamples],
			baseSamples: [...baseSamples],
			...verdict(changed, p, b)
		};
	}
	if (rule.once)
		return {
			pr,
			base,
			diff: pr - base,
			once: true,
			...verdict(Math.abs(pr - base) > floorOf(rule, base), pr, base)
		};
	return { pr, base, diff: pr - base, unjudged: true, regressed: false, improved: false };
}
