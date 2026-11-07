#!/usr/bin/env node
/**
 * Training data for the models that turn exact counts into bets about time: labeled pairs of a
 * step change and the time change it made, beyond noise or not.
 *
 *   node suites/ogygia/src/training.ts measure [--planted] [--history --from <rev> [--to <rev>]
 *       [--bench <rev>] [--max 40] [--repo <url or path>]] [--work dir] [--repeats 7]
 *       [--time-ms 150] [--batch 24] [--filter text] [--counts-only] [--retime-above <load>]
 *       [--max-load <load> [--max-wait-min 60]]
 *   node suites/ogygia/src/training.ts assemble [--work dir] [--out dir] [--version 1]
 *
 * Two sources of pairs, each measured in groups (a group is one timing run):
 *
 *   planted   planted.ts: slowdowns, speedups and harmless edits made from Heisenbench's answer
 *             keys, at a few sizes; `--batch` pairs per group, both sides as two trees
 *   history   ogygia's first-parent commits in from..to that touch a bench package's source, each
 *             against its parent, with the bench files of `--bench` laid over both (correlate.ts
 *             does the same for the real-world check); the cases of the bench files whose import
 *             graph reaches a changed file
 *
 * Per group, on both sides: every case counted (`heisenbench run`: steps, units, allocations,
 * bytes), checked by engine health (`heisenbench health`: tiers, deopts, inline caches) and sized
 * (sizes-child.ts); then both sides timed on the plain build in one process, taking turns, on
 * fresh copies every round, with confirming rounds for a case that looks changed (`heisenbench
 * time`: the time layer of a PR comment), judged by the no-overlap noise rule. The 1-minute load
 * average is sampled while a group is timed. `--counts-only` skips health and time.
 *
 * `measure` writes `<work>/training/<source>/<group>/` and skips groups already there, so a
 * stopped run resumes; `--retime-above <load>` measures again a group whose 1-minute load average
 * went above that while it was timed (another job took the machine), and `--max-load` waits for
 * the load to drop before a group is timed. `assemble` reads them back and writes the dataset: the counted part
 * (`training-counts-<version>.json`: the same bytes for the same inputs) and the timed part
 * (`training-times-<version>.json`), fields in packages/heisenbench/calibration/data/training.md.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadPrices, recount } from '@bench/heisenbench';
import type { CaseReport, Report, TimeComparison } from '@bench/heisenbench';
import { changed_files, clone, prepare_tree, remove_tree, rev_parse } from './checkout.ts';
import type { Tree } from './checkout.ts';
import { bench_packages, last_commits, overlay, parse_max, trees_to_drop } from './correlate.ts';
import { import_graphs } from './graph.ts';
import { BENCH_API_TOKEN, PLANTED_FOR, planted_pairs } from './planted.ts';
import type { PlantedPair } from './planted.ts';
import { HEISENBENCH_DIR, node_options, run_time, run_tree } from './run.ts';
import { is_shared, select_changed } from './select.ts';
import { spawn_group } from './spawn.ts';
import {
	COUNTS_SCHEMA,
	SAMPLE_FIELDS,
	TIMES_SCHEMA,
	check_counts,
	check_times,
	count_rows,
	dataset_text,
	time_rows
} from './training-rows.ts';
import type { CountRow, CountsFile, GroupLoad, TimeRow, TimesFile } from './training-rows.ts';

const SIZES_CHILD = fileURLToPath(new URL('./sizes-child.ts', import.meta.url));
const BENCH_API = join(HEISENBENCH_DIR, 'src', 'bench.ts');
export const DATA_DIR = join(HEISENBENCH_DIR, 'calibration', 'data');

/** Seconds between two load samples while a group is timed. */
export const LOAD_EVERY_S = 5;

export interface MeasureOptions {
	work: string;
	repeats?: number;
	time_ms?: number;
	counts_only?: boolean;
	/** Measure again a finished group whose load average went above this while it was timed. */
	retime_above?: number;
	/** Before timing a group, wait for the 1-minute load average to be at most this... */
	max_load?: number;
	/** ...for this many minutes at most (default 60). */
	max_wait_min?: number;
	log?: (line: string) => void;
}

const DEFAULT_REPEATS = 7;
const DEFAULT_TIME_MS = 150;

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
}

function write_json(path: string, v: unknown): void {
	writeFileSync(path, JSON.stringify(v) + '\n');
}

function read_json<T>(path: string): T | null {
	return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null;
}

