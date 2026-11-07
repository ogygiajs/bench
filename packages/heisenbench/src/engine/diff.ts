import { IDENTITY, LineMap } from '../diff/git.ts';
import type { FileDiff } from '../diff/git.ts';
import { IC_RANK, state_words } from './types.ts';
import { code } from '../md.ts';
import { pair_cases } from '../cases.ts';
import type { EngineCase, EngineFunction, EngineReport, EngineSite } from './types.ts';

/*
 * Engine health, PR vs base. Functions are matched by identity (`module > path`), through git file
 * renames, and by the changed hunk or site signature when a function itself was renamed. Sites are
 * matched by their id inside the function (`property read price #0`), so moving lines never shows.
 *
 * Worse (findings):  a function that is no longer optimized; a deopt reason the base did not have;
 *                    an inline cache that got more shapes (monomorphic -> polymorphic -> megamorphic);
 *                    new code that deopts or is megamorphic.
 * Better: the same, the other way round (listed, never a finding).
 * Deopts on code that had not run yet when it was optimized (see is_cold) and deopts the garbage
 * collector decides (see is_gc) are never findings.
 * A function or site either side marks unstable (its runs did not agree, see stability.ts) is left
 * out of the comparison and only counted in `skipped`: it is never a finding, never "better".
 */

export type EngineFindingKind = 'not optimized' | 'deopt' | 'inline cache';

export interface EngineFinding {
	case: string;
	kind: EngineFindingKind;
	module: string;
	function: string;
	line: number;
	/** One plain sentence: "`map.ts:44` property read `x` went monomorphic -> megamorphic". */
	text: string;
}

export interface EngineDiff {
	findings: EngineFinding[];
	better: EngineFinding[];
	/** Cases with at least one function or site skipped as unstable. */
	unstable: string[];
	/**
	 * Functions and inline-cache sites left out of the comparison because V8 did not do the same
	 * thing on every run of one side or the other: never a finding, never "better". (Results
	 * stored before it existed have none: skipped_line reads that as zero.)
	 */
	skipped: { functions: number; sites: number };
	failed: string[];
}

export interface EngineDiffOptions {
	files?: FileDiff[] | null;
	/** Run roots relative to the git top level (Report.git.prefix) of each side. */
	base_prefix?: string;
	pr_prefix?: string;
}

function strip(prefix: string, path: string): string | null {
	if (!prefix) return path;
	return path.startsWith(prefix + '/') ? path.slice(prefix.length + 1) : null;
}

function where(module: string, line: number): string {
	return code(`${module}:${line}`);
}

function signature(sites: EngineSite[]): string {
	return sites.map((s) => `${s.kind} ${s.key}`).join('|');
}

function site_suffix(s: EngineSite): string {
	return s.id.slice(s.function.length + 3);
}

function reasons(f: EngineFunction): Set<string> {
	return new Set(f.deopts.map((d) => d.reason));
}

/**
 * A deopt on code that had never run when the function was optimized (a new branch taken for the
 * first time). V8 collects the feedback and optimizes again: a one-off cost every new branch pays,
 * so it is kept in the report but never a finding.
 */
export function is_cold(reason: string): boolean {
	return reason.startsWith('Insufficient type feedback');
}

/**
 * A deopt the garbage collector decides: optimized code that embedded an object that died (a
 * closure's context, a map), or a pretenuring decision the collector changed. When it happens
 * depends on when collections run, which any allocation anywhere moves, so it is kept in the
 * report but never a finding.
 */
export function is_gc(reason: string): boolean {
	return (
		reason === 'embedded weak objects cleared' ||
		reason === 'dependent allocation site tenuring changed'
	);
}

/** A deopt that can be a finding (or a "better"). */
function counts(reason: string): boolean {
	return !is_cold(reason) && !is_gc(reason);
}

/**
 * Entries a case cannot vouch for. A case marked unstable without any marked entry (a report from
 * before per-entry marks) vouches for none of them.
 */
function untrusted(c: EngineCase): (e: { unstable?: string }) => boolean {
	const whole =
		!c.stable &&
		c.functions.every((f) => f.unstable === undefined) &&
		c.sites.every((s) => s.unstable === undefined);
	return whole ? () => true : (e) => e.unstable !== undefined;
}

