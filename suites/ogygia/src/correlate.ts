#!/usr/bin/env node
/**
 * The real-world check (spec 12): do step deltas track time deltas across ogygia's own history?
 *
 *   node suites/ogygia/src/correlate.ts --from <rev> [--to <rev>] [--repo <url or path>]
 *       [--bench <rev>] [--work dir] [--out dir] [--repeats 8] [--time-ms 150] [--max 40]
 *   node suites/ogygia/src/correlate.ts --summarize --out dir [--prices prices.json]
 *
 * Every first-parent commit in from..to that touches the source of a package with bench files is
 * one pair: the commit against its parent. The bench files of `--bench` (default `--to`) are laid
 * over both trees (with internal/heisenbench and the unit-test stubs they load), so one fixed set of cases
 * measures every commit; a case whose code did not exist yet fails to load on that side and is
 * left out. Per pair:
 *
 *   steps   every bench file counted on both trees (exact: one run a side)
 *   time    the bench files whose import graph reaches a changed file, timed on the plain build,
 *           both trees in one process taking turns (`heisenbench time`, `--repeats` rounds), judged by the
 *           same no-overlap noise rule PR comments use
 *
 * Measuring writes `<out>/pairs/<sha>/` (reports, time comparison) and skips pairs already there,
 * so a stopped run resumes. `--summarize` reads them back (recounted with `--prices`, default the
 * current prices.json) and writes `<out>/rows.json` and `<out>/summary.md`: Spearman's rank
 * correlation of Δsteps against Δtime, the confusion matrix (steps changed by at least the time
 * rule's 3% floor, against a significant time verdict), and every case where the two disagree.
 */
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadPrices, recount } from '@bench/heisenbench';
import type { Report, TimeComparison } from '@bench/heisenbench';
import { changed_files, clone, prepare_tree, remove_tree, rev_parse } from './checkout.ts';
import type { Tree } from './checkout.ts';
import { import_graphs } from './graph.ts';
import { HEISENBENCH_DIR, run_time, run_tree } from './run.ts';
import { is_shared, select_changed } from './select.ts';

/** The time rule's floor (packages/heisenbench TIME_RULES.p50_ns): a smaller step change is "unchanged". */
export const STEPS_FLOOR_PCT = 3;

export interface Row {
	commit: string;
	subject: string;
	case: string;
	file: string;
	base_steps: number;
	pr_steps: number;
	steps_pct: number;
	base_p50: number;
	pr_p50: number;
	p50_pct: number;
	base_mean: number;
	pr_mean: number;
	mean_pct: number;
	/** The p50 verdict of the noise rule: 'slower', 'faster' or 'same'. */
	time: 'slower' | 'faster' | 'same';
}

// ---- statistics

/** Average ranks (ties share the mean of their positions), 1-based. */
export function ranks(xs: readonly number[]): number[] {
	const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
	const out: number[] = Array.from({ length: xs.length }, () => 0);
	for (let i = 0; i < idx.length;) {
		let j = i;
		while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
		const r = (i + j) / 2 + 1;
		for (let k = i; k <= j; k++) out[idx[k][1]] = r;
		i = j + 1;
	}
	return out;
}

function pearson(a: readonly number[], b: readonly number[]): number {
	const n = a.length;
	if (n < 2) return NaN;
	const ma = a.reduce((s, x) => s + x, 0) / n;
	const mb = b.reduce((s, x) => s + x, 0) / n;
	let sab = 0;
	let saa = 0;
	let sbb = 0;
	for (let i = 0; i < n; i++) {
		sab += (a[i] - ma) * (b[i] - mb);
		saa += (a[i] - ma) ** 2;
		sbb += (b[i] - mb) ** 2;
	}
	return saa === 0 || sbb === 0 ? NaN : sab / Math.sqrt(saa * sbb);
}

/** Spearman's rank correlation (Pearson on average ranks, so ties are handled). */
export function spearman(a: readonly number[], b: readonly number[]): number {
	return pearson(ranks(a), ranks(b));
}

function median(xs: readonly number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const h = s.length >> 1;
	return s.length === 0 ? NaN : s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

const pct = (pr: number, base: number): number =>
	base === 0 ? (pr === 0 ? 0 : 100) : Math.round(((pr - base) / base) * 1e4) / 100;

// ---- measuring

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
}

/** Packages that have a bench directory at `rev`. */
function bench_packages(repo: string, rev: string): string[] {
	return git(repo, ['ls-tree', '-d', '--name-only', `${rev}:packages`])
		.split('\n')
		.filter((p) => p && git(repo, ['ls-tree', '--name-only', rev, `packages/${p}/bench`]) !== '');
}

