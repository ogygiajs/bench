import { builtin_call_name, load_prices } from './prices.ts';
import type { Prices } from './prices.ts';
import { price_units, priced_size_terms } from './units.ts';
import type { Units } from './units.ts';
import type { CaseReport, FunctionReport, Report } from './report.ts';

/*
 * A price change recounts both sides (spec 2). Two reports counted with different price files
 * (`prices.hash`) are not comparable as they are; the units each report keeps (units.ts) are
 * priced again with one price file, and the reports compare as if both had been counted with it.
 *
 * Exact for self steps, lines, blocks, built-in entries and totals. Inclusive steps are a running
 * total kept by the counting runtime and cannot be split back into units: a recounted report keeps
 * the old inclusive steps and says so (`prices.recounted_from`), and the diff ignores them.
 */

/**
 * Whether the report's units say everything `prices` charges for: units on every function, and
 * every size term the prices use kept by the run (a report from before `parts` were kept has no
 * parts to price, and would read as cheaper than the same run counted today).
 */
function has_units(r: Report, prices: Prices): boolean {
	const kept = new Set(r.unit_terms ?? []);
	for (const t of priced_size_terms(prices)) if (!kept.has(t)) return false;
	return r.cases.every((c) => c.functions.every((f) => f.units !== undefined));
}

function pick(u: Units, keep: (key: string) => boolean): Units {
	const out: Units = {};
	for (const k of Object.keys(u)) if (keep(k)) out[k] = u[k];
	return out;
}

function builtin_name_of_unit(k: string): string | null {
	if (!k.startsWith('bi.')) return null;
	return builtin_call_name(k.slice(3, k.lastIndexOf('.')));
}

function recount_function(f: FunctionReport, prices: Prices): FunctionReport {
	const units = f.units ?? {};
	const blocks = f.blocks.map((b) => {
		const price = b.ops ? price_units(b.ops, prices) : b.price;
		return { ...b, price, steps: Math.round(b.count * price * 1e6) / 1e6 };
	});
	const lines = f.lines.map((l) => ({
		...l,
		steps: l.units ? price_units(l.units, prices) : l.steps
	}));
	const line_units = new Map(f.lines.map((l) => [l.line, l.units ?? {}]));
	// Entries that share a line and a name (`xs.map(f).map(g)`) split their line's units; a report
	// that keeps units per site prices each one exactly.
	const group = (b: { line: number; name: string }) => `${b.line} ${b.name}`;
	const counted = new Map<string, number>();
	for (const b of f.builtins) counted.set(group(b), (counted.get(group(b)) ?? 0) + b.steps);
	const sited = new Map<string, number>();
	const builtins = f.builtins.map((b) => {
		if (b.line === 0) return b;
		let steps: number;
		if (b.units) {
			steps = price_units(b.units, prices);
		} else {
			const u = pick(line_units.get(b.line) ?? {}, (k) => builtin_name_of_unit(k) === b.name);
			const all = counted.get(group(b)) ?? 0;
			const share = all > 0 ? b.steps / all : 1;
			steps = Math.round(price_units(u, prices) * share * 1e6) / 1e6;
		}
		sited.set(b.name, (sited.get(b.name) ?? 0) + steps);
		return { ...b, steps };
	});
	for (let i = 0; i < builtins.length; i++) {
		const b = builtins[i];
		if (b.line !== 0) continue;
		const all = price_units(
			pick(units, (k) => builtin_name_of_unit(k) === b.name),
			prices
		);
		builtins[i] = { ...b, steps: Math.round((all - (sited.get(b.name) ?? 0)) * 1e6) / 1e6 };
	}
	return {
		...f,
		self_steps: price_units(units, prices),
		blocks,
		shape: blocks.map((b) => b.price),
		lines,
		builtins
	};
}

function recount_case(c: CaseReport, prices: Prices): CaseReport {
	const functions = c.functions.map((f) => recount_function(f, prices));
	const steps = functions.reduce((s, f) => s + f.self_steps, 0);
	return {
		...c,
		functions,
		totals: { ...c.totals, steps: Math.round(steps * 1e6) / 1e6 }
	};
}

/** A report counted again with `prices` (the default: the current prices.json). */
export function recount(report: Report, with_prices = load_prices()): Report {
	if (report.prices.hash === with_prices.hash) return report;
	if (!has_units(report, with_prices.prices))
		throw new Error('heisenbench: the report has no units to recount from');
	return {
		...report,
		prices: {
			version: with_prices.prices.version,
			hash: with_prices.hash,
			recounted_from: { version: report.prices.version, hash: report.prices.hash }
		},
		cases: report.cases.map((c) => recount_case(c, with_prices.prices))
	};
}

export interface Aligned {
	base: Report;
	pr: Report;
	/** Both sides now use the same prices. */
	comparable: boolean;
	/** The prices both sides were recounted with, when they differed. */
	recounted: { version: number; hash: string } | null;
}

/** Bring two reports to one price file: as they are when it is the same, else both recounted. */
export function align_prices(base: Report, pr: Report, with_prices = load_prices()): Aligned {
	if (base.prices.hash === pr.prices.hash) return { base, pr, comparable: true, recounted: null };
	const ready = (r: Report) =>
		r.prices.hash === with_prices.hash || has_units(r, with_prices.prices);
	if (!ready(base) || !ready(pr)) return { base, pr, comparable: false, recounted: null };
	return {
		base: recount(base, with_prices),
		pr: recount(pr, with_prices),
		comparable: true,
		recounted: { version: with_prices.prices.version, hash: with_prices.hash }
	};
}
