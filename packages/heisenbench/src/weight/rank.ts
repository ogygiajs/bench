import type { DiffResult, FunctionChange } from '../diff/index.ts';
import type { FunctionReport } from '../report.ts';
import { add_units } from '../units.ts';
import type { Units } from '../units.ts';
import { load_prices } from '../prices.ts';
import { load_weights, units_ns } from '../calibrate/weights.ts';
import type { Weights } from '../calibrate/weights.ts';
import { canonical_function } from './weights.ts';
import type { AppWeights } from './weights.ts';

/*
 * Ranking changed functions by what they cost the real apps (spec 11): the change of one call
 * (steps per call, from the bench) times the calls per unit of real work (app-weights.json), so
 * "+40 steps per call" becomes "+12,000 steps (+1.2 µs) per dashboard request".
 *
 * Whether a change is shown is decided in ONE place, `judge`:
 *
 *   heavy path   the function runs >= HEAVY_CALLS times per unit, or its own steps are
 *                >= HEAVY_SHARE of the unit's steps: any change shows.
 *   warm path    it runs in some unit: the change shows when its impact is >= TINY_SHARE of the
 *                unit's steps.
 *   cold path    no scenario runs it: the change shows only when one call changes by at least
 *                COLD_STEPS steps (a big change still matters to whoever calls it); smaller ones
 *                are suppressed.
 */

export const HEAVY_CALLS = 100;
export const HEAVY_SHARE = 0.01;
export const TINY_SHARE = 1e-4;
export const COLD_STEPS = 50;

export type Heat = 'heavy' | 'warm' | 'cold';

export interface UnitImpact {
	unit: string;
	calls: number;
	/** Δ steps per unit: Δ per call × calls per unit. */
	steps: number;
	/** Δ estimated ns per unit (steps -> ns weights), when the weights are there. */
	ns: number | null;
	/** |steps| over the unit's steps. */
	share: number;
	heat: Heat;
}

export interface Judgement {
	heat: Heat;
	show: boolean;
	/** The unit the change costs most (null on a cold path). */
	top: UnitImpact | null;
	impacts: UnitImpact[];
}

/** The one decision: given a change per call and the function's weights, show it or not. */
export function judge(
	delta_per_call: number,
	weights: Record<string, { calls: number; self_steps: number }> | undefined,
	units: Record<string, { steps: number }>,
	ns_per_call: number | null = null
): Judgement {
	const impacts: UnitImpact[] = [];
	for (const [unit, w] of Object.entries(weights ?? {})) {
		if (!(w.calls > 0)) continue;
		const unit_steps = units[unit]?.steps ?? 0;
		const steps = delta_per_call * w.calls;
		const share = unit_steps > 0 ? Math.abs(steps) / unit_steps : 0;
		const self_share = unit_steps > 0 ? w.self_steps / unit_steps : 0;
		const heat: Heat = w.calls >= HEAVY_CALLS || self_share >= HEAVY_SHARE ? 'heavy' : 'warm';
		impacts.push({
			unit,
			calls: w.calls,
			steps,
			ns: ns_per_call === null ? null : ns_per_call * w.calls,
			share,
			heat
		});
	}
	impacts.sort((a, b) => Math.abs(b.steps) - Math.abs(a.steps) || (a.unit < b.unit ? -1 : 1));
	if (delta_per_call === 0) {
		return {
			heat: impacts.length ? impacts[0].heat : 'cold',
			show: false,
			top: impacts[0] ?? null,
			impacts
		};
	}
	if (impacts.length === 0) {
		return { heat: 'cold', show: Math.abs(delta_per_call) >= COLD_STEPS, top: null, impacts };
	}
	const heavy = impacts.some((i) => i.heat === 'heavy');
	const show = heavy || impacts.some((i) => i.share >= TINY_SHARE);
	return { heat: heavy ? 'heavy' : 'warm', show, top: impacts[0], impacts };
}

export interface RankedChange {
	case: string;
	module: string;
	function: string;
	/** Canonical id the weights were looked up under. */
	key: string;
	line: number;
	delta_per_call: number;
	ns_per_call: number | null;
	judgement: Judgement;
}

function per_call(f: FunctionReport | null): number {
	return f && f.calls > 0 ? f.self_steps / f.calls : 0;
}