/** A group measured before, and not to be measured again (`retime_above`). */
function done_before(dir: string, o: MeasureOptions): boolean {
	const meta = read_json<GroupMeta>(join(dir, 'group.json'));
	if (!meta) return false;
	const max = meta.load?.load.max;
	if (o.retime_above !== undefined && max !== undefined && max > o.retime_above) {
		o.log?.(`${meta.id}: timed at a load of up to ${max}, measured again`);
		return false;
	}
	return true;
}

/** What one group left on disk besides the reports. */
interface GroupMeta {
	id: string;
	source: 'planted' | 'history';
	/** Bench files counted for rows (history: the timed ones). */
	files: string[];
	counts_only: boolean;
	load: GroupLoad | null;
	time_error: string | null;
	/** Planted: the pair ids. History: the commit. */
	pairs?: string[];
	commit?: string;
	parent?: string;
	subject?: string;
	load_errors?: { base: string[]; pr: string[] };
}

// ---- measuring one group

async function input_sizes(
	tree: Tree,
	files: string[],
	out: string
): Promise<Record<string, number | null>> {
	const r = await spawn_group(
		process.execPath,
		['--no-warnings', SIZES_CHILD, tree.dir, out, ...files],
		{ cwd: tree.dir, env: { ...process.env, NODE_OPTIONS: node_options(tree) } },
		15 * 60_000
	);
	const sizes = read_json<Record<string, number | null>>(out);
	if (!sizes)
		throw new Error(`training: sizing ${tree.dir} failed: ${(r.stderr || r.stdout).slice(-500)}`);
	return sizes;
}

/** Seconds between two looks at the load while waiting for it to drop. */
const QUIET_EVERY_S = 15;

/**
 * Wait until the 1-minute load average is at most `max_load` (another job has the machine), for
 * `max_wait_min` at most; then time anyway: the load is recorded either way.
 */
async function quiet_enough(id: string, o: MeasureOptions): Promise<void> {
	if (o.max_load === undefined) return;
	const until = Date.now() + (o.max_wait_min ?? 60) * 60_000;
	let said = false;
	while (loadavg()[0] > o.max_load && Date.now() < until) {
		if (!said) o.log?.(`${id}: load ${loadavg()[0].toFixed(1)}, waiting for ${o.max_load} or less`);
		said = true;
		await new Promise((r) => setTimeout(r, QUIET_EVERY_S * 1000));
	}
	if (said) o.log?.(`${id}: load ${loadavg()[0].toFixed(1)}, timing`);
}

/** Time both trees (`heisenbench time`), sampling the load average all along. */
async function timed(
	id: string,
	source: 'planted' | 'history',
	base: Tree,
	pr: Tree,
	files: string[],
	dir: string,
	o: MeasureOptions
): Promise<{ load: GroupLoad; error: string | null }> {
	const log = o.log ?? (() => {});
	await quiet_enough(id, o);
	const t0 = Date.now();
	const series: Array<[number, number]> = [];
	const sample = () =>
		series.push([Math.round((Date.now() - t0) / 1000), Math.round(loadavg()[0] * 100) / 100]);
	sample();
	const timer = setInterval(sample, LOAD_EVERY_S * 1000);
	let error: string | null = null;
	try {
		const t = await run_time(pr, base, files, join(dir, 'time'), log, {
			repeats: o.repeats ?? DEFAULT_REPEATS,
			time_ms: o.time_ms ?? DEFAULT_TIME_MS,
			limit_min: 180
		});
		error = t?.error ?? null;
	} finally {
		clearInterval(timer);
		sample();
	}
	const loads = series.map((s) => s[1]);
	const r2 = (v: number) => Math.round(v * 100) / 100;
	const load: GroupLoad = {
		id,
		kind: source,
		started: new Date(t0).toISOString(),
		seconds: Math.round((Date.now() - t0) / 1000),
		load: {
			start: loads[0],
			end: loads[loads.length - 1],
			min: Math.min(...loads),
			max: Math.max(...loads),
			mean: r2(loads.reduce((a, b) => a + b, 0) / loads.length)
		},
		series,
		error
	};
	log(
		`${id}: timed in ${load.seconds} s, load ${load.load.min} to ${load.load.max} (mean ${load.load.mean})`
	);
	return { load, error };
}