function diff_case(
	b: EngineCase,
	p: EngineCase,
	module_map: Map<string, string>,
	line_maps: Map<string, LineMap>,
	out: EngineDiff
): void {
	const base_bad = untrusted(b);
	const pr_bad = untrusted(p);
	let skipped_functions = 0;
	let skipped_sites = 0;
	const pr_fns = new Map(p.functions.map((f) => [f.id, f]));
	const sites_of = (c: EngineCase): Map<string, EngineSite[]> => {
		const m = new Map<string, EngineSite[]>();
		for (const s of c.sites) {
			const list = m.get(s.function) ?? [];
			list.push(s);
			m.set(s.function, list);
		}
		return m;
	};
	const base_sites = sites_of(b);
	const pr_sites = sites_of(p);
	const pairs: Array<[EngineFunction, EngineFunction]> = [];
	const matched = new Set<string>();
	const unmatched_base: EngineFunction[] = [];
	for (const f of b.functions) {
		const module = module_map.get(f.module) ?? f.module;
		const g = pr_fns.get(`${module} > ${f.path}`);
		if (g) {
			pairs.push([f, g]);
			matched.add(g.id);
		} else {
			unmatched_base.push(f);
		}
	}
	// renamed functions: same changed hunk, same unchanged line, or the same site signature
	for (const f of unmatched_base) {
		const module = module_map.get(f.module) ?? f.module;
		const lmap = line_maps.get(module) ?? IDENTITY;
		const sig = signature(base_sites.get(f.id) ?? []);
		let pick: EngineFunction | null = null;
		for (const g of p.functions) {
			if (matched.has(g.id) || g.module !== module) continue;
			const h = lmap.removed_in(f.line);
			const same_hunk = h !== -1 && h === lmap.added_in(g.line);
			const same_line = lmap.forward(f.line) === g.line;
			const same_sig = sig.length > 0 && sig === signature(pr_sites.get(g.id) ?? []);
			if (same_hunk || same_line || same_sig) {
				pick = g;
				break;
			}
		}
		if (pick) {
			pairs.push([f, pick]);
			matched.add(pick.id);
		}
	}

	const add = (
		list: EngineFinding[],
		kind: EngineFindingKind,
		f: EngineFunction,
		line: number,
		text: string
	): void => {
		list.push({ case: p.name, kind, module: f.module, function: f.path, line, text });
	};

	for (const [f, g] of pairs) {
		if (base_bad(f) || pr_bad(g)) {
			skipped_functions++;
			continue;
		}
		const fr = reasons(f);
		const gr = reasons(g);
		const fresh = g.deopts.filter((d) => counts(d.reason) && !fr.has(d.reason));
		const gone = f.deopts.filter((d) => counts(d.reason) && !gr.has(d.reason));
		const why = (list: typeof fresh): string =>
			list
				.map((d) => `${d.reason} at line ${d.line}${d.count > 1 ? `, ${d.count}x` : ''}`)
				.join('; ');
		// cold: it now runs too few times to get optimized; that is not V8 refusing it
		if (f.optimized && !g.optimized && g.not_optimized !== 'cold') {
			const how = g.not_optimized === 'refused' ? 'V8 refused to optimize it' : `now ${g.tier}`;
			add(
				out.findings,
				'not optimized',
				g,
				g.line,
				`${where(g.module, g.line)} ${code(g.path)} is no longer optimized (${how}${fresh.length > 0 ? `; reason: ${why(fresh)}` : ''})`
			);
		} else if (fresh.length > 0) {
			add(
				out.findings,
				'deopt',
				g,
				fresh[0].line || g.line,
				`${where(g.module, fresh[0].line || g.line)} ${code(g.path)} now deoptimizes (reason: ${why(fresh)})`
			);
		}
		if (!f.optimized && g.optimized) {
			add(
				out.better,
				'not optimized',
				g,
				g.line,
				`${where(g.module, g.line)} ${code(g.path)} is optimized now (${g.tier})`
			);
		}
		if (gone.length > 0) {
			add(
				out.better,
				'deopt',
				g,
				g.line,
				`${where(g.module, g.line)} ${code(g.path)} no longer deoptimizes (was: ${why(gone)})`
			);
		}

		// sites of the pair
		const bs = base_sites.get(f.id) ?? [];
		const ps = pr_sites.get(g.id) ?? [];
		const by_suffix = new Map(bs.map((s) => [site_suffix(s), s]));
		const left_base = new Set(bs);
		const fresh_sites: EngineSite[] = [];
		const compare = (x: EngineSite, y: EngineSite): void => {
			if (base_bad(x) || pr_bad(y)) {
				skipped_sites++;
				return;
			}
			const what = `${y.kind} ${code(y.key)}`;
			if (IC_RANK[y.state] > IC_RANK[x.state]) {
				add(
					out.findings,
					'inline cache',
					g,
					y.line,
					`${where(y.module, y.line)} ${what} went ${state_words(x)} -> ${state_words(y)}`
				);
			} else if (IC_RANK[y.state] < IC_RANK[x.state]) {
				add(
					out.better,
					'inline cache',
					g,
					y.line,
					`${where(y.module, y.line)} ${what} went ${state_words(x)} -> ${state_words(y)}`
				);
			}
		};
		for (const s of ps) {
			const x = by_suffix.get(site_suffix(s));
			if (x) {
				left_base.delete(x);
				compare(x, s);
			} else {
				fresh_sites.push(s);
			}
		}
		// sites whose key changed (a renamed property): paired by kind, in order
		for (const s of fresh_sites) {
			if (pr_bad(s)) {
				skipped_sites++;
				continue;
			}
			const x = [...left_base].find((c) => c.kind === s.kind);
			if (x) {
				left_base.delete(x);
				compare(x, s);
			} else if (IC_RANK[s.state] >= IC_RANK.polymorphic) {
				add(
					out.findings,
					'inline cache',
					g,
					s.line,
					`${where(s.module, s.line)} new ${s.kind} ${code(s.key)} is ${state_words(s)}`
				);
			}
		}
	}

	// new code
	for (const g of p.functions) {
		if (matched.has(g.id)) continue;
		if (pr_bad(g)) {
			skipped_functions++;
			continue;
		}
		const hot = g.deopts.filter((x) => counts(x.reason));
		if (hot.length > 0) {
			const d = hot[0];
			add(
				out.findings,
				'deopt',
				g,
				d.line || g.line,
				`${where(g.module, d.line || g.line)} new code ${code(g.path)} deoptimizes (reason: ${d.reason})`
			);
		}
		for (const s of pr_sites.get(g.id) ?? []) {
			if (pr_bad(s)) {
				skipped_sites++;
				continue;
			}
			if (IC_RANK[s.state] >= IC_RANK.megamorphic) {
				add(
					out.findings,
					'inline cache',
					g,
					s.line,
					`${where(s.module, s.line)} new ${s.kind} ${code(s.key)} is ${state_words(s)}`
				);
			}
		}
	}

	if (skipped_functions + skipped_sites > 0) {
		out.unstable.push(p.name);
		out.skipped.functions += skipped_functions;
		out.skipped.sites += skipped_sites;
	}
}