function units_per_call(f: FunctionReport | null): Units {
	const out: Units = {};
	if (f && f.calls > 0 && f.units) add_units(out, f.units, 1 / f.calls);
	return out;
}

/** Estimated ns of one call's change (null without steps -> ns weights). */
function ns_of(c: FunctionChange, w: Weights | null): number | null {
	if (!w) return null;
	const u = units_per_call(c.pr);
	add_units(u, units_per_call(c.base), -1);
	return units_ns(u, w, load_prices().prices);
}

/** Every changed function of a diff, judged against the real-app weights, biggest impact first. */
export function rank_changes(
	d: DiffResult,
	app: AppWeights,
	ns_weights: Weights | null = load_weights()
): RankedChange[] {
	const out: RankedChange[] = [];
	for (const c of d.changes) {
		if (c.findings.length === 0) continue;
		const delta = per_call(c.pr) - per_call(c.base);
		const key = canonical_function(c.module, c.function);
		const ns = ns_of(c, ns_weights);
		out.push({
			case: c.case,
			module: c.module,
			function: c.function,
			key,
			// the line that moved most
			line: c.findings.reduce((a, f) => (Math.abs(f.delta.steps) > Math.abs(a.delta.steps) ? f : a))
				.line,
			delta_per_call: Math.round(delta * 1e4) / 1e4,
			ns_per_call: ns === null ? null : Math.round(ns * 1e3) / 1e3,
			judgement: judge(delta, app.functions[key], app.units, ns)
		});
	}
	const weight = (r: RankedChange) =>
		r.judgement.top ? Math.abs(r.judgement.top.steps) : Math.abs(r.delta_per_call) * 1e-9;
	return out.sort((a, b) => weight(b) - weight(a));
}

export function format_steps(n: number): string {
	const a = Math.abs(n);
	const sign = n < 0 ? '-' : '';
	if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(2)}G`;
	if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)}M`;
	if (a >= 1e4) return `${sign}${(a / 1e3).toFixed(1)}K`;
	return `${sign}${Math.round(a * 100) / 100}`;
}

export function format_ns(ns: number, signed = false): string {
	const sign = ns < 0 ? '-' : signed && ns > 0 ? '+' : '';
	const a = Math.abs(ns);
	if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)} ms`;
	if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)} µs`;
	return `${sign}${a.toFixed(a >= 10 ? 0 : 1)} ns`;
}

const signed = (n: number) => (n > 0 ? '+' : '') + format_steps(n);

export const WEIGHTED_MARKER = '<!-- heisenbench:weighted -->';

/** The weighted section of the PR comment. */
export function render_weighted(ranked: RankedChange[]): string {
	const shown = ranked.filter((r) => r.judgement.show);
	const hidden = ranked.filter((r) => !r.judgement.show);
	const out = [WEIGHTED_MARKER, '### Heisenbench: changes ranked by real-app weight', ''];
	if (ranked.length === 0) {
		out.push('No function changed.', '');
		return out.join('\n');
	}
	if (shown.length > 0) {
		out.push('| Function | Δ per call | Path | Real-app impact |', '| --- | ---: | --- | --- |');
		for (const r of shown) {
			const t = r.judgement.top;
			const impact = t
				? `${signed(t.steps)} steps${t.ns !== null ? ` (${format_ns(t.ns, true)})` : ''} per ${t.unit} (${format_steps(t.calls)} calls)`
				: 'no scenario runs it';
			out.push(
				`| \`${r.module} > ${r.function}\` (\`:${r.line}\`) | ${signed(r.delta_per_call)} steps | ${r.judgement.heat} | ${impact} |`
			);
		}
		out.push('');
	} else {
		out.push('Every change is on a cold path and small: nothing to show.', '');
	}
	if (hidden.length > 0) {
		out.push(
			`<details><summary>${hidden.length} suppressed (tiny, on a cold or warm path)</summary>`,
			''
		);
		for (const r of hidden) {
			out.push(
				`- \`${r.module} > ${r.function}\`: ${signed(r.delta_per_call)} steps per call, ${r.judgement.heat}${r.judgement.top ? `, ${signed(r.judgement.top.steps)} per ${r.judgement.top.unit}` : ''}`
			);
		}
		out.push('', '</details>', '');
	}
	return out.join('\n');
}
