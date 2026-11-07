#!/usr/bin/env node
import './warnings.ts';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exit_on_signals } from './proc.ts';
import { UsageError } from './usage.ts';
import { REPORT_SCHEMA, one_line } from './report.ts';
import { run_benches } from './runner.ts';
import { diff_reports } from './diff/index.ts';
import { render_markdown } from './diff/markdown.ts';
import { git_diff } from './diff/git.ts';
import { write_private_dts } from './dts.ts';
import type { Report } from './report.ts';
import { engine_health } from './engine/health.ts';
import { DEFAULT_SIZES, run_growth } from './growth/index.ts';
import { locate_findings, reusable_growth, run_audit } from './audit/index.ts';
import { render_audit } from './audit/markdown.ts';
import { render_recorded_growth, run_recorded_growth } from './growth/recorded.ts';
import { SHAPES } from './growth/odds.ts';
import type { OddsOptions, Shape } from './growth/odds.ts';
import type { ShapePrior } from './growth/priors.ts';
import { alias_records, read_record_dir } from './coverage/replay-run.ts';
import { render_search, run_search } from './search/index.ts';
import { diff_sections, existing_report_text, render_sections, write_section } from './sections.ts';
import { measure_command, measure_run, time_section } from './measure/cli.ts';
import { app_command, app_diff_sections, diff_ranking } from './app/cli.ts';
import { VERIFY_LAYERS, render_verify, run_verify } from './verify/index.ts';
import { coverage_command } from './coverage/cli.ts';
import type { VerifyLayer } from './verify/index.ts';
import { needs_bench_repo, own_file } from './own.ts';
import { CONDITIONS_ENV, parse_conditions, register_conditions } from './loader/conditions.ts';
import { SVELTE_ENV } from './loader/svelte.ts';
import type { SvelteOutput } from './loader/svelte.ts';
import { blame_command } from './blame/cli.ts';
import { mutate_command } from './mutation/cli.ts';
import { prove_command } from './prove/cli.ts';
import { contracts_command } from './contracts/cli.ts';
import { upgrade_command } from './upgrade/cli.ts';
import { upstream_command } from './upstream/cli.ts';
import { history_command } from './history/cli.ts';
import { feel_command } from './models/cli.ts';
import type { CacheSummary } from './cache/index.ts';
import { receipt_command, registry_command, verify_receipt_command } from './receipt/cli.ts';

