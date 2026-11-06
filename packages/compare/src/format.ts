// Writing a verdict into a comment cell. Every helper takes the metric's own formatter, so the
// unit stays the metric's.
import type { Verdict } from './noise.ts';

export type Format = (n: number) => string;

/** `+12 ms (+3.4%)`: the change, signed, and its percent of the base when there is one. */
export function signed(diff: number, base: number, magnitude: Format): string {
	const sign = diff > 0 ? '+' : diff < 0 ? '−' : '±';
	const rel = base ? ` (${sign}${((Math.abs(diff) / Math.abs(base)) * 100).toFixed(1)}%)` : '';
	return `${sign}${magnitude(Math.abs(diff))}${rel}`;
}

/** `lo–hi` of a build's repeats, the unit written once (`69–73`, `15.1–16.0 ms`). */
export function range(xs: readonly number[], fmt: Format): string {
	const lo = fmt(Math.min(...xs));
	const hi = fmt(Math.max(...xs));
	if (lo === hi) return lo;
	const unit = / [^\d\s.,]+$/.exec(hi)?.[0];
	return `${unit && lo.endsWith(unit) ? lo.slice(0, -unit.length) : lo}–${hi}`;
}

/** ⚠️ worse beyond noise; better: better beyond noise; ≈ within noise; = the same (exact); · not judged. */
export function markOf(verdict: Verdict): string {
	if (verdict.regressed) return '⚠️';
	if (verdict.improved) return 'better';
	if (verdict.unjudged) return '·';
	return verdict.once && verdict.diff === 0 ? '=' : '≈';
}