/** Lay the bench files of `rev` (and what they load) over a tree, and link Heisenbench into it. */
function overlay(repo: string, rev: string, tree: Tree, packages: string[]): Tree {
	const paths = [
		...packages.map((p) => `packages/${p}/bench`),
		'internal/heisenbench',
		'packages/core/test/_stubs'
	];
	const tar = execFileSync('git', ['archive', '--format=tar', rev, '--', ...paths], {
		cwd: repo,
		maxBuffer: 1 << 28
	});
	execFileSync('tar', ['-x', '-C', tree.dir], { input: tar });
	const link = join(tree.dir, 'node_modules', '@bench', 'heisenbench');
	mkdirSync(dirname(link), { recursive: true });
	rmSync(link, { force: true, recursive: true });
	symlinkSync(relative(dirname(link), HEISENBENCH_DIR), link, 'dir');
	const benches = packages
		.flatMap((p) =>
			readdirSync(join(tree.dir, 'packages', p, 'bench'))
				.filter((f) => f.endsWith('.bench.ts'))
				.map((f) => `packages/${p}/bench/${f}`)
		)
		.sort();
	return { ...tree, benches, preload: join(tree.dir, 'internal', 'heisenbench', 'src', 'preload.ts') };
}

interface PairMeta {
	commit: string;
	parent: string;
	subject: string;
	changed: string[];
	timed: string[];
	load_errors: { base: string[]; pr: string[] };
	time_error: string | null;
}

async function measure(values: Record<string, string | boolean | undefined>): Promise<void> {
	const work = resolve(String(values.work ?? '.work-correlate'));
	const out = resolve(String(values.out ?? 'out-correlate'));
	const repo_url = String(values.repo ?? 'https://github.com/ogygiajs/ogygia.git');
	if (!values.from) throw new Error('--from <rev> is required');
	const repo = clone(repo_url, work, []);
	const to = rev_parse(repo, String(values.to ?? 'origin/main'));
	const from = rev_parse(repo, String(values.from));
	const bench_rev = rev_parse(repo, String(values.bench ?? to));
	const packages = bench_packages(repo, bench_rev);
	const src = packages.map((p) => `packages/${p}/src`);
	const commits = last_commits(
		git(repo, ['rev-list', '--first-parent', '--reverse', `${from}..${to}`, '--', ...src])
			.split('\n')
			.filter(Boolean),
		parse_max(values.max)
	);
	const pairs = commits.map((commit) => ({ commit, parent: rev_parse(repo, `${commit}^1`) }));
	const log = (l: string) => console.log(`[correlate] ${l}`);
	log(
		`${commits.length} commits touch ${src.join(', ')}; bench files of ${bench_rev.slice(0, 12)}`
	);
	mkdirSync(join(out, 'pairs'), { recursive: true });
	writeFileSync(
		join(out, 'meta.json'),
		JSON.stringify(
			{
				repo: repo_url,
				from,
				to,
				bench: bench_rev,
				repeats: Number(values.repeats ?? 8),
				time_ms: Number(values['time-ms'] ?? 150),
				machine: {
					cpu: cpus()[0]?.model.trim(),
					cores: cpus().length,
					os: `${platform()} ${release()}`,
					node: process.version,
					v8: process.versions.v8
				}
			},
			null,
			'\t'
		) + '\n'
	);
	for (const [i, { commit, parent }] of pairs.entries()) {
		const dir = join(out, 'pairs', commit.slice(0, 12));
		if (existsSync(join(dir, 'pair.json'))) {
			log(`${commit.slice(0, 12)} done before`);
			continue;
		}
		const subject = git(repo, ['log', '-1', '--format=%s', commit]);
		log(`${commit.slice(0, 12)} ${subject}`);
		const base = overlay(
			repo,
			bench_rev,
			prepare_tree(repo, work, parent, HEISENBENCH_DIR, log),
			packages
		);
		const head = overlay(
			repo,
			bench_rev,
			prepare_tree(repo, work, commit, HEISENBENCH_DIR, log),
			packages
		);
		const b = await run_tree(base, base.benches, join(dir, 'base'), log, null, ['run']);
		const h = await run_tree(head, head.benches, join(dir, 'pr'), log, null, ['run']);
		// What every bench file shares does not pick the timed ones here: the bench files and the
		// harness are laid over both trees, and a lockfile change times nothing in particular.
		const changed = changed_files(repo, parent, commit).filter((f) => !is_shared(f));
		const loaded = (r: Report | null) => new Set((r?.cases ?? []).map((c) => c.file));
		const both = [...loaded(b.report)].filter((f) => loaded(h.report).has(f));
		const selection = select_changed(import_graphs(head.dir, both), changed);
		const timed = selection.selected;
		const t = await run_time(head, base, timed, join(dir, 'time'), log, {
			repeats: Number(values.repeats ?? 8),
			time_ms: Number(values['time-ms'] ?? 150),
			limit_min: 90
		});
		if (b.report) writeFileSync(join(dir, 'base.json'), JSON.stringify(b.report));
		if (h.report) writeFileSync(join(dir, 'pr.json'), JSON.stringify(h.report));
		const meta: PairMeta = {
			commit,
			parent,
			subject,
			changed,
			timed,
			load_errors: {
				base: b.load_errors.map((e) => e.file),
				pr: h.load_errors.map((e) => e.file)
			},
			time_error: t?.error ?? null
		};
		writeFileSync(join(dir, 'pair.json'), JSON.stringify(meta, null, '\t') + '\n');
		// Each tree is a full install: keep only what the next pair measures.
		for (const sha of trees_to_drop(pairs[i], pairs[i + 1])) remove_tree(work, sha);
	}
}