export function diff_engine(
	base: EngineReport,
	pr: EngineReport,
	opts: EngineDiffOptions = {}
): EngineDiff {
	const out: EngineDiff = {
		findings: [],
		better: [],
		unstable: [],
		skipped: { functions: 0, sites: 0 },
		failed: []
	};
	const module_map = new Map<string, string>();
	const line_maps = new Map<string, LineMap>();
	for (const f of opts.files ?? []) {
		const pr_id = f.new_path ? strip(opts.pr_prefix ?? '', f.new_path) : null;
		const base_id = f.old_path ? strip(opts.base_prefix ?? '', f.old_path) : null;
		if (base_id && pr_id) module_map.set(base_id, pr_id);
		if (pr_id) line_maps.set(pr_id, new LineMap(f.hunks));
	}
	for (const [b, p] of pair_cases(base.cases, pr.cases).pairs) {
		if (b.error || p.error) {
			out.failed.push(b.name);
			continue;
		}
		diff_case(b, p, module_map, line_maps, out);
	}
	return out;
}

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** "3 functions and 1 inline cache skipped: V8 not repeatable (`case`)", or null. */
export function skipped_line(d: EngineDiff): string | null {
	const { functions, sites } = (d as Partial<EngineDiff>).skipped ?? { functions: 0, sites: 0 };
	if (functions + sites === 0) return null;
	const what = [
		functions > 0 ? plural(functions, 'function', 'functions') : '',
		sites > 0 ? plural(sites, 'inline cache', 'inline caches') : ''
	]
		.filter((s) => s.length > 0)
		.join(' and ');
	return `${what} skipped: V8 not repeatable (${d.unstable.map(code).join(', ')})`;
}

/** The "Engine" part of the Heisenbench section. */
export function render_engine_markdown(d: EngineDiff): string {
	const lines: string[] = ['#### Engine', ''];
	if (d.findings.length === 0) {
		lines.push('No function lost optimization, gained a deopt or a slower inline cache.', '');
	} else {
		const by_case = new Map<string, EngineFinding[]>();
		for (const f of d.findings) {
			const list = by_case.get(f.case) ?? [];
			list.push(f);
			by_case.set(f.case, list);
		}
		for (const [name, list] of by_case) {
			lines.push(`${code(name)}:`, '');
			for (const f of list) lines.push(`- ${f.text}`);
			lines.push('');
		}
	}
	if (d.better.length > 0) {
		lines.push('<details><summary>Better</summary>', '');
		for (const f of d.better) lines.push(`- ${f.text}`);
		lines.push('', '</details>', '');
	}
	const skipped = skipped_line(d);
	if (skipped) lines.push(skipped, '');
	if (d.failed.length > 0) lines.push(`**Failed**: ${d.failed.map(code).join(', ')}`, '');
	return lines.join('\n');
}