const HELP = `heisenbench: count the work a function does, per line, the same on every run.

Counting (the counting build)
  heisenbench run <bench files...>      count every case: steps, allocations, bytes, calls
      [--out heisenbench-report.json] [--root dir] [--filter text] [--sha sha]
      [--deps all|none|a,b]   dependencies counted (default all), blamed as name@version
      [--state fresh|shared] [--measure time,bytes,leaks|all] [--time-ms 300]
      [--source-from sha]   these bench files on that commit's code: a repo's first PR, whose
                            base has no bench files yet (files the commit lacks come from disk)
      [--cache dir]   reuse the counts of every case whose code and inputs did not change
      [--svelte client]   .svelte compiled as client output (mount, hydrate, updates on a DOM
                          a preload brings), with the browser export condition
      [--append]   add these cases to the report already in --out (same commit): a server
                   run and a client run as one report
      [--cache-verify n]   count n reused cases again; a difference fails the case (a cache bug)
  heisenbench diff <base.json> <pr.json>   compare two reports: the markdown section
      [--repo dir] [--base sha] [--head sha] [--out section.md] [--json diff.json]
      [--time time.json] [--weights app-weights.json[,real-weights.json]] [--requests-per-day n]
  heisenbench blame <base.json> <pr.json> --root <pr checkout>   the hunks that made each
                                 regressed case slower, by recounting the PR with hunks undone
      [--repo dir] [--base sha] [--head sha] [--filter text] [--paths files.txt] [--min-ratio 0.02]
      [--max-recounts 60] [--budget-ms 600000] [--jobs n] [--work dir] [--out blame.json] [--md blame.md]
      [--weights app-weights.json[,real-weights.json]] [--requests-per-day n]   the change's real cost
  heisenbench mutate <bench files...> --root dir --list sources.txt   performance mutants (2x,
                                 quadratic, an allocation, a defeated cache) in every function of the
                                 sources: which ones the bench cases notice, and a case for each miss
      [--report base.json] [--operators double,quadratic,alloc,cache] [--sample 60|all] [--seed 1]
      [--modules a.ts,b.ts] [--mutate-deps on|off] [--sizes 1,10,100] [--cap 5e8] [--records dir]
      [--alias built-to-source.json] [--weights app-weights.json[,real-weights.json]]
      [--jobs n] [--max-recounts 6000] [--budget-ms 3600000] [--work dir] [--out mutation.json] [--md mutation.md]
  heisenbench upgrade <base.json> <pr.json> --root <pr checkout> --base-root <base checkout>
                                 what the PR's dependency upgrades cost: the PR's code counted
                                 with each side's install, the change placed on upstream lines
      [--packages a,b] [--deps all|none|a,b] [--work dir] [--out upgrade.json] [--md upgrade.md]
  heisenbench upstream draft <upgrade.json>   an issue for the upgraded package's maintainers: a
                                 standalone repro script timed on both versions, the counts, the
                                 line and the upstream change (written to files, never posted)
      [--case text] [--function name] [--entry specifier#export] [--input generator.ts]
      [--redact a,b] [--time-ms 1000] [--out issue.md] [--repro repro.ts] [--work dir]
  heisenbench history <file>[:<function>] --reports <dirs or files>   git blame for steps: each
                                 line's steps per call today, the commit that last changed its
                                 cost and by how much (followed through edits and moves), and each
                                 function's timeline, from one report per first-parent commit
      [--repo dir] [--rev HEAD] [--out history.json] [--md history.md]
  heisenbench dts <source files...> --out heisenbench-private.d.ts [--tsconfig tsconfig.json]
                                 types for the private functions bench files import as __heisenbench

Release receipts
  heisenbench receipt <bench files...> --package <tarball | URL | name@version>   a release's counts:
                                 the tarball installed in a scratch tree, each case counted and
                                 grown in a process of its own, written down with the tarball's
                                 integrity, the lockfile, the bench files, the engine and Node
      [--include files,...]   files the bench files import or read, kept in the receipt too
      [--preload files,...]   kept in the receipt, imported first by every counting process
      [--root dir] [--npm on|off] [--work dir] [--jobs n]
      [--out heisenbench-receipt.json]
  heisenbench verify-receipt <receipt.json> <tarball | URL | name@version>   counts the tarball again
                                 the way the receipt was made: "matches", or the first difference
      [--work dir] [--jobs n] [--json result.json]
  heisenbench registry <receipts...> --out index.html   the static page comparing them

Layers (each writes its section into --out, default heisenbench-report.json)
  heisenbench health <bench files...>   V8 tiers, deopts and inline caches on the plain build
      [--warmup 20] [--runs 3] [--check on|off] [--root dir] [--filter text] [--out file]
  heisenbench growth <bench files...>   steps at 1x, 10x, 100x the input; the curve class and the
                                 odds of each shape (one more size when the top two are close)
      [--sizes 1,10,100] [--scaled on|off] [--cap 1e10] [--deps all|none|a,b] [--root dir]
      [--filter text] [--out file] [--superlinear-odds 0.9] [--growth-prior prior.json]
      [--cache dir] [--cache-verify n]
  heisenbench growth --recorded <dir>   growth from a test run's recorded calls (no bench files):
                                 every recorded function's steps over its input sizes; a finding
                                 needs --superlinear-odds (default 0.9) of quadratic or worse
      [--modules a.ts,b.ts] [--alias built-to-source.json] [--cap 5e8] [--budget-steps n]
      [--root dir] [--out file] [--md file] [--superlinear-odds 0.9] [--growth-prior prior.json]
  heisenbench contracts <source files...> --reports a.json[,b.json]   each complexity contract
                                 (\`/** @heisenbench linear in items */\` on a function) held against
                                 the growth those reports measured; exit 1 when one does not hold
      [--list files.txt] [--root dir] [--out file] [--md file] [--contract-odds 0.9]
  heisenbench search <bench files...>   the input that costs the most work per unit of input:
                                 shrunk, grown 1x to 8x, blamed by line
      [--evals 300] [--budget-steps 2e8] [--budget-ms 30000] [--seed 1] [--size-factor 1]
      [--shrink 200] [--flag 4] [--guided on|off] [--regex on|off] [--schedule bandit|fixed]
      [--root dir] [--filter text] [--out file] [--md file]
  heisenbench audit <bench files...>    the prices checked against time at every growth size
      [--sizes 1,10,100] [--scaled on|off] [--repeats 5] [--time-ms 200] [--root dir]
      [--filter text] [--out file] [--md audit.md]
  heisenbench time <bench files...> --base dir --pr dir   both trees timed in one process, in turns
      [--repeats 5] [--time-ms 300] [--filter text] [--out heisenbench-time.json] [--md time.md]

Proving a faster version (on demand, not in PR CI)
  heisenbench prove <module> <function> --candidate <file> --records dir[,dir] [--bench files]
                                 proven (the same on every recorded, grown and edge-case input, no
                                 input costlier), proven at scale (the same, cheaper at scale,
                                 costlier on small inputs: exit 3) or rejected (exit 1)
      [--root dir] [--deps all|none|a,b] [--sizes 1,10,100] [--cap 1e10] [--variants 160]
      [--edge shapes|all] [--seed 1] [--tolerance 5] [--tolerance-steps 256]
      [--setup-tolerance pct]   opt-in: proven at scale within it is proven
      [--weights app-weights.json,...]   which input sizes the app scenarios call it at
      [--out heisenbench-prove.json] [--md file]
  heisenbench prove <module> <function> --propose [--proposals 3] [--model claude-opus-5-5] [--send-inputs]
                                 candidates proposed by a model (ANTHROPIC_API_KEY), each proven
                                 the same way; only proven and proven-at-scale ones are reported

Real apps and the measurement-source gate
  heisenbench weights <app-report.json...> [--out app-weights.json]
  heisenbench weights import <profiles...> [--out real-weights.json]   weights of real traffic, from
                                 .cpuprofile, ogygia profiler reports (.json, .ogp) or heisenbench-traffic JSON
      [--root dir] [--requests n] [--path-map /srv/app=./app,...] [--secret s]
  heisenbench coverage <app-report.json...> --app <app dir,app dir...> [--packages ogygia,@ogygia/*]
      [--out coverage.json] [--md coverage.md]
  heisenbench inventory [files...] [--list files.txt] --root dir --out inventory.json
      [--reports a.json,b.json --targets targets.json]
  heisenbench record <bench files...> --targets targets.json --root dir --out samples.bin
                                 every case run once with the input recorder on (more samples)
  heisenbench replay --records dir --root dir --out replay.json
  heisenbench unmeasured --inventory inventory.json [--reports a.json,b.json] [--records dir]
      [--replay replay.json] [--skipped skipped.json] [--base-inventory base.json]
      [--repo dir --base sha --head sha] [--exempt unmeasured.json] [--out gate.json] [--md gate.md]

Calibration and proof (from a clone of github.com/ogygiajs/bench only: the npm package does not
ship the calibration corpus or the planted cases)
  heisenbench calibrate prices [--keys a,b] [--sizes 16,64,256] [--out prices.json] [--time-ms 100]
  heisenbench calibrate points [bench files...] [--root dir] [--out points.json] [--time-ms 150] [--repeats 3]
  heisenbench calibrate agree <a.json> <b.json> [--tolerance 3] [--shift 5]
  heisenbench calibrate weights [bench files...] | --points a.json,b.json [--out weights.json]
  heisenbench calibrate ranges [--data dir] [--data-version 1] [--out ranges.json] [--seed 1] [--md evaluation.md]
                                 train the steps -> ms range model on the training data; --md
                                 also writes its held-out evaluation
  heisenbench verify [--layers steps,elision,leak,engine,growth,contract,search,app,time,trend] [--filter text]
      [--jobs n] [--md table.md] [--json rows.json]
  heisenbench feel train [--data-version 1] [--seed 1] [--out feel.json] [--md eval.md]
                                 fit the odds a step change shows up on the clock from the
                                 training dataset (calibration/data/), with its held-out scores
  heisenbench feel check         fit them again: exit 1 unless feel.json comes out byte for byte

Every command that loads bench files (run, health, growth, search, audit, time, blame, record,
prove) also takes --import <file>[,file]: a preload loaded first, in this process and in every
process it starts (resolve hooks for path aliases, Vite-only modules, globals the code expects),
and --conditions <name>[,name]: export conditions the code under test resolves packages with, as
its bundler does (svelte for a Svelte project; Heisenbench's own imports keep Node's), and
--svelte client|server: the output .svelte files compile to (default server). Relative
imports of TypeScript sources (./x.js for x.ts, ./x for x.ts or x/index.ts), and imports with no
extension inside a package (./helpers for helpers.js), resolve without one.

Optional peer dependencies, installed in the project when needed: typescript (heisenbench dts, and
TypeScript that type stripping cannot run), svelte (.svelte files), playwright (the app layer).

Docs: https://github.com/ogygiajs/bench/tree/main/packages/heisenbench#readme`;

