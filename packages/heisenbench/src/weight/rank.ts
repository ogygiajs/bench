import type { DiffResult, FunctionChange } from '../diff/index.ts';
import type { FunctionReport, Report } from '../report.ts';
import { add_units } from '../units.ts';
import type { Units } from '../units.ts';
import { load_prices } from '../prices.ts';
import { load_weights, units_ns } from '../calibrate/weights.ts';
import type { Weights } from '../calibrate/weights.ts';
import { diff_growth } from '../growth/index.ts';
import { recorded_findings } from '../growth/recorded.ts';
import { context_path } from '../identity.ts';
import { canonical_function } from './weights.ts';
import type { AppWeights } from './weights.ts';
import {
	app_server_calls,
	calls_text,
	cost_context,
	cost_text,
	coverage_line,
	exposure_cost,
	real_cost,
	traffic_unit
} from './cost.ts';
import type { RealCost } from './cost.ts';

/*
 * Ranking findings by what they cost (spec 11). Three bases, the best one there is:
 *
 *   real traffic   weights imported from production profiles (traffic.ts): the change per call
 *                  times the real calls per request times requests per day, in CPU time
 *                  (cost.ts), with a range;
 *   app weights    the counted app scenarios: the change of one call times the calls per unit of
 *                  real work, so "+40 steps per call" becomes "+12,000 steps (+1.2 µs) per
 *                  dashboard request";
 *   steps          neither: the change per call.
 *
 * The findings are the changed functions of a diff, the growth cases whose class changed (the
 * function with the most self steps, its Δ at the bench's own input) and the functions that grow
 * from recorded calls (what they take on the traffic now).
 *
 * Whether a change is shown is decided in ONE place, `judge`:
 *
 *   real path    real traffic runs it: any change shows.
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

export type Basis = 'real traffic' | 'app weights' | 'steps';

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

/**
 * The one decision: given a change per call and the function's weights, show it or not. Units of
 * real traffic are not counted (they have no steps): their cost, when there is one, shows the change.
 */
