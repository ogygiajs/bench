import type { Prices } from '../prices.ts';
import { price_units } from '../units.ts';
import type { Units } from '../units.ts';
import { input_of_units } from './features.ts';
import type { RangeInput } from './features.ts';
import { predict_change, predict_range } from './model.ts';
import type { RangesModel } from './model.ts';
import { round_range } from './text.ts';
import type { RangeValue } from './text.ts';

/*
 * The range model where a report or a diff has units: one call of a case, or a change of a
 * function. Null without a model, or when the model was trained with other prices (its steps
 * would not mean the same).
 */

export function usable(m: RangesModel | null, prices_hash: string): m is RangesModel {
	return m !== null && m.prices.hash === prices_hash;
}

/** The range of one call of some code, from its units and what else is known of it. */
export function units_range(
	m: RangesModel,
	u: Units,
	prices: Prices,
	extra: Omit<RangeInput, 'steps_by_kind' | 'builtin_calls'> = {}
): RangeValue {
	const p = predict_range(m, input_of_units(u, prices, extra), prices);
	return round_range({ ns: p.ns, range: p.range });
}

/**
 * The range of a change from `base` to `pr` (either may be missing: the function is new, or gone).
 * The code the change lives in is the side with more steps. Null when the steps did not change.
 */
export function change_range(
	m: RangesModel,
	base: Units | null | undefined,
	pr: Units | null | undefined,
	prices: Prices
): RangeValue | null {
	const b = base ? price_units(base, prices) : 0;
	const p = pr ? price_units(pr, prices) : 0;
	if (b === p) return null;
	const context = p >= b ? pr! : base!;
	const r = predict_change(m, p - b, input_of_units(context, prices), prices);
	return round_range({ ns: r.ns, range: r.range });
}