/** `heisenbench verify`: every planted case of every layer; exit 1 when any fails. */
async function verify_command(flags: Map<string, string>): Promise<number> {
	needs_bench_repo('test/answer-key');
	const layers = flags.get('layers')?.split(',') as VerifyLayer[] | undefined;
	const bad = layers?.filter((l) => !VERIFY_LAYERS.includes(l));
	if (bad && bad.length > 0) {
		console.error(
			`heisenbench verify: unknown layer ${bad.join(', ')} (${VERIFY_LAYERS.join(', ')})`
		);
		return 2;
	}
	const rows = await run_verify({
		layers,
		filter: flags.get('filter'),
		jobs: flags.has('jobs') ? Number(flags.get('jobs')) : undefined,
		log: (r) =>
			console.log(`${r.pass ? 'pass' : 'FAIL'}  ${r.layer}/${r.name}  ${r.got}  (${r.ms} ms)`)
	});
	console.log('\n' + render_verify(rows, false));
	const md = flags.get('md');
	if (md) writeFileSync(md, render_verify(rows));
	const json = flags.get('json');
	if (json) writeFileSync(json, JSON.stringify(rows, null, '\t') + '\n');
	return rows.length > 0 && rows.every((r) => r.pass) ? 0 : 1;
}

/**
 * `heisenbench growth --recorded <dir>`: growth from a test run's recorded calls (growth/recorded.ts),
 * written as the report's `recorded_growth` section; `--md` writes the superlinear findings.
 */
async function recorded_growth_command(
	common: { root: string; deps: boolean | string[]; log: (l: string) => void },
	flags: Map<string, string>,
	info: { root: string; sha: string | null },
	out: string,
	num: (k: string) => number | undefined
): Promise<number> {
	const dir = flags.get('recorded')!;
	if (!(existsSync(dir) && statSync(dir).isDirectory()))
		throw new UsageError(`--recorded ${dir} is not a directory`);
	const modules = flags.get('modules');
	const alias = flags.get('alias');
	let records = read_record_dir(dir);
	if (alias !== undefined) {
		if (!existsSync(alias)) throw new UsageError(`--alias ${alias}: no such file`);
		records = alias_records(
			records,
			JSON.parse(readFileSync(alias, 'utf8')) as Record<string, string>
		);
	}
	const r = await run_recorded_growth({
		root: common.root,
		deps: common.deps,
		log: common.log,
		records,
		modules: modules === undefined ? undefined : new Set(modules.split(',').filter(Boolean)),
		cap: num('cap'),
		budget_steps: num('budget-steps'),
		odds: odds_options(flags)
	});
	write_section(out, 'recorded_growth', r, info);
	const md = render_recorded_growth(r);
	const md_out = flags.get('md');
	if (md_out) writeFileSync(md_out, md);
	console.log(md);
	return 0;
}

/**
 * `--superlinear-odds 0.9` (the odds of quadratic or worse a growth finding needs) and
 * `--growth-prior file.json` (shape -> weight, in place of the default prior of growth/priors.ts).
 */
function odds_options(flags: Map<string, string>): OddsOptions {
	const out: OddsOptions = {};
	const bar = flags.get('superlinear-odds');
	if (bar !== undefined) {
		const v = Number(bar);
		if (!(v > 0 && v <= 1))
			throw new UsageError(
				`--superlinear-odds takes a number in (0, 1], not ${JSON.stringify(bar)}`
			);
		out.min_odds = v;
	}
	const file = flags.get('growth-prior');
	if (file !== undefined) {
		if (!existsSync(file)) throw new UsageError(`--growth-prior ${file}: no such file`);
		const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
		const prior = {} as ShapePrior;
		for (const s of SHAPES) prior[s] = 0;
		for (const [k, v] of Object.entries(raw)) {
			if (!SHAPES.includes(k as Shape))
				throw new UsageError(
					`--growth-prior: ${JSON.stringify(k)} is not a shape (${SHAPES.join(', ')})`
				);
			if (typeof v !== 'number' || !(v >= 0))
				throw new UsageError(`--growth-prior: ${k} takes a weight of 0 or more`);
			prior[k as Shape] = v;
		}
		if (!SHAPES.some((s) => prior[s] > 0))
			throw new UsageError('--growth-prior: every weight is 0');
		out.prior = prior;
	}
	return out;
}

