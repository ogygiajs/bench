import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diff_reports } from '../diff/index.ts';
import { context_path } from '../identity.ts';
import type { Finding } from '../diff/index.ts';
import { git_diff } from '../diff/git.ts';
import { render_markdown } from '../diff/markdown.ts';
import { diff_engine } from '../engine/diff.ts';
import type { EngineFinding } from '../engine/diff.ts';
import type { EngineReport } from '../engine/types.ts';
import { diff_growth } from '../growth/index.ts';
import type { GrowthReport } from '../growth/index.ts';
import { diff_search } from '../search/index.ts';
import type { SearchReport } from '../search/index.ts';
import { KEYS, cli, key_files, make_pair, temp_dir } from './fixture.ts';
import type { Check } from './types.ts';

/*
 * The answer keys that live as fixture directories under test/ (each `base/` plus one directory
 * per planted change with an expect.json), one check per planted change:
 *
 *   answer-key   steps: extra loop, extra allocation, quadratic helper; no-ops: rename, comments,
 *                reorder, formatting. With `--measure bytes`: an allocation the engine elides.
 *                With `--measure leaks`: a leak and its no-leak twin.
 *   engine-key   V8: shape order, int -> double, delete (deopts), megamorphic access, each with a
 *                twin that changes the same line without changing a shape; no-ops.
 *   growth-key   a linear -> quadratic class change; a constant-factor change that is not one.
 *   search-key   slow inputs found for quadratic code; none for linear code.
 */

const variants = (key: string): string[] =>
	readdirSync(join(KEYS, key))
		.filter((d) => d !== 'base' && d !== 'pr')
		.sort();

const read_expect = <T>(key: string, name: string): T =>
	JSON.parse(readFileSync(join(KEYS, key, name, 'expect.json'), 'utf8')) as T;

const lines = (f: { line: number }[]): string =>
	[...new Set(f.map((x) => x.line))].sort((a, b) => a - b).join(',');

// ---- steps, elision, leaks

interface StepsExpect {
	what: string;
	planted: Array<[number, number]>;
	flags?: string[];
	elided?: Array<[number, number]>;
	leak?: { module: string; function: string; variable: string; line: number } | null;
}