export function judge(
	delta_per_call: number,
	weights: Record<string, { calls: number; self_steps: number }> | undefined,
	units: Record<string, { steps: number; traffic?: unknown }>,
	ns_per_call: number | null = null,
	real: RealCost | null = null
): Judgement {
	const impacts: UnitImpact[] = [];
	for (const [unit, w] of Object.entries(weights ?? {})) {
		if (!(w.calls > 0) || units[unit]?.traffic) continue;
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
	const on_real = real !== null && real.ns !== 0;
	if (impacts.length === 0) {
		return {
			heat: 'cold',
			show: on_real || Math.abs(delta_per_call) >= COLD_STEPS,
			top: null,
			impacts
		};
	}
	const heavy = impacts.some((i) => i.heat === 'heavy');
	const show = on_real || heavy || impacts.some((i) => i.share >= TINY_SHARE);
	return { heat: heavy ? 'heavy' : 'warm', show, top: impacts[0], impacts };
}

export interface RankedChange {
	/** `change`: a changed function; `growth`: a case whose curve class changed; `recorded growth`. */
	kind?: 'change' | 'growth' | 'recorded growth';
	case: string;
	module: string;
	function: string;
	/** Canonical id the weights were looked up under. */
	key: string;
	line: number;
	delta_per_call: number;
	ns_per_call: number | null;
	judgement: Judgement;
	/** What it costs on real traffic, when real-traffic weights are given and run it. */
	cost?: RealCost | null;
	/** A growth finding's own words. */
	text?: string;
}

function per_call(f: FunctionReport | null): number {
	return f && f.calls > 0 ? f.self_steps / f.calls : 0;
}

function units_per_call(f: FunctionReport | null): Units {
	const out: Units = {};
	if (f && f.calls > 0 && f.units) add_units(out, f.units, 1 / f.calls);
	return out;
}

function has_units(f: FunctionReport | null): boolean {
	return !!f && f.calls > 0 && !!f.units;
}

/** Estimated ns of one call's change (null without steps -> ns weights). */
function ns_of(c: FunctionChange, w: Weights | null): number | null {
	if (!w) return null;
	const u = units_per_call(c.pr);
	add_units(u, units_per_call(c.base), -1);
	return units_ns(u, w, load_prices().prices);
}

export interface RankOptions {
	/** Requests per day for the real cost (default: the profiles' rate). */
	requests_per_day?: number;
}

/** Which basis a set of weights ranks on. */
export function basis_of(app: AppWeights | null): Basis {
	if (traffic_unit(app)) return 'real traffic';
	if (app && Object.keys(app.units).length > 0) return 'app weights';
	return 'steps';
}

/** The order of a ranking: by the basis, then the next one down, then the name. */
function by_basis(basis: Basis): (a: RankedChange, b: RankedChange) => number {
	const real = (r: RankedChange) => (r.cost ? Math.abs(r.cost.cpu_s_per_day) : -1);
	const app = (r: RankedChange) => (r.judgement.top ? Math.abs(r.judgement.top.steps) : -1);
	const steps = (r: RankedChange) => Math.abs(r.delta_per_call);
	const keys =
		basis === 'real traffic'
			? [real, app, steps]
			: basis === 'app weights'
				? [app, steps]
				: [steps];
	return (a, b) => {
		for (const k of keys) {
			const d = k(b) - k(a);
			if (d !== 0) return d;
		}
		return a.key < b.key ? -1 : a.key > b.key ? 1 : a.case < b.case ? -1 : a.case > b.case ? 1 : 0;
	};
}

/** Every changed function of a diff, judged against the weights, biggest impact first. */
export function rank_changes(
	d: DiffResult,
	app: AppWeights | null,
	ns_weights: Weights | null = load_weights(),
	o: RankOptions = {}
): RankedChange[] {
	const out: RankedChange[] = [];
	const traffic = traffic_unit(app);
	const ctx = cost_context(ns_weights, o.requests_per_day);
	for (const c of d.changes) {
		if (c.findings.length === 0) continue;
		const delta = per_call(c.pr) - per_call(c.base);
		const key = canonical_function(c.module, c.function);
		const ns = ns_of(c, ns_weights);
		const w = app?.functions[key];
		let cost: RealCost | null = null;
		if (traffic && w) {
			const units = has_units(c.pr) || has_units(c.base) ? units_per_call(c.pr) : null;
			if (units) add_units(units, units_per_call(c.base), -1);
			cost = real_cost(
				w[traffic.key],
				traffic,
				{
					delta_steps: delta,
					delta_units: units,
					ref_steps: per_call(c.base),
					ref_units: has_units(c.base) ? units_per_call(c.base) : null,
					kind: 'self',
					per_call: true,
					app_calls: app_server_calls(app, key)
				},
				ctx
			);
		}
		out.push({
			kind: 'change',
			case: c.case,
			module: c.module,
			function: c.function,
			key,
			// the line that moved most
			line: c.findings.reduce((a, f) => (Math.abs(f.delta.steps) > Math.abs(a.delta.steps) ? f : a))
				.line,
			delta_per_call: Math.round(delta * 1e4) / 1e4,
			ns_per_call: ns === null ? null : Math.round(ns * 1e3) / 1e3,
			judgement: judge(delta, w, app?.units ?? {}, ns, cost),
			cost
		});
	}
	return out.sort(by_basis(basis_of(app)));
}

function split_id(id: string): { module: string; function: string } {
	const at = id.indexOf(' > ');
	return at === -1
		? { module: id, function: '' }
		: { module: id.slice(0, at), function: id.slice(at + 3) };
}

const SHOWN: Judgement = { heat: 'cold', show: true, top: null, impacts: [] };

/**
 * The growth cases whose class changed, by their function with the most self steps: its Δ at the
 * bench's own input (the first size) over its base there. Its steps are per run of the case, so
 * only an inferred call count (the same unit on both sides) prices it.
 */
export function rank_growth(
	base: Report,
	pr: Report,
	app: AppWeights | null,
	o: RankOptions = {}
): RankedChange[] {
	if (!base.growth || !pr.growth) return [];
	const findings = diff_growth(base.growth, pr.growth).findings;
	const traffic = traffic_unit(app);
	const ctx = cost_context(null, o.requests_per_day);
	const out: RankedChange[] = [];
	for (const f of findings) {
		const p = pr.growth.cases.find((c) => c.name === f.case);
		const b = base.growth.cases.find((c) => c.name === f.case);
		const top = p?.top?.[0];
		if (!top) continue;
		const { module, function: fn } = split_id(top.id);
		const key = canonical_function(module, fn);
		const twin = b?.top?.find((t) => context_path(t.id) === context_path(top.id));
		const ref = twin?.steps[0] ?? 0;
		const delta = top.steps[0] - ref;
		const w = traffic ? app?.functions[key]?.[traffic.key] : undefined;
		const cost =
			traffic && w
				? ref > 0
					? real_cost(
							w,
							traffic,
							{ delta_steps: delta, ref_steps: ref, kind: 'self', per_call: false },
							ctx
						)
					: exposure_cost(w, traffic, 'self', ctx)
				: null;
		out.push({
			kind: 'growth',
			case: f.case,
			module,
			function: fn,
			key,
			line: 0,
			delta_per_call: Math.round(delta * 1e4) / 1e4,
			ns_per_call: null,
			judgement: SHOWN,
			cost,
			text: f.text
		});
	}
	return out;
}

/** The functions that grow from recorded calls, by cause: what each takes on the traffic now. */
export function rank_recorded(
	pr: Report,
	app: AppWeights | null,
	o: RankOptions = {}
): RankedChange[] {
	if (!pr.recorded_growth) return [];
	const traffic = traffic_unit(app);
	const ctx = cost_context(null, o.requests_per_day);
	return recorded_findings(pr.recorded_growth).map((g) => {
		const { module, function: fn } = split_id(g.cause);
		const key = canonical_function(module, fn);
		const w = traffic ? app?.functions[key]?.[traffic.key] : undefined;
		return {
			kind: 'recorded growth' as const,
			case: g.findings[0]?.id ?? g.cause,
			module,
			function: fn,
			key,
			line: 0,
			delta_per_call: 0,
			ns_per_call: null,
			judgement: SHOWN,
			cost: traffic && w ? exposure_cost(w, traffic, 'self', ctx) : null,
			text: `${g.cause} grows ${g.class ?? 'superlinearly'} (power ${g.power}) under ${g.findings.length} recorded function(s)`
		};
	});
}

export interface Ranking {
	basis: Basis;
	/** The changed functions and the growth cases, by the basis. */
	ranked: RankedChange[];
	/** Growth from recorded calls, by what each cause takes on the traffic now. */
	recorded: RankedChange[];
	/** Real traffic: how much of the sampled time mapped to counted functions. */
	coverage: string | null;
}

/** Every finding of a comparison, ranked on the best basis the weights allow. */
export function rank_findings(
	d: DiffResult,
	base: Report | null,
	pr: Report | null,
	app: AppWeights | null,
	ns_weights: Weights | null = load_weights(),
	o: RankOptions = {}
): Ranking {
	const basis = basis_of(app);
	const ranked = [
		...rank_changes(d, app, ns_weights, o),
		...(base && pr ? rank_growth(base, pr, app, o) : [])
	].sort(by_basis(basis));
	const recorded = pr ? rank_recorded(pr, app, o).sort(by_basis(basis)) : [];
	return { basis, ranked, recorded, coverage: coverage_line(app) };
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

/** `+3.1M steps per call in `f`, ~40 calls/request on the imported traffic → ≈ 12 CPU-minutes/day ...` */
export function real_cost_text(r: RankedChange): string | null {
	const c = r.cost;
	if (!c) return null;
	if (c.what === 'now')
		return `takes ${cost_text(c)} on the imported traffic now (${calls_text(c)})`;
	const per = r.kind === 'growth' ? 'per run of the case, at its own input' : 'per call';
	return `${signed(r.delta_per_call)} steps ${per} in \`${r.function}\`, ${calls_text(c)} on the imported traffic → ${cost_text(c)}`;
}

const BASIS_WORDS: Record<Basis, string> = {
	'real traffic':
		'ranked by real cost: the change times the calls of real traffic, in CPU time per day',
	'app weights':
		'ranked by real-app weight: the change per call times the calls per unit of the app scenarios',
	steps: 'ranked by steps per call: no weights given'
};

/** The weighted section of the PR comment. */
export function render_weighted(
	ranked: RankedChange[],
	basis: Basis = 'app weights',
	extra: Partial<Ranking> = {}
): string {
	const shown = ranked.filter((r) => r.judgement.show);
	const hidden = ranked.filter((r) => !r.judgement.show);
	const out = [WEIGHTED_MARKER, '### Heisenbench: changes ranked by real-app weight', ''];
	if (basis !== 'app weights' || extra.coverage) {
		out.push(`Basis: ${BASIS_WORDS[basis]}.${extra.coverage ? ` ${extra.coverage}.` : ''}`, '');
	}
	if (ranked.length === 0 && (extra.recorded ?? []).length === 0) {
		out.push('No function changed.', '');
		return out.join('\n');
	}
	if (shown.length > 0) {
		const real = basis === 'real traffic';
		out.push(
			real
				? '| Function | Δ per call | Path | Real cost | Real-app impact |'
				: '| Function | Δ per call | Path | Real-app impact |',
			real ? '| --- | ---: | --- | --- | --- |' : '| --- | ---: | --- | --- |'
		);
		for (const r of shown) {
			const t = r.judgement.top;
			const impact = t
				? `${signed(t.steps)} steps${t.ns !== null ? ` (${format_ns(t.ns, true)})` : ''} per ${t.unit} (${format_steps(t.calls)} calls)`
				: 'no scenario runs it';
			const id = `\`${r.module} > ${r.function}\``;
			const name =
				r.kind === 'growth'
					? `${id} (growth of \`${r.case}\`)`
					: `${id}${r.line > 0 ? ` (\`:${r.line}\`)` : ''}`;
			const path = r.kind === 'growth' ? 'growth' : r.judgement.heat;
			const cost = r.cost
				? `${calls_text(r.cost)} → ${cost_text(r.cost)}`
				: 'not in the imported traffic';
			out.push(
				real
					? `| ${name} | ${signed(r.delta_per_call)} steps | ${path} | ${cost} | ${impact} |`
					: `| ${name} | ${signed(r.delta_per_call)} steps | ${path} | ${impact} |`
			);
		}
		out.push('');
	} else if (ranked.length > 0) {
		out.push('Every change is on a cold path and small: nothing to show.', '');
	}
	const rec = extra.recorded ?? [];
	if (rec.length > 0) {
		out.push(
			'Growth from recorded calls, by what the growing function takes on the imported traffic now:',
			''
		);
		for (const r of rec) {
			const c = real_cost_text(r);
			out.push(`- \`${r.module} > ${r.function}\`: ${c ?? 'not in the imported traffic'}`);
		}
		out.push('');
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