/** `--deps all|none|a,b`: which dependencies are counted (`fallback` when the flag is absent). */
function deps_of(flag: string | undefined, fallback: boolean): boolean | string[] {
	if (flag === undefined) return fallback;
	if (flag === 'all') return true;
	if (flag === 'none') return false;
	return flag.split(',').filter((p) => p !== '');
}

interface Parsed {
	positional: string[];
	flags: Map<string, string>;
}

interface Spec {
	/** Options that take a value. */
	values: readonly string[];
	/** How many positional arguments: [min, max]. */
	args: [number, number];
	/** The positional arguments are files that must exist (`calibrate`: after its subcommand). */
	files?: boolean;
	/** Options of this command that take no value. */
	switches?: readonly string[];
}

const BENCH = ['root', 'filter', 'out', 'deps', 'sha', 'import', 'conditions', 'svelte'];
const MANY = Number.POSITIVE_INFINITY;

const SPECS: Record<string, Spec> = {
	run: {
		values: [...BENCH, 'state', 'measure', 'time-ms', 'source-from', 'cache', 'cache-verify'],
		args: [1, MANY],
		files: true,
		switches: ['append']
	},
	diff: {
		values: [
			'repo',
			'base',
			'head',
			'out',
			'json',
			'time',
			'weights',
			'requests-per-day',
			'superlinear-odds'
		],
		args: [2, 2],
		files: true
	},
	blame: {
		values: [
			'root',
			'repo',
			'base',
			'head',
			'filter',
			'paths',
			'min-ratio',
			'max-recounts',
			'budget-ms',
			'jobs',
			'work',
			'deps',
			'weights',
			'requests-per-day',
			'out',
			'md',
			'import',
			'conditions',
			'svelte'
		],
		args: [2, 2],
		files: true
	},
	upgrade: {
		values: ['root', 'base-root', 'packages', 'deps', 'work', 'out', 'md'],
		args: [2, 2],
		files: true
	},
	// `draft` and the upgrade JSON
	upstream: {
		values: ['case', 'function', 'entry', 'input', 'redact', 'time-ms', 'out', 'repro', 'work'],
		args: [2, 2],
		files: true
	},
	// `<file>[:<function>]`, a path in git at --rev (not on disk)
	history: { values: ['reports', 'repo', 'rev', 'out', 'md'], args: [1, 1] },
	dts: { values: ['out', 'tsconfig'], args: [1, MANY], files: true },
	receipt: {
		values: ['package', 'include', 'preload', 'root', 'npm', 'work', 'jobs', 'out'],
		args: [1, MANY],
		files: true
	},
	// the tarball may be a URL or name@version
	'verify-receipt': { values: ['work', 'jobs', 'json'], args: [2, 2] },
	registry: { values: ['out'], args: [1, MANY], files: true },
	health: { values: [...BENCH, 'warmup', 'runs', 'check'], args: [1, MANY], files: true },
	audit: {
		values: [...BENCH, 'sizes', 'scaled', 'repeats', 'time-ms', 'md'],
		args: [1, MANY],
		files: true
	},
	// bench files, or none with --recorded (a test run's sample files)
	growth: {
		values: [
			...BENCH,
			'sizes',
			'scaled',
			'cap',
			'recorded',
			'alias',
			'modules',
			'budget-steps',
			'md',
			'superlinear-odds',
			'growth-prior',
			'cache',
			'cache-verify'
		],
		args: [0, MANY],
		files: true
	},
	contracts: {
		values: ['root', 'list', 'reports', 'out', 'md', 'sha', 'contract-odds'],
		args: [0, MANY],
		files: true
	},
	search: {
		values: [
			...BENCH,
			'evals',
			'budget-steps',
			'budget-ms',
			'seed',
			'size-factor',
			'shrink',
			'flag',
			'guided',
			'regex',
			'schedule',
			'md'
		],
		args: [1, MANY],
		files: true
	},
	time: {
		values: [
			'base',
			'pr',
			'repeats',
			'time-ms',
			'filter',
			'out',
			'md',
			'import',
			'conditions',
			'svelte'
		],
		args: [1, MANY]
	},
	// app reports, or `import` and production profiles
	weights: {
		values: ['out', 'root', 'requests', 'path-map', 'secret'],
		args: [1, MANY],
		files: true
	},
	coverage: { values: ['app', 'packages', 'out', 'md'], args: [1, MANY], files: true },
	inventory: { values: ['list', 'root', 'out', 'reports', 'targets'], args: [0, MANY] },
	replay: { values: ['records', 'root', 'out'], args: [0, 0] },
	record: {
		values: ['targets', 'root', 'out', 'import', 'conditions', 'svelte'],
		args: [1, MANY],
		files: true
	},
	unmeasured: {
		values: [
			'inventory',
			'reports',
			'records',
			'replay',
			'skipped',
			'base-inventory',
			'exempt',
			'out',
			'md',
			'repo',
			'base',
			'head'
		],
		args: [0, 0]
	},
	calibrate: {
		values: [
			'keys',
			'sizes',
			'out',
			'time-ms',
			'root',
			'filter',
			'repeats',
			'points',
			'tolerance',
			'shift',
			'data',
			'data-version',
			'seed',
			'md'
		],
		args: [1, MANY],
		files: true
	},
	verify: { values: ['layers', 'filter', 'jobs', 'md', 'json'], args: [0, 0] },
	mutate: {
		values: [
			'root',
			'list',
			'report',
			'operators',
			'sample',
			'seed',
			'modules',
			'mutate-deps',
			'sizes',
			'cap',
			'records',
			'alias',
			'weights',
			'requests-per-day',
			'deps',
			'jobs',
			'max-recounts',
			'budget-ms',
			'work',
			'suggestions',
			'out',
			'md'
		],
		args: [1, MANY],
		files: true
	},
	feel: { values: ['data-version', 'seed', 'data', 'out', 'md'], args: [1, 1] },
	prove: {
		values: [
			'candidate',
			'records',
			'bench',
			'root',
			'deps',
			'out',
			'md',
			'sizes',
			'cap',
			'variants',
			'edge',
			'seed',
			'tolerance',
			'tolerance-steps',
			'setup-tolerance',
			'weights',
			'proposals',
			'model',
			'import',
			'conditions',
			'svelte'
		],
		args: [2, 2],
		switches: ['propose', 'send-inputs']
	}
};