async function measure_group(
	id: string,
	source: 'planted' | 'history',
	base: Tree,
	pr: Tree,
	files: string[],
	dir: string,
	o: MeasureOptions,
	extra: Partial<GroupMeta>
): Promise<void> {
	const log = o.log ?? (() => {});
	const commands = o.counts_only ? (['run'] as const) : (['run', 'health'] as const);
	const b = await run_tree(base, files, join(dir, 'runs', 'base'), log, null, commands);
	const p = await run_tree(pr, files, join(dir, 'runs', 'pr'), log, null, commands);
	if (!b.report || !p.report) throw new Error(`training: ${id}: a side counted nothing`);
	write_json(join(dir, 'base.json'), b.report);
	write_json(join(dir, 'pr.json'), p.report);
	const sizes = {
		base: await input_sizes(base, files, join(dir, 'sizes-base.json')),
		pr: await input_sizes(pr, files, join(dir, 'sizes-pr.json'))
	};
	write_json(join(dir, 'sizes.json'), sizes);
	let load: GroupLoad | null = null;
	let time_error: string | null = null;
	if (!o.counts_only)
		({ load, error: time_error } = await timed(id, source, base, pr, files, dir, o));
	const meta: GroupMeta = {
		id,
		source,
		files,
		counts_only: o.counts_only ?? false,
		load,
		time_error,
		load_errors: {
			base: b.load_errors.map((e) => `${e.file} (${e.command})`),
			pr: p.load_errors.map((e) => `${e.file} (${e.command})`)
		},
		...extra
	};
	// written last: a group with group.json is done
	write_json(join(dir, 'group.json'), meta);
}

// ---- planted

function write_tree(dir: string, pairs: PlantedPair[], side: 'base' | 'pr'): Tree {
	rmSync(dir, { recursive: true, force: true });
	for (const p of pairs) {
		mkdirSync(join(dir, p.id), { recursive: true });
		writeFileSync(join(dir, p.id, 'lib.ts'), p[side]);
		writeFileSync(
			join(dir, p.id, 'lib.bench.ts'),
			p.bench.replace(BENCH_API_TOKEN, BENCH_API.split('\\').join('/'))
		);
	}
	return { dir, sha: 'planted', preload: null, benches: pairs.map((p) => `${p.id}/lib.bench.ts`) };
}

export async function measure_planted(
	o: MeasureOptions & { batch?: number; filter?: string }
): Promise<void> {
	const log = o.log ?? (() => {});
	const pairs = planted_pairs().filter((p) => !o.filter || p.id.includes(o.filter));
	const size = o.batch ?? 24;
	const groups = Math.ceil(pairs.length / size);
	log(`planted: ${pairs.length} pairs in ${groups} group(s)`);
	for (let g = 0; g < groups; g++) {
		const id = `planted-${String(g + 1).padStart(2, '0')}`;
		const dir = join(o.work, 'training', 'planted', id);
		if (done_before(dir, o)) {
			log(`${id} done before`);
			continue;
		}
		rmSync(join(dir, 'group.json'), { force: true });
		const chunk = pairs.slice(g * size, (g + 1) * size);
		log(`${id}: ${chunk.length} pairs, ${chunk[0].id} to ${chunk[chunk.length - 1].id}`);
		const base = write_tree(join(dir, 'base'), chunk, 'base');
		const pr = write_tree(join(dir, 'pr'), chunk, 'pr');
		await measure_group(id, 'planted', base, pr, base.benches, dir, o, {
			pairs: chunk.map((p) => p.id)
		});
	}
}

// ---- history

export interface HistoryOptions extends MeasureOptions {
	from: string;
	to?: string;
	bench?: string;
	repo?: string;
	max?: number;
}