function steps_check(name: string): Check {
	const e = read_expect<StepsExpect>('answer-key', name);
	const layer = e.leak !== undefined ? 'leak' : e.elided ? 'elision' : 'steps';
	const planted = e.leak === null ? false : e.planted.length > 0;
	const expect =
		layer === 'leak'
			? e.leak
				? `leak of \`${e.leak.variable}\` at ${e.leak.module}:${e.leak.line}`
				: 'no leak'
			: layer === 'elision'
				? `lines ${e.planted.map((r) => r.join('-'))} elided, not a regression`
				: planted
					? `flag lines ${e.planted.map((r) => r.join('-')).join(' and ')}`
					: 'nothing flagged';
	return {
		layer,
		name,
		what: e.what,
		planted,
		expect,
		// real bytes and leaks are timing sensitive: one side at a time, nothing else running
		exclusive: layer !== 'steps',
		run: async () => {
			const p = make_pair(
				temp_dir('heisenbench-verify-'),
				key_files('answer-key', 'base'),
				key_files('answer-key', name)
			);
			const flags = e.flags ?? [];
			const base = await cli(p.base_dir, ['run', ...flags]);
			const pr = await cli(p.pr_dir, ['run', ...flags]);
			if (!base.cases[0]?.stable || !pr.cases[0]?.stable)
				return { pass: false, got: 'unstable counts' };
			const d = diff_reports(base, pr, { files: git_diff(p.repo, p.base_sha, p.pr_sha) });
			const f: Finding[] = d.findings;
			const in_planted = (x: Finding) => e.planted.some(([a, b]) => x.line >= a && x.line <= b);
			const steps = f.reduce((s, x) => s + x.delta.steps, 0);
			const got_flags =
				f.length === 0
					? 'nothing flagged'
					: `flagged lines ${lines(f)} (${steps > 0 ? '+' : ''}${Math.round(steps)} steps)`;
			if (layer === 'leak') {
				const leak = pr.cases[0].measure?.leak;
				const base_leak = base.cases[0].measure?.leak;
				if (!leak || !base_leak) return { pass: false, got: 'leak check did not run' };
				if (base_leak.leaked) return { pass: false, got: 'the base leaks' };
				if (e.leak === null)
					return {
						pass: !leak.leaked,
						got: leak.leaked ? `leak reported: ${JSON.stringify(leak.source)}` : 'no leak'
					};
				const s = leak.source;
				const pass =
					leak.leaked &&
					s !== null &&
					s !== undefined &&
					s.module === e.leak!.module &&
					context_path(s.function) === e.leak!.function &&
					s.variable === e.leak!.variable &&
					s.line === e.leak!.line;
				return {
					pass,
					got: leak.leaked ? `leak of \`${s?.variable}\` at ${s?.module}:${s?.line}` : 'no leak'
				};
			}
			if (layer === 'elision') {
				const fn = pr.cases[0].measure?.bytes?.functions.find((x) => x.elided);
				// Elision qualifies the bytes: the steps the allocation costs must still show.
				const steps_shown = steps === 0 || !render_markdown(d).includes('No function changed');
				const pass =
					fn !== undefined &&
					fn.estimated > 4 * fn.real &&
					e.elided!.every(([a, b]) => fn.lines.some((l) => l >= a && l <= b)) &&
					f.every((x) => x.elided) &&
					steps_shown;
				return {
					pass,
					got: fn
						? `elided at lines ${fn.lines.join(',')} (est ${fn.estimated} B, real ${fn.real} B)${f.every((x) => x.elided) ? '' : ', but flagged'}${steps_shown ? '' : ', steps hidden'}`
						: 'no elided function'
				};
			}
			if (!planted) return { pass: f.length === 0, got: got_flags };
			const pass =
				f.length > 0 &&
				f.every((x) => x.module === 'lib.ts' && in_planted(x)) &&
				e.planted.every(([a, b]) => f.some((x) => x.line >= a && x.line <= b)) &&
				steps > 0;
			return { pass, got: got_flags };
		}
	};
}

// ---- engine health

interface Rule {
	kind?: string;
	function: string;
	lines?: [number, number];
}

function matches(f: EngineFinding, r: Rule): boolean {
	if (r.function !== context_path(f.function)) return false;
	if (r.kind && r.kind !== f.kind) return false;
	if (r.lines && (f.line < r.lines[0] || f.line > r.lines[1])) return false;
	return true;
}

function engine_checks(): Check[] {
	let base: Promise<EngineReport> | null = null;
	const base_report = (dir: string) => (base ??= cli(dir, ['health']).then((r) => r.engine!));
	return variants('engine-key').map((name) => {
		const e = read_expect<{ what: string; flags: Rule[]; allow?: Rule[] }>('engine-key', name);
		const planted = e.flags.length > 0;
		return {
			layer: 'engine',
			name,
			what: e.what,
			planted,
			expect: planted
				? e.flags
						.map((r) => `${r.kind ?? 'flag'} in ${r.function}${r.lines ? `:${r.lines[0]}` : ''}`)
						.join(', ')
				: 'nothing flagged',
			exclusive: false,
			run: async () => {
				const p = make_pair(
					temp_dir('heisenbench-verify-'),
					key_files('engine-key', 'base'),
					key_files('engine-key', name)
				);
				const [b, pr] = await Promise.all([
					base_report(p.base_dir),
					cli(p.pr_dir, ['health']).then((r) => r.engine!)
				]);
				if (pr.cases[0]?.error) return { pass: false, got: `error: ${pr.cases[0].error}` };
				const d = diff_engine(b, pr, { files: git_diff(p.repo, p.base_sha, p.pr_sha) });
				const got =
					d.findings.length === 0
						? 'nothing flagged'
						: [...new Set(d.findings.map((f) => `${f.kind} in ${f.function}:${f.line}`))].join(
								', '
							);
				if (d.unstable.length > 0)
					return { pass: false, got: `unstable: ${d.unstable.join(', ')}` };
				if (!planted) return { pass: d.findings.length === 0, got };
				const rules = [...e.flags, ...(e.allow ?? [])];
				const pass =
					d.findings.every((f) => rules.some((r) => matches(f, r))) &&
					e.flags.every((r) => d.findings.some((f) => matches(f, r)));
				return { pass, got };
			}
		};
	});
}