/** Options that take no value. */
const SWITCHES = new Set(['help', 'debug']);

/** Numeric options and what they accept. */
const NUMBERS: Record<string, 'positive' | 'count' | 'whole' | 'integer'> = {
	'time-ms': 'positive',
	warmup: 'whole',
	runs: 'count',
	evals: 'count',
	'budget-steps': 'positive',
	'budget-ms': 'positive',
	seed: 'integer',
	'size-factor': 'positive',
	cap: 'positive',
	repeats: 'count',
	jobs: 'count',
	tolerance: 'positive',
	shift: 'positive',
	requests: 'positive',
	'requests-per-day': 'positive',
	'max-recounts': 'count',
	'min-ratio': 'positive',
	suggestions: 'whole',
	variants: 'whole',
	'tolerance-steps': 'whole',
	'setup-tolerance': 'whole',
	proposals: 'count',
	'data-version': 'count'
};

const CHOICES: Record<string, readonly string[]> = {
	state: ['fresh', 'shared'],
	check: ['on', 'off'],
	scaled: ['on', 'off'],
	'mutate-deps': ['on', 'off'],
	edge: ['shapes', 'all'],
	npm: ['on', 'off']
};

function check_number(name: string, v: string): void {
	const n = Number(v);
	const kind = NUMBERS[name];
	const ok =
		v.trim() !== '' &&
		Number.isFinite(n) &&
		(kind === 'positive'
			? n > 0
			: kind === 'count'
				? Number.isInteger(n) && n > 0
				: kind === 'whole'
					? Number.isInteger(n) && n >= 0
					: Number.isInteger(n));
	if (!ok) {
		const want =
			kind === 'positive'
				? 'a number above 0'
				: kind === 'count'
					? 'a whole number above 0'
					: kind === 'whole'
						? 'a whole number'
						: 'an integer';
		throw new UsageError(`--${name} takes ${want}, not ${JSON.stringify(v)}`);
	}
}

function parse(cmd: string, argv: string[]): Parsed {
	const spec = SPECS[cmd];
	const positional: string[] = [];
	const flags = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--') {
			positional.push(...argv.slice(i + 1));
			break;
		}
		if (a === '-h') {
			flags.set('help', '');
			continue;
		}
		if (!a.startsWith('-') || a === '-') {
			positional.push(a);
			continue;
		}
		if (!a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
		const eq = a.indexOf('=');
		const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
		if (SWITCHES.has(name) || spec.switches?.includes(name)) {
			flags.set(name, '');
			continue;
		}
		if (!spec.values.includes(name)) {
			const known = spec.values.map((v) => `--${v}`).join(', ');
			throw new UsageError(`unknown option --${name}${known ? ` (it takes ${known})` : ''}`);
		}
		let value: string;
		if (eq !== -1) {
			value = a.slice(eq + 1);
		} else {
			const next = argv[i + 1];
			// a value never looks like another option (a negative number does)
			if (next === undefined || (next.startsWith('--') && next.length > 2))
				throw new UsageError(`--${name} needs a value`);
			value = next;
			i++;
		}
		if (value === '') throw new UsageError(`--${name} needs a value`);
		if (NUMBERS[name]) check_number(name, value);
		const choices = CHOICES[name];
		if (choices && !choices.includes(value))
			throw new UsageError(`--${name} takes ${choices.join(' or ')}, not ${JSON.stringify(value)}`);
		flags.set(name, value);
	}
	if (flags.has('help')) return { positional, flags };
	const [min, max] = spec.args;
	if (positional.length < min) {
		throw new UsageError(
			min === 1 ? 'which files? (none given)' : `needs ${min} files, got ${positional.length}`
		);
	}
	if (positional.length > max) {
		throw new UsageError(
			max === 0
				? `takes no file arguments (got ${positional.join(' ')})`
				: `takes ${max} files, got ${positional.length}`
		);
	}
	if (spec.files) {
		const files =
			cmd === 'calibrate' || cmd === 'upstream' || (cmd === 'weights' && positional[0] === 'import')
				? positional.slice(1)
				: positional;
		for (const f of files) {
			if (!existsSync(f)) throw new UsageError(`no such file: ${f}`);
			if (!statSync(f).isFile()) throw new UsageError(`${f} is a directory, not a file`);
		}
	}
	if (flags.has('sizes')) {
		for (const s of flags.get('sizes')!.split(',')) {
			if (!(Number(s) > 0))
				throw new UsageError(`--sizes takes numbers above 0, not ${JSON.stringify(s)}`);
		}
	}
	return { positional, flags };
}