export async function measure_history(o: HistoryOptions): Promise<void> {
	const log = o.log ?? (() => {});
	const repo_url = o.repo ?? 'https://github.com/ogygiajs/ogygia.git';
	const repo = clone(repo_url, o.work, []);
	const to = rev_parse(repo, o.to ?? 'origin/main');
	const from = rev_parse(repo, o.from);
	const bench_rev = rev_parse(repo, o.bench ?? to);
	const packages = bench_packages(repo, bench_rev);
	const src = packages.map((p) => `packages/${p}/src`);
	const commits = last_commits(
		git(repo, ['rev-list', '--first-parent', '--reverse', `${from}..${to}`, '--', ...src])
			.split('\n')
			.filter(Boolean),
		o.max ?? 40
	);
	const pairs = commits.map((commit) => ({ commit, parent: rev_parse(repo, `${commit}^1`) }));
	const root = join(o.work, 'training', 'history');
	mkdirSync(root, { recursive: true });
	write_json(join(root, 'meta.json'), {
		repo: repo_url,
		from,
		to,
		bench: bench_rev,
		commits: commits.length
	});
	log(
		`history: ${commits.length} commits touch ${src.join(', ')}; bench files of ${bench_rev.slice(0, 12)}`
	);
	for (const [i, { commit, parent }] of pairs.entries()) {
		const id = commit.slice(0, 12);
		const dir = join(root, id);
		if (done_before(dir, o)) {
			log(`${id} done before`);
			continue;
		}
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		const subject = git(repo, ['log', '-1', '--format=%s', commit]);
		log(`${id} ${subject}`);
		const base = overlay(
			repo,
			bench_rev,
			prepare_tree(repo, o.work, parent, HEISENBENCH_DIR, log),
			packages
		);
		const pr = overlay(
			repo,
			bench_rev,
			prepare_tree(repo, o.work, commit, HEISENBENCH_DIR, log),
			packages
		);
		// Which bench files load on both sides, counted once (exact, and cheap): the timed ones are
		// those whose import graph reaches a changed file (as correlate.ts picks them).
		const b = await run_tree(base, base.benches, join(dir, 'runs', 'select-base'), log, null, [
			'run'
		]);
		const p = await run_tree(pr, pr.benches, join(dir, 'runs', 'select-pr'), log, null, ['run']);
		const loaded = (r: Report | null) => new Set((r?.cases ?? []).map((c) => c.file));
		const both = [...loaded(b.report)].filter((f) => loaded(p.report).has(f));
		const changed = changed_files(repo, parent, commit).filter((f) => !is_shared(f));
		const files = select_changed(import_graphs(pr.dir, both), changed).selected;
		const extra = { commit, parent, subject };
		if (files.length === 0) {
			log(`${id}: no bench file reaches the change`);
			const meta: GroupMeta = {
				id,
				source: 'history',
				files,
				counts_only: o.counts_only ?? false,
				load: null,
				time_error: null,
				...extra
			};
			write_json(join(dir, 'group.json'), meta);
		} else {
			await measure_group(id, 'history', base, pr, files, dir, o, extra);
		}
		// Each tree is a full install: keep only what the next pair measures.
		for (const sha of trees_to_drop(pairs[i], pairs[i + 1])) remove_tree(o.work, sha);
	}
}

// ---- assembling

export interface AssembleOptions {
	work: string;
	out?: string;
	version?: number;
}

function groups_of(work: string, source: 'planted' | 'history'): string[] {
	const root = join(work, 'training', source);
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.filter((d) => existsSync(join(root, d, 'group.json')))
		.sort()
		.map((d) => join(root, d));
}

function machine(): TimesFile['machine'] {
	return {
		cpu: cpus()[0]?.model.trim() ?? 'unknown',
		cores: cpus().length,
		os: `${platform()} ${release()}`,
		node: process.version,
		v8: process.versions.v8
	};
}

function bench_repo_sha(): string | null {
	try {
		return git(HEISENBENCH_DIR, ['rev-parse', 'HEAD']);
	} catch {
		return null;
	}
}