/** `--max`: how many of the newest commits to measure (default 40). */
export function parse_max(v: string | boolean | undefined): number {
	if (v === undefined) return 40;
	const n = Number(v);
	if (typeof v !== 'string' || !/^\d+$/.test(v) || !Number.isSafeInteger(n))
		throw new Error(`--max takes a whole number of commits, not ${JSON.stringify(v)}`);
	return n;
}

/** The newest `max` commits of an oldest-first list (none for 0: `slice(-0)` would be all). */
export function last_commits(commits: readonly string[], max: number): string[] {
	return max === 0 ? [] : commits.slice(-max);
}

/** The trees of a measured pair that the next pair does not use. */
export function trees_to_drop(
	pair: { commit: string; parent: string },
	next: { commit: string; parent: string } | undefined
): string[] {
	const keep = new Set(next ? [next.commit, next.parent] : []);
	return [...new Set([pair.parent, pair.commit])].filter((sha) => !keep.has(sha));
}

// ---- summarizing

function read_json<T>(path: string): T | null {
	return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null;
}

export function pair_rows(meta: PairMeta, base: Report, pr: Report, time: TimeComparison): Row[] {
	const steps = (r: Report) => new Map(r.cases.filter((c) => !c.error).map((c) => [c.name, c]));
	const bs = steps(base);
	const ps = steps(pr);
	const rows: Row[] = [];
	for (const tc of time.cases) {
		const b = bs.get(tc.name);
		const p = ps.get(tc.name);
		if (!b || !p || tc.base.length === 0 || tc.pr.length === 0) continue;
		const v = tc.verdicts.p50_ns;
		const base_p50 = median(tc.base.map((s) => s.p50_ns));
		const pr_p50 = median(tc.pr.map((s) => s.p50_ns));
		const base_mean = median(tc.base.map((s) => s.mean_ns));
		const pr_mean = median(tc.pr.map((s) => s.mean_ns));
		rows.push({
			commit: meta.commit.slice(0, 12),
			subject: meta.subject,
			case: tc.name,
			file: p.file,
			base_steps: b.totals.steps,
			pr_steps: p.totals.steps,
			steps_pct: pct(p.totals.steps, b.totals.steps),
			base_p50,
			pr_p50,
			p50_pct: pct(pr_p50, base_p50),
			base_mean,
			pr_mean,
			mean_pct: pct(pr_mean, base_mean),
			time: v.regressed ? 'slower' : v.improved ? 'faster' : 'same'
		});
	}
	return rows;
}

export interface Summary {
	rows: number;
	pairs: number;
	spearman_p50: number;
	spearman_mean: number;
	/** Over the rows whose steps changed at all. */
	spearman_changed: number;
	changed_rows: number;
	confusion: { tp: number; fp: number; fn: number; tn: number };
	/** Rows where both moved: same direction. */
	direction_agree: number;
	direction_total: number;
}