/** `--cache dir [--cache-verify n]` (run, growth): incremental counting (cache/). */
function cache_option(flags: Map<string, string>): { dir: string; verify: number } | undefined {
	const dir = flags.get('cache');
	const verify = flags.has('cache-verify') ? Number(flags.get('cache-verify')) : 0;
	if (!(Number.isInteger(verify) && verify >= 0))
		throw new UsageError('--cache-verify takes a whole number of cases');
	if (flags.has('cache-verify') && dir === undefined)
		throw new UsageError('--cache-verify needs --cache <dir>');
	return dir === undefined ? undefined : { dir: resolve(dir), verify };
}

/** What the cache did, and every cache bug, loudly. */
function print_cache(c: CacheSummary, cmd: string): void {
	const checked =
		c.verified > 0
			? `, ${c.verified} reused case(s) counted again: ${c.mismatches.length === 0 ? 'the same' : `${c.mismatches.length} differ`}`
			: '';
	console.log(`cache    ${c.reused} reused, ${c.counted} counted${checked}`);
	for (const m of c.mismatches)
		console.error(`heisenbench ${cmd}: CACHE BUG: a reused case differs from its recount: ${m}`);
}

/** An heisenbench report from a file, or a clear error. */
function read_report(path: string): Report {
	let r: unknown;
	try {
		r = JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		throw new UsageError(`${path} is not JSON`);
	}
	if (r === null || typeof r !== 'object' || (r as Report).schema !== REPORT_SCHEMA)
		throw new UsageError(`${path} is not an heisenbench report (no "schema": "${REPORT_SCHEMA}")`);
	const rep = r as Report;
	if (!Array.isArray(rep.cases)) throw new UsageError(`${path} has no cases`);
	return rep;
}