// ---- growth class

function growth_checks(): Check[] {
	let base: Promise<GrowthReport> | null = null;
	const growth = (dir: string) => cli(dir, ['growth']).then((r) => r.growth!);
	return variants('growth-key').map((name) => {
		const e = read_expect<{
			what: string;
			flags: Array<{ case: string; base: string; pr: string }>;
		}>('growth-key', name);
		const planted = e.flags.length > 0;
		return {
			layer: 'growth',
			name,
			what: e.what,
			planted,
			expect: planted
				? e.flags.map((f) => `${f.case}: ${f.base} -> ${f.pr}`).join(', ')
				: 'no class change',
			exclusive: false,
			run: async () => {
				const p = make_pair(
					temp_dir('heisenbench-verify-'),
					key_files('growth-key', 'base'),
					key_files('growth-key', name)
				);
				const [b, pr] = await Promise.all([(base ??= growth(p.base_dir)), growth(p.pr_dir)]);
				const found = diff_growth(b, pr).findings.map((f) => ({
					case: f.case,
					base: f.base,
					pr: f.pr
				}));
				const got =
					found.length === 0
						? 'no class change'
						: found.map((f) => `${f.case}: ${f.base} -> ${f.pr}`).join(', ');
				return { pass: JSON.stringify(found) === JSON.stringify(e.flags), got };
			}
		};
	});
}

// ---- slow-input search

function search_checks(): Check[] {
	let reports: Promise<[SearchReport, SearchReport]> | null = null;
	const both = () =>
		(reports ??= (async () => {
			const tmp = temp_dir('heisenbench-verify-');
			const p = make_pair(tmp, key_files('search-key', 'base'), key_files('search-key', 'pr'));
			return Promise.all([
				cli(p.base_dir, ['search']).then((r) => r.search!),
				cli(p.pr_dir, ['search']).then((r) => r.search!)
			]);
		})());
	const cases: Array<{ name: string; what: string; planted: boolean; min?: number; max?: number }> =
		[
			{
				name: 'order',
				what: 'insertion sort: quadratic on the input the search finds',
				planted: true,
				min: 5
			},
			{
				name: 'count',
				what: 'naive substring count: slow on runs of one character',
				planted: true,
				min: 3
			},
			{
				name: 'total',
				what: 'linear: the worst input costs what a typical one does',
				planted: false,
				max: 1.05
			}
		];
	return cases.map((c) => ({
		layer: 'search',
		name: c.name,
		what: c.what,
		planted: c.planted,
		expect: c.planted
			? `worst/typical >= ${c.min}, flagged`
			: `worst/typical <= ${c.max}, not flagged`,
		exclusive: false,
		run: async () => {
			const [b, p] = await both();
			const r = p.cases.find((x) => x.name === c.name);
			if (!r || r.error) return { pass: false, got: r?.error ?? 'case missing' };
			const flagged = diff_search(b, p).some((f) => f.case === c.name);
			const pass = c.planted ? r.ratio >= c.min! && flagged : r.ratio <= c.max! && !flagged;
			return {
				pass,
				got: `worst/typical ${r.ratio.toFixed(2)}${flagged ? ', flagged' : ', not flagged'}`
			};
		}
	}));
}

export function key_checks(): Check[] {
	return [
		...variants('answer-key').map(steps_check),
		...engine_checks(),
		...growth_checks(),
		...search_checks()
	];
}
