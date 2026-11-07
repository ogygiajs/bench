#!/usr/bin/env node
import './warnings.ts';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
import { run_growth } from './growth/index.ts';
import { run_search } from './search/index.ts';
import { diff_sections, render_sections, write_section } from './sections.ts';
import { measure_command, measure_run, time_section } from './measure/cli.ts';
import { app_command, app_diff_sections } from './app/cli.ts';
import { VERIFY_LAYERS, render_verify, run_verify } from './verify/index.ts';
import { coverage_command } from './coverage/cli.ts';
import type { VerifyLayer } from './verify/index.ts';
import { needs_bench_repo } from './own.ts';

const HELP = `heisenbench: count the work a function does, per line, the same on every run.

Counting (the counting build)
  heisenbench run <bench files...>      count every case: steps, allocations, bytes, calls
      [--out heisenbench-report.json] [--root dir] [--filter text] [--deps all|a,b] [--sha sha]
      [--state fresh|shared] [--measure time,bytes,leaks|all] [--time-ms 300]
  heisenbench diff <base.json> <pr.json>   compare two reports: the markdown section
      [--repo dir] [--base sha] [--head sha] [--out section.md] [--json diff.json]
      [--time time.json] [--weights app-weights.json]
  heisenbench dts <source files...> --out heisenbench-private.d.ts [--tsconfig tsconfig.json]
                                 types for the private functions bench files import as __heisenbench

Layers (each writes its section into --out, default heisenbench-report.json)
  heisenbench health <bench files...>   V8 tiers, deopts and inline caches on the plain build
      [--warmup 20] [--runs 3] [--check on|off] [--root dir] [--filter text] [--out file]
  heisenbench growth <bench files...>   steps at 1x, 10x, 100x the input; the curve class
      [--sizes 1,10,100] [--scaled on|off] [--root dir] [--filter text] [--out file]
  heisenbench search <bench files...>   the input of the same size that costs the most steps
      [--evals 300] [--budget-steps 2e8] [--budget-ms 30000] [--seed 1] [--size-factor 1]
  heisenbench time <bench files...> --base dir --pr dir   both trees timed in one process, in turns
      [--repeats 5] [--time-ms 300] [--filter text] [--out heisenbench-time.json] [--md time.md]

Real apps and the measurement-source gate
  heisenbench weights <app-report.json...> [--out app-weights.json]
  heisenbench coverage <app-report.json...> --app <app dir,app dir...> [--packages ogygia,@ogygia/*]
      [--out coverage.json] [--md coverage.md]
  heisenbench inventory [files...] [--list files.txt] --root dir --out inventory.json
      [--reports a.json,b.json --targets targets.json]
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
  heisenbench verify [--layers steps,elision,leak,engine,growth,search,app,time] [--filter text]
      [--jobs n] [--md table.md] [--json rows.json]

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
}

const BENCH = ['root', 'filter', 'out', 'deps', 'sha'];
const MANY = Number.POSITIVE_INFINITY;

const SPECS: Record<string, Spec> = {
	run: {
		values: [...BENCH, 'state', 'measure', 'time-ms'],
		args: [1, MANY],
		files: true
	},
	diff: {
		values: ['repo', 'base', 'head', 'out', 'json', 'time', 'weights'],
		args: [2, 2],
		files: true
	},
	dts: { values: ['out', 'tsconfig'], args: [1, MANY], files: true },
	health: { values: [...BENCH, 'warmup', 'runs', 'check'], args: [1, MANY], files: true },
	growth: { values: [...BENCH, 'sizes', 'scaled'], args: [1, MANY], files: true },
	search: {
		values: [...BENCH, 'evals', 'budget-steps', 'budget-ms', 'seed', 'size-factor'],
		args: [1, MANY],
		files: true
	},
	time: {
		values: ['base', 'pr', 'repeats', 'time-ms', 'filter', 'out', 'md'],
		args: [1, MANY]
	},
	weights: { values: ['out'], args: [1, MANY], files: true },
	coverage: { values: ['app', 'packages', 'out', 'md'], args: [1, MANY], files: true },
	inventory: { values: ['list', 'root', 'out', 'reports', 'targets'], args: [0, MANY] },
	replay: { values: ['records', 'root', 'out'], args: [0, 0] },
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
			'shift'
		],
		args: [1, MANY],
		files: true
	},
	verify: { values: ['layers', 'filter', 'jobs', 'md', 'json'], args: [0, 0] }
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
	repeats: 'count',
	jobs: 'count',
	tolerance: 'positive',
	shift: 'positive'
};

const CHOICES: Record<string, readonly string[]> = {
	state: ['fresh', 'shared'],
	check: ['on', 'off'],
	scaled: ['on', 'off']
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
		if (SWITCHES.has(name)) {
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
		const files = cmd === 'calibrate' ? positional.slice(1) : positional;
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
	if (cmd === 'run') {
		const deps_flag = flags.get('deps');
		const deps =
			deps_flag === undefined ? false : deps_flag === 'all' ? true : deps_flag.split(',');
		const report = await run_benches({
			files: positional,
			root: flags.get('root'),
			out: flags.get('out') ?? 'heisenbench-report.json',
			deps,
			filter: flags.get('filter'),
			sha: flags.get('sha') ?? null,
			fresh: flags.get('state') !== 'shared',
			log: (l) => console.log(l)
		});
		await measure_run(report, positional, flags);
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
	const app = app_command(cmd, positional, flags);
	if (app !== null) return app;
	if (cmd === 'verify') return verify_command(flags);
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
		const sections = diff_sections(base, pr, files);
		const extra = render_sections(sections);
		const time = time_section(flags);
		const apps = app_diff_sections(result, base, pr, flags);
		const md =
			(apps ? apps + '\n' : '') +
			render_markdown(result) +
			(extra ? '\n' + extra : '') +
			(time ? '\n' + time : '');
		const out = flags.get('out');
		if (out) writeFileSync(out, md + '\n');
		else console.log(md);
		const json = flags.get('json');
		if (json) writeFileSync(json, JSON.stringify({ ...result, ...sections }, null, '\t') + '\n');
		return 0;
	}
	if (cmd === 'health' || cmd === 'growth' || cmd === 'search') {
		const root = flags.get('root') ?? process.cwd();
		const out = flags.get('out') ?? 'heisenbench-report.json';
		const deps_flag = flags.get('deps');
		const common = {
			files: positional,
			root,
			filter: flags.get('filter'),
			deps: deps_flag === undefined ? false : deps_flag === 'all' ? true : deps_flag.split(','),
			log: (l: string) => console.log(l)
		};
		const num = (k: string): number | undefined =>
			flags.has(k) ? Number(flags.get(k)) : undefined;
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
		if (cmd === 'growth') {
			const sizes = flags.get('sizes')?.split(',').map(Number);
			const r = await run_growth({ ...common, sizes, scaled: flags.get('scaled') === 'on' });
			write_section(out, 'growth', r, info);
			return r.cases.some((c) => c.error !== null) ? 1 : 0;
		}
		const r = await run_search({
			...common,
			evals: num('evals'),
			steps: num('budget-steps'),
			ms: num('budget-ms'),
			seed: num('seed'),
			size_factor: num('size-factor')
		});
		write_section(out, 'search', r, info);
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

/** `--root` must be a directory, and the directories `--out`, `--md` and `--json` write into must exist. */
function check_dirs(cmd: string, flags: Map<string, string>): void {
	const root = flags.get('root');
	if (root !== undefined && !(existsSync(root) && statSync(root).isDirectory()))
		throw new UsageError(`--root ${root} is not a directory`);
	for (const k of ['out', 'md', 'json', 'targets']) {
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
	if (cmd === 'diff' && flags.has('repo')) {
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