async function main(argv: string[]): Promise<number> {
	const [cmd, ...rest] = argv;
	if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
		console.log(HELP);
		return cmd === undefined ? 2 : 0;
	}
	if (!(cmd in SPECS)) {
		throw new UsageError(
			cmd.startsWith('-') ? `give a command before ${cmd}` : `unknown command ${cmd}`
		);
	}
	const { positional, flags } = parse(cmd, rest);
	if (flags.has('help')) {
		console.log(HELP);
		return 0;
	}
	check_dirs(cmd, flags);
	const svelte = svelte_flag(flags.get('svelte'));
	conditions(flags.get('conditions'), svelte);
	await preload(flags.get('import'));
	if (cmd === 'run') {
		const deps = deps_of(flags.get('deps'), true);
		const source_from = flags.get('source-from');
		// the plain-build layers load the working tree's files, not the commit's
		if (source_from !== undefined && flags.has('measure'))
			throw new UsageError('--source-from counts only: it takes no --measure');
		const out = flags.get('out') ?? 'heisenbench-report.json';
		// read before the run writes it: the cases of an earlier run this one adds to
		const before = flags.has('append') && existing_report_text(out) !== null ? read_report(out) : null;
		const report = await run_benches({
			files: positional,
			root: flags.get('root'),
			out,
			deps,
			svelte,
			filter: flags.get('filter'),
			sha: flags.get('sha') ?? null,
			fresh: flags.get('state') !== 'shared',
			log: (l) => console.log(l),
			debug: flags.has('debug') || process.env.HEISENBENCH_DEBUG === '1',
			source_from,
			cache: cache_option(flags)
		});
		if (report.cache) print_cache(report.cache, 'run');
		await measure_run(report, positional, flags);
		if (before) append_report(out, before);
		if (report.cases.length === 0 && (report.load_errors ?? []).length === 0)
			console.error(
				'heisenbench run: no bench cases (no file calls bench(), or --filter matched none)'
			);
		const bad =
			report.cases.length === 0 ||
			(report.load_errors ?? []).length > 0 ||
			report.cases.some((c) => c.error !== null || c.measure?.errors !== undefined);
		return bad ? 1 : 0;
	}
	const measured = await measure_command(cmd, positional, flags);
	if (measured !== null) return measured;
	const app = await app_command(cmd, positional, flags);
	if (app !== null) return app;
	if (cmd === 'verify') return verify_command(flags);
	if (cmd === 'feel') return feel_command(positional, flags);
	if (cmd === 'contracts') return contracts_command(positional, flags);
	if (cmd === 'prove') return prove_command(positional, flags);
	const coverage = await coverage_command(cmd, positional, flags);
	if (coverage !== null) return coverage;
	if (cmd === 'diff') {
		const base = read_report(positional[0]);
		const pr = read_report(positional[1]);
		const repo = flags.get('repo');
		const base_sha = flags.get('base') ?? base.git.sha;
		const head_sha = flags.get('head') ?? pr.git.sha;
		const files =
			repo !== undefined && base_sha && head_sha
				? git_diff(resolve(repo), base_sha, head_sha)
				: null;
		const result = diff_reports(base, pr, { files });
		const sections = diff_sections(base, pr, files, odds_options(flags));
		const extra = render_sections(sections);
		const time = time_section(flags);
		const ranking = diff_ranking(result, base, pr, flags);
		const apps = app_diff_sections(result, base, pr, flags, ranking);
		const md =
			(apps ? apps + '\n' : '') +
			render_markdown(result) +
			(extra ? '\n' + extra : '') +
			(time ? '\n' + time : '');
		const out = flags.get('out');
		if (out) writeFileSync(out, md + '\n');
		else console.log(md);
		const json = flags.get('json');
		if (json)
			writeFileSync(
				json,
				JSON.stringify({ ...result, ...sections, ...(ranking ? { ranking } : {}) }, null, '\t') +
					'\n'
			);
		return 0;
	}
	if (cmd === 'blame') {
		return blame_command(positional, flags, read_report, deps_of(flags.get('deps'), true));
	}
	if (cmd === 'mutate') {
		return mutate_command(positional, flags, read_report, deps_of(flags.get('deps'), true));
	}
	if (cmd === 'upgrade') {
		return upgrade_command(positional, flags, read_report, deps_of(flags.get('deps'), true));
	}
	if (cmd === 'upstream') return upstream_command(positional, flags);
	if (cmd === 'receipt') return receipt_command(positional, flags);
	if (cmd === 'verify-receipt') return verify_receipt_command(positional, flags);
	if (cmd === 'registry') return registry_command(positional, flags);
	if (cmd === 'history') return history_command(positional, flags);
	if (cmd === 'health' || cmd === 'growth' || cmd === 'search' || cmd === 'audit') {
		const root = flags.get('root') ?? process.cwd();
		const out = flags.get('out') ?? 'heisenbench-report.json';
		const common = {
			files: positional,
			root,
			filter: flags.get('filter'),
			// engine health stays on the project's own code: what V8 does with a dependency is not
			// the project's to fix
			deps: deps_of(flags.get('deps'), cmd !== 'health'),
			svelte,
			log: (l: string) => console.log(l)
		};
		const num = (k: string): number | undefined =>
			flags.has(k) ? Number(flags.get(k)) : undefined;
		const on_off = (k: string): boolean | undefined => {
			const v = flags.get(k);
			if (v === undefined) return undefined;
			if (v !== 'on' && v !== 'off') throw new UsageError(`--${k} takes on or off`);
			return v === 'on';
		};
		const info = { root, sha: flags.get('sha') ?? null };
		if (cmd === 'health') {
			const r = await engine_health({
				...common,
				warmup: num('warmup'),
				runs: num('runs'),
				check: flags.get('check') !== 'off'
			});
			write_section(out, 'engine', r, info);
			return r.cases.some((c) => c.error !== null) ? 1 : 0;
		}
		if (cmd === 'audit') {
			const sizes = flags.get('sizes')?.split(',').map(Number) ?? DEFAULT_SIZES;
			const existing = existing_report_text(out) !== null ? read_report(out) : null;
			const growth = reusable_growth(existing, sizes);
			if (growth) console.log(`audit   steps at every size from the growth section of ${out}`);
			const r = await run_audit({
				...common,
				sizes,
				scaled: flags.get('scaled') === 'on',
				repeats: num('repeats'),
				time_ms: num('time-ms'),
				growth
			});
			locate_findings(r, existing);
			write_section(out, 'audit', r, info);
			const md = flags.get('md');
			if (md) writeFileSync(md, render_audit(r) + '\n');
			return r.failed.length > 0 ? 1 : 0;
		}
		if (cmd === 'growth' && flags.has('recorded')) {
			return recorded_growth_command(common, flags, info, out, num);
		}
		if (cmd === 'growth') {
			if (positional.length === 0)
				throw new UsageError('which files? (none given, and no --recorded)');
			const sizes = flags.get('sizes')?.split(',').map(Number);
			const r = await run_growth({
				...common,
				sizes,
				cap: num('cap'),
				scaled: flags.get('scaled') === 'on',
				odds: odds_options(flags),
				cache: cache_option(flags)
			});
			if (r.cache) print_cache(r.cache, 'growth');
			write_section(out, 'growth', r, info);
			return r.cases.some((c) => c.error !== null) ? 1 : 0;
		}
		const schedule = flags.get('schedule');
		if (schedule !== undefined && schedule !== 'bandit' && schedule !== 'fixed')
			throw new UsageError('--schedule takes bandit or fixed');
		const r = await run_search({
			...common,
			schedule,
			evals: num('evals'),
			steps: num('budget-steps'),
			ms: num('budget-ms'),
			seed: num('seed'),
			size_factor: num('size-factor'),
			shrink: num('shrink'),
			flag: num('flag'),
			guided: on_off('guided'),
			regex: on_off('regex')
		});
		write_section(out, 'search', r, info);
		const md = flags.get('md');
		if (md) writeFileSync(md, render_search(r));
		return r.cases.some((c) => c.error !== null) ? 1 : 0;
	}
	if (cmd === 'dts') {
		const out = flags.get('out');
		if (!out) throw new UsageError('--out <file> is required');
		write_private_dts({
			files: positional.map((f) => resolve(f)),
			out: resolve(out),
			tsconfig: flags.get('tsconfig')
		});
		return 0;
	}
	throw new UsageError(`unknown command ${cmd}`);
}

/**
 * `--import a.ts,b.ts`: each file imported here, before any bench file, and added to
 * NODE_OPTIONS as `--import=<absolute path>`, so every process this one starts (health, time,
 * bytes and leak children, blame recounts) loads it first too. The same as setting
 * `NODE_OPTIONS=--import=./a.ts` by hand.
 */
async function preload(list: string | undefined): Promise<void> {
	if (list === undefined) return;
	for (const f of list.split(',').filter(Boolean)) {
		const abs = resolve(f);
		if (!existsSync(abs) || !statSync(abs).isFile())
			throw new UsageError(`--import ${f}: no such file`);
		if (/\s/.test(abs))
			throw new UsageError(`--import ${f}: a path with a space cannot go in NODE_OPTIONS`);
		await import(pathToFileURL(abs).href);
		const opts = process.env.NODE_OPTIONS ?? '';
		process.env.NODE_OPTIONS = `${opts} --import=${abs}`.trim();
	}
}

/**
 * `run --append`: the cases of the report already in `out` (`before`, the same commit and prices)
 * kept next to the ones this run wrote there, so a server run and a client run of one commit are
 * one report for `diff`. A case of the same name is this run's; its other sections stay.
 */