/** The dataset from every finished group under `work`: both files' values. */
export function assemble(o: AssembleOptions): { counts: CountsFile; times: TimesFile | null } {
	const prices = loadPrices();
	const by_id = new Map(planted_pairs().map((p) => [p.id, p]));
	const counts: CountRow[] = [];
	const times: TimeRow[] = [];
	const loads: GroupLoad[] = [];
	let planted_n = 0;
	const templates = new Set<string>();
	for (const source of ['planted', 'history'] as const) {
		for (const dir of groups_of(o.work, source)) {
			const meta = read_json<GroupMeta>(join(dir, 'group.json'))!;
			const base = read_json<Report>(join(dir, 'base.json'));
			const pr = read_json<Report>(join(dir, 'pr.json'));
			const sizes = read_json<{
				base: Record<string, number | null>;
				pr: Record<string, number | null>;
			}>(join(dir, 'sizes.json'));
			if (!base || !pr || !sizes) continue;
			const pair_of = (c: CaseReport) => by_id.get(c.file.split('/')[0]);
			const rows = count_rows(
				{
					source,
					base: recount(base, prices),
					pr: recount(pr, prices),
					sizes,
					files: meta.files,
					id: (c) =>
						source === 'planted'
							? `planted/${pair_of(c)?.id ?? c.file}`
							: `history/${meta.id}/${c.file} > ${c.name}`,
					extra: (c) => {
						if (source === 'history')
							return { commit: meta.commit, parent: meta.parent, subject: meta.subject };
						const p = pair_of(c);
						if (!p) throw new Error(`training: ${c.file} is no planted pair`);
						return {
							template: p.template,
							variant: p.variant,
							planted: p.planted,
							planted_for: PLANTED_FOR[p.template],
							size: p.size
						};
					}
				},
				prices.prices
			);
			for (const r of rows) {
				if (r.template) templates.add(r.template);
				if (source === 'planted') planted_n++;
			}
			counts.push(...rows);
			if (meta.load) loads.push(meta.load);
			const t = read_json<TimeComparison>(join(dir, 'time', 'time.json'));
			if (t && meta.load) times.push(...time_rows(meta.id, rows, t));
		}
	}
	const by = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	counts.sort(by);
	times.sort(by);
	const history = read_json<{ repo: string; from: string; to: string; bench: string }>(
		join(o.work, 'training', 'history', 'meta.json')
	);
	const history_commits = groups_of(o.work, 'history').length;
	const counts_file: CountsFile = {
		schema: COUNTS_SCHEMA,
		prices: { version: prices.prices.version, hash: prices.hash },
		inputs: {
			planted: planted_n > 0 ? { templates: [...templates].sort(), pairs: planted_n } : null,
			history:
				history && history_commits > 0
					? {
							repo: history.repo,
							from: history.from,
							to: history.to,
							bench: history.bench,
							commits: history_commits
						}
					: null
		},
		rows: counts
	};
	const counts_problems = check_counts(counts_file);
	if (counts_problems.length > 0)
		throw new Error(
			`training: the counts do not check:\n${counts_problems.slice(0, 20).join('\n')}`
		);
	if (times.length === 0) return { counts: counts_file, times: null };
	const first = read_json<TimeComparison>(
		join(groups_of(o.work, 'planted')[0] ?? groups_of(o.work, 'history')[0], 'time', 'time.json')
	);
	const times_file: TimesFile = {
		schema: TIMES_SCHEMA,
		date: loads.map((l) => l.started).sort()[0],
		machine: { ...machine(), node: first?.node ?? process.version },
		heisenbench: bench_repo_sha(),
		repeats: first?.repeats ?? DEFAULT_REPEATS,
		time_ms: DEFAULT_TIME_MS,
		sample_fields: SAMPLE_FIELDS,
		groups: loads.sort(by),
		rows: times
	};
	const time_problems = check_times(times_file, counts_file);
	if (time_problems.length > 0)
		throw new Error(`training: the times do not check:\n${time_problems.slice(0, 20).join('\n')}`);
	return { counts: counts_file, times: times_file };
}

/** Write the dataset files; returns their paths. */
export function write_dataset(o: AssembleOptions): string[] {
	const { counts, times } = assemble(o);
	const out = resolve(o.out ?? DATA_DIR);
	const v = o.version ?? 1;
	mkdirSync(out, { recursive: true });
	const paths = [join(out, `training-counts-${v}.json`)];
	writeFileSync(paths[0], dataset_text(counts));
	if (times) {
		paths.push(join(out, `training-times-${v}.json`));
		writeFileSync(paths[1], dataset_text(times));
	}
	return paths;
}

if (import.meta.main) {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			planted: { type: 'boolean' },
			history: { type: 'boolean' },
			from: { type: 'string' },
			to: { type: 'string' },
			bench: { type: 'string' },
			repo: { type: 'string' },
			max: { type: 'string' },
			work: { type: 'string', default: '.work-training' },
			out: { type: 'string' },
			version: { type: 'string', default: '1' },
			repeats: { type: 'string' },
			'time-ms': { type: 'string' },
			batch: { type: 'string' },
			filter: { type: 'string' },
			'counts-only': { type: 'boolean' },
			'retime-above': { type: 'string' },
			'max-load': { type: 'string' },
			'max-wait-min': { type: 'string' }
		}
	});
	const log = (l: string) => console.log(`[training] ${l}`);
	const work = resolve(values.work);
	const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
	const o: MeasureOptions = {
		work,
		repeats: num(values.repeats),
		time_ms: num(values['time-ms']),
		counts_only: values['counts-only'] ?? false,
		retime_above: num(values['retime-above']),
		max_load: num(values['max-load']),
		max_wait_min: num(values['max-wait-min']),
		log
	};
	const cmd = positionals[0];
	if (cmd === 'measure') {
		if (!values.planted && !values.history)
			throw new Error('measure takes --planted, --history or both');
		if (values.planted)
			await measure_planted({ ...o, batch: num(values.batch), filter: values.filter });
		if (values.history) {
			if (!values.from) throw new Error('--history needs --from <rev>');
			await measure_history({
				...o,
				from: values.from,
				to: values.to,
				bench: values.bench,
				repo: values.repo,
				max: parse_max(values.max)
			});
		}
	} else if (cmd === 'assemble') {
		for (const p of write_dataset({ work, out: values.out, version: Number(values.version) }))
			log(`wrote ${p}`);
	} else {
		throw new Error('usage: training.ts measure|assemble [options] (see the head of the file)');
	}
}