export function summarize_rows(rows: readonly Row[]): Summary {
	const changed = rows.filter((r) => r.steps_pct !== 0);
	const c = { tp: 0, fp: 0, fn: 0, tn: 0 };
	let agree = 0;
	let total = 0;
	for (const r of rows) {
		const flagged = Math.abs(r.steps_pct) >= STEPS_FLOOR_PCT;
		const sig = r.time !== 'same';
		if (flagged && sig) c.tp++;
		else if (flagged) c.fp++;
		else if (sig) c.fn++;
		else c.tn++;
		if (flagged && sig) {
			total++;
			if (r.steps_pct > 0 === (r.time === 'slower')) agree++;
		}
	}
	const r2 = (x: number) => Math.round(x * 1000) / 1000;
	return {
		rows: rows.length,
		pairs: new Set(rows.map((r) => r.commit)).size,
		spearman_p50: r2(
			spearman(
				rows.map((r) => r.steps_pct),
				rows.map((r) => r.p50_pct)
			)
		),
		spearman_mean: r2(
			spearman(
				rows.map((r) => r.steps_pct),
				rows.map((r) => r.mean_pct)
			)
		),
		spearman_changed: r2(
			spearman(
				changed.map((r) => r.steps_pct),
				changed.map((r) => r.p50_pct)
			)
		),
		changed_rows: changed.length,
		confusion: c,
		direction_agree: agree,
		direction_total: total
	};
}

function render(s: Summary, rows: readonly Row[], prices: string): string {
	const f = (x: number) => (x > 0 ? '+' : '') + x.toFixed(1) + '%';
	const out = [
		`Pairs: ${s.pairs} commits, ${s.rows} case measurements (prices ${prices}).`,
		'',
		`- Spearman Δsteps vs Δp50: **${s.spearman_p50}** (vs Δmean: ${s.spearman_mean})`,
		`- Over the ${s.changed_rows} rows whose steps changed: ${s.spearman_changed}`,
		`- Both flagged and same direction: ${s.direction_agree} of ${s.direction_total}`,
		'',
		`| | time significant | time same |`,
		`| --- | ---: | ---: |`,
		`| steps changed ≥ ${STEPS_FLOOR_PCT}% | ${s.confusion.tp} | ${s.confusion.fp} |`,
		`| steps changed < ${STEPS_FLOOR_PCT}% | ${s.confusion.fn} | ${s.confusion.tn} |`,
		'',
		'Disagreements:',
		'',
		'| Commit | Case | Δsteps | Δp50 | Δmean | Time |',
		'| --- | --- | ---: | ---: | ---: | --- |'
	];
	for (const r of rows) {
		const flagged = Math.abs(r.steps_pct) >= STEPS_FLOOR_PCT;
		if (flagged === (r.time !== 'same')) continue;
		out.push(
			`| \`${r.commit.slice(0, 8)}\` ${r.subject.slice(0, 50)} | ${r.case} | ${f(r.steps_pct)} | ${f(r.p50_pct)} | ${f(r.mean_pct)} | ${r.time} |`
		);
	}
	return out.join('\n') + '\n';
}

function summarize(values: Record<string, string | boolean | undefined>): void {
	const out = resolve(String(values.out ?? 'out-correlate'));
	const prices = loadPrices(values.prices ? resolve(String(values.prices)) : undefined);
	const rows: Row[] = [];
	for (const d of readdirSync(join(out, 'pairs')).sort()) {
		const dir = join(out, 'pairs', d);
		const meta = read_json<PairMeta>(join(dir, 'pair.json'));
		const base = read_json<Report>(join(dir, 'base.json'));
		const pr = read_json<Report>(join(dir, 'pr.json'));
		const time = read_json<TimeComparison>(join(dir, 'time', 'time.json'));
		if (!meta || !base || !pr || !time) continue;
		rows.push(...pair_rows(meta, recount(base, prices), recount(pr, prices), time));
	}
	const s = summarize_rows(rows);
	const label = `v${prices.prices.version} ${prices.hash}`;
	writeFileSync(join(out, 'rows.json'), JSON.stringify({ summary: s, rows }, null, '\t') + '\n');
	const md = render(s, rows, label);
	writeFileSync(join(out, 'summary.md'), md);
	console.log(md);
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			from: { type: 'string' },
			to: { type: 'string' },
			bench: { type: 'string' },
			repo: { type: 'string' },
			work: { type: 'string' },
			out: { type: 'string' },
			repeats: { type: 'string' },
			'time-ms': { type: 'string' },
			max: { type: 'string' },
			prices: { type: 'string' },
			summarize: { type: 'boolean' }
		}
	});
	if (values.summarize) summarize(values);
	else {
		await measure(values);
		summarize(values);
	}
}