function append_report(out: string, before: Report): void {
	const now = read_report(out);
	if (before.git.sha !== now.git.sha || before.prices.hash !== now.prices.hash)
		throw new UsageError(
			`--append: ${out} was counted at another commit or with other prices; count both runs at one commit`
		);
	const names = new Set(now.cases.map((c) => c.name));
	const files = new Set([
		...now.cases.map((c) => c.file),
		...(now.load_errors ?? []).map((e) => e.file)
	]);
	const load_errors = [
		...(before.load_errors ?? []).filter((e) => !files.has(e.file)),
		...(now.load_errors ?? [])
	];
	const merged: Report = {
		...before,
		...now,
		cases: [...before.cases.filter((c) => !names.has(c.name)), ...now.cases]
	};
	if (load_errors.length > 0) merged.load_errors = load_errors;
	else delete merged.load_errors;
	writeFileSync(out, JSON.stringify(merged, null, '\t') + '\n');
	console.log(`appended to ${out}: ${merged.cases.length} cases in all`);
}

/** `--svelte client|server`: the output `.svelte` files compile to, for this command (loader/svelte.ts). */
function svelte_flag(value: string | undefined): SvelteOutput | undefined {
	if (value === undefined) return undefined;
	if (value !== 'client' && value !== 'server')
		throw new UsageError(`--svelte takes client or server, not ${JSON.stringify(value)}`);
	process.env[SVELTE_ENV] = value;
	return value;
}

/**
 * `--conditions svelte,browser`: the export conditions the code under test resolves packages with
 * (loader/conditions.ts), in this process and, through NODE_OPTIONS, in every process it starts.
 * Before `--import`, so a preload's own imports get them too. Client output adds `browser`, as a
 * browser bundle resolves: `svelte` is then Svelte's client runtime, where `mount` and `hydrate` work.
 */
function conditions(list: string | undefined, svelte: SvelteOutput | undefined): void {
	if (list !== undefined && parse_conditions(list).length === 0)
		throw new UsageError('--conditions takes names, like svelte,browser');
	const names = parse_conditions(
		[list ?? '', svelte === 'client' ? 'browser' : ''].filter(Boolean).join(',')
	);
	if (names.length === 0) return;
	process.env[CONDITIONS_ENV] = names.join(',');
	register_conditions(names);
	const file = own_file('loader/conditions');
	if (/\s/.test(file))
		throw new UsageError('--conditions: Heisenbench is installed at a path with a space');
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import=${file}`.trim();
}

/** `--root` must be a directory, and the directories `--out`, `--md` and `--json` write into must exist. */
function check_dirs(cmd: string, flags: Map<string, string>): void {
	for (const k of ['root', 'base-root']) {
		const d = flags.get(k);
		if (d !== undefined && !(existsSync(d) && statSync(d).isDirectory()))
			throw new UsageError(`--${k} ${d} is not a directory`);
	}
	for (const k of ['out', 'md', 'json', 'targets', 'repro']) {
		const f = flags.get(k);
		if (f === undefined) continue;
		const dir = dirname(resolve(f));
		if (!existsSync(dir)) throw new UsageError(`--${k} ${f}: no directory ${dir}`);
		if (existsSync(f) && statSync(f).isDirectory())
			throw new UsageError(`--${k} ${f} is a directory, not a file`);
	}
	for (const k of ['base', 'pr']) {
		if (cmd !== 'time') continue;
		const d = flags.get(k);
		if (d === undefined) throw new UsageError(`--${k} <dir> is required`);
		if (!(existsSync(d) && statSync(d).isDirectory()))
			throw new UsageError(`--${k} ${d} is not a directory`);
	}
	if ((cmd === 'diff' || cmd === 'blame') && flags.has('repo')) {
		const repo = flags.get('repo')!;
		if (!(existsSync(repo) && statSync(repo).isDirectory()))
			throw new UsageError(`--repo ${repo} is not a directory`);
	}
}

const ERROR_PREFIX = 'heisenbench: ';

/** Errors as Heisenbench prints them: one line, `heisenbench <cmd>: ...`; the stack only with --debug. */
function message_of(e: unknown): string {
	const m = one_line(e);
	return m.startsWith(ERROR_PREFIX) ? m.slice(ERROR_PREFIX.length) : m;
}

const argv = process.argv.slice(2);
const debug = argv.includes('--debug') || process.env.HEISENBENCH_DEBUG === '1';
const command = argv[0] !== undefined && argv[0] in SPECS ? argv[0] : null;
const prefix = command ? `heisenbench ${command}` : 'heisenbench';
let stray = 0;
// Code a bench file started and nobody awaited (a rejected promise, a throwing timer) is reported
// and the run goes on; the exit code says something went wrong.
const stray_error = (e: unknown): void => {
	stray++;
	console.error(
		`${prefix}: an error outside any case: ${debug && e instanceof Error ? e.stack : message_of(e)}`
	);
};
process.on('unhandledRejection', stray_error);
process.on('uncaughtException', stray_error);
exit_on_signals();

let code: number;
try {
	code = await main(argv);
} catch (e) {
	if (e instanceof UsageError) {
		console.error(
			`${prefix}: ${e.message}\nRun \`heisenbench --help\` for every command and option.`
		);
		code = 2;
	} else {
		// Heisenbench's own errors say what to fix; anything else may need the stack.
		const own = one_line(e).startsWith('heisenbench');
		console.error(
			debug && e instanceof Error
				? (e.stack ?? e.message)
				: `${prefix}: ${message_of(e)}${own ? '' : ' (--debug shows where)'}`
		);
		code = 1;
	}
}
if (stray > 0 && code === 0) code = 1;
// Wait for the output to drain, then exit: a timer or socket a bench left open must not keep
// the process alive after its work is written.
await new Promise<void>((r) => process.stdout.write('', () => r()));
await new Promise<void>((r) => process.stderr.write('', () => r()));
process.exit(code);
