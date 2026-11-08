import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { findPackageJSON } from 'node:module';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load_records } from '../coverage/recorder.ts';
import type { Sample } from '../coverage/recorder.ts';
import { diff_reports } from '../diff/index.ts';
import { input_size } from '../growth/scale.ts';
import { package_of } from '../identity.ts';
import { own_file, own_url } from '../own.ts';
import { CONDITIONS_ENV } from '../loader/conditions-env.ts';
import { ProcessError, run_process } from '../proc.ts';
import { one_line } from '../report.ts';
import type { Report } from '../report.ts';
import { remove_tree } from '../blame/tree.ts';
import type { Bump, UpgradeCase, UpgradeFunction, UpgradeResult } from '../upgrade/index.ts';
import { main_function } from '../upgrade/markdown.ts';
import { package_diffs, package_lines } from '../upgrade/packages.ts';
import { import_specifier } from './entry.ts';
import { count_bench, install_line, repro_script } from './repro.ts';
import type { ReproSpec } from './repro.ts';
import { NoSource, to_source } from './source.ts';

/*
 * An issue for the maintainers of an upgraded package (spec: drafted upstream reports), from what
 * `heisenbench upgrade` found. It is written to files and never posted.
 *
 * A maintainer needs to see it happen on their own machine, without the project it was found in:
 *
 * 1. **The call.** The package's function the project called (the entry the upgrade found, or
 *    `--entry`), imported the way a stranger would (its public `exports` specifier).
 * 2. **The input.** The arguments the project's case passed to it, recorded by running that case
 *    once with the recorder on that one function (coverage/recorder.ts), the largest argument grown
 *    n times by repetition; or `--input`, a generator file. Paths into the project become
 *    `/repro/<file>`.
 * 3. **The script.** A standalone `repro.ts` that times the call at each size on whatever version
 *    is installed. It is run here on both versions (each linked into a scratch directory as
 *    `node_modules/<name>`), first to keep only the sizes both run, then for the numbers.
 * 4. **The counts.** The same calls counted by Heisenbench on both versions, diffed with the
 *    package's own diff: the function's steps and the lines that changed, measured on the
 *    script's input, not the project's. A draft whose input does not reach the changed code is
 *    refused: the script would show nothing.
 * 5. **No project names.** Words that name the project (its package names and scopes, its git
 *    remote, `--redact`) must not appear anywhere in the draft; a draft that has one is refused.
 */

export interface DraftOptions {
	upgrade: UpgradeResult;
	/** The case (a part of its name); default the case the upgrade slowed most. */
	case?: string;
	/** The function (a part of `module > path`); default the one with most of the case's change. */
	function?: string;
	/** `specifier#export` to call, in place of the entry the upgrade found. */
	entry?: string;
	/** A generator module (`export function input(n) { return [...args] }`, optional `export const sizes`). */
	input?: string;
	redact?: readonly string[];
	/** How long the script times each size (default 1000 ms). */
	time_ms?: number;
	work?: string;
	node_args?: readonly string[];
	env?: NodeJS.ProcessEnv;
	log?: (line: string) => void;
}

export interface Timing {
	n: number;
	old_ms: number;
	new_ms: number;
	old_runs: number;
	new_runs: number;
}

export interface CountRow {
	n: number;
	/** The whole call. */
	old_total: number;
	new_total: number;
	/** The function's own steps. */
	old_self: number;
	new_self: number;
	old_calls: number;
	new_calls: number;
}

export interface Draft {
	title: string;
	/** The issue, markdown. */
	issue: string;
	/** The reproduction script. */
	repro: string;
	package: { name: string; from: string; to: string };
	function: { module: string; path: string; file: string; line: number };
	/** The export called (a null specifier: the generator's own `call`). */
	entry: { specifier: string | null; export_name: string };
	sizes: number[];
	timings: Timing[];
	counts: CountRow[];
	lines: Array<{ line: number; delta_steps: number; upstream: boolean }>;
	machine: string;
}

const DEFAULT_SIZES = [1, 4, 16];
/** Turns each version gets at the timing. */
const TIME_ROUNDS = 3;
/** Share of the call's extra steps the reported function must hold on the script's input. */
const MIN_SHARE = 0.5;
/** A time change smaller than this is within what one machine's runs move by. */
const TIME_NOISE = 0.03;
/** Recorded arguments larger than this as source are refused (give a generator). */
const MAX_INPUT_CHARS = 64 * 1024;
/** Lines of the upstream diff shown. */
const MAX_DIFF_LINES = 60;
/** Added lines above the function (its doc comment) the diff reaches up over. */
const MAX_LEAD = 12;
/** Words too common to name a project. */
const STOP = new Set([
	'app',
	'apps',
	'core',
	'lib',
	'libs',
	'web',
	'site',
	'docs',
	'internal',
	'packages',
	'package',
	'utils',
	'util',
	'common',
	'shared',
	'server',
	'client',
	'test',
	'tests',
	'bench',
	'monorepo',
	'workspace',
	'root',
	'main',
	'private',
	'node',
	'plugin',
	'example',
	'examples',
	'demo',
	'types',
	'tools',
	'config',
	'github',
	'gitlab',
	'com',
	'org',
	'www',
	'http',
	'https',
	'git'
]);

function fail(msg: string): never {
	throw new Error(`heisenbench: ${msg}`);
}

/** The case and function to report. */
export function pick_finding(
	r: UpgradeResult,
	o: { case?: string; function?: string }
): { c: UpgradeCase; f: UpgradeFunction; bump: Bump } {
	const cases = r.cases
		.filter((c) => c.delta > 0 && (!o.case || c.case.includes(o.case)))
		.sort((a, b) => b.delta - a.delta);
	if (cases.length === 0)
		fail(
			o.case ? `no slower case matches ${JSON.stringify(o.case)}` : 'no upgrade made a case slower'
		);
	for (const c of cases) {
		const f = o.function
			? c.functions.find(
					(x) => x.package !== 'own code' && `${x.module} > ${x.function}`.includes(o.function!)
				)
			: main_function(c);
		if (!f) continue;
		const name = package_of(f.module)!.name;
		const bump = r.bumps.find((b) => b.name === name);
		if (bump) return { c, f, bump };
	}
	fail(
		o.function
			? `no upgraded package's function matches ${JSON.stringify(o.function)}`
			: 'no function of an upgraded package carries the change'
	);
}

/** The words that name the project: its package names and scopes, its git remote. */
export function project_words(
	root: string,
	modules: readonly string[],
	dep: string,
	extra: readonly string[] = []
): string[] {
	const names = new Set<string>();
	const dirs = new Set<string>(['']);
	for (const m of modules) {
		let d = dirname(m);
		while (d !== '.' && d !== '' && d !== '/') {
			dirs.add(d);
			d = dirname(d);
		}
	}
	for (const d of dirs) {
		try {
			const n = (
				JSON.parse(readFileSync(join(root, d, 'package.json'), 'utf8')) as { name?: unknown }
			).name;
			if (typeof n === 'string') names.add(n);
		} catch {
			// no manifest here
		}
	}
	const words = new Set<string>();
	for (const n of names) {
		const scoped = /^@([^/]+)\//.exec(n);
		if (scoped) words.add(scoped[1]);
		else words.add(n.split(/[-_.]/)[0]);
	}
	try {
		const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
			cwd: root,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
		const m = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
		if (m) {
			words.add(m[1]);
			words.add(m[2]);
		}
	} catch {
		// not a git checkout, or no remote
	}
	const own = new Set(dep.toLowerCase().split(/[^a-z0-9]+/));
	return [
		...new Set(
			[...words, ...extra]
				.map((w) => w.toLowerCase().replace(/^@/, ''))
				.filter((w) => w.length >= 4 && !STOP.has(w) && !own.has(w))
		)
	].sort();
}

/** The first word of `words` in `text`, or null. */
export function named_in(text: string, words: readonly string[]): string | null {
	const t = text.toLowerCase();
	return words.find((w) => t.includes(w)) ?? null;
}

/** The project's arguments as the source of `input(n)`: the largest one repeated n times. */
export function input_source(
	sample: Sample,
	o: { roots: readonly string[]; call: string }
): { source: string; grows: boolean } {
	// a path into the checkout says where the project lives: only its file name is kept
	const scrub = (v: unknown): unknown => {
		if (typeof v === 'string') {
			for (const r of o.roots)
				if (v.startsWith(r + sep) || v === r) return `/repro/${v.split(sep).at(-1)}`;
			return v;
		}
		if (Array.isArray(v)) return v.map(scrub);
		if (v instanceof Map) return new Map([...v].map(([a, b]) => [scrub(a), scrub(b)]));
		if (v instanceof Set) return new Set([...v].map(scrub));
		if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype)
			return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
		return v;
	};
	const args = sample.args.map(scrub);
	const sizes = args.map((a) => input_size(a));
	let big = -1;
	for (let i = 0; i < args.length; i++)
		if (
			(typeof args[i] === 'string' || Array.isArray(args[i])) &&
			(big === -1 || sizes[i] > sizes[big])
		)
			big = i;
	let srcs: string[];
	try {
		srcs = args.map((a) => to_source(a, '\t'));
	} catch (e) {
		if (e instanceof NoSource)
			fail(
				`the recorded arguments of ${o.call} hold ${e.message}, which a script cannot rebuild: give --input <generator.ts>`
			);
		throw e;
	}
	const lines = [
		big === -1
			? `/** The arguments of one call to \`${o.call}\`, as recorded (they do not grow with n). */`
			: `/** The arguments of one call to \`${o.call}\`, argument ${big + 1} repeated n times. */`,
		`function input(${big === -1 ? '_n' : 'n'}: number): unknown[] {`
	];
	if (big !== -1) {
		lines.push(`\tconst one = ${srcs[big]};`);
		srcs[big] =
			typeof args[big] === 'string'
				? 'one.repeat(n)'
				: 'Array.from({ length: n }, () => one).flat()';
	}
	if (srcs.join('').length > 60 || srcs.some((s) => s.includes('\n'))) {
		lines.push(
			'\treturn [',
			...srcs.map((s, i) => `\t\t${s}${i < srcs.length - 1 ? ',' : ''}`),
			'\t];'
		);
	} else {
		lines.push(`\treturn [${srcs.join(', ')}];`);
	}
	lines.push('}');
	return { source: lines.join('\n'), grows: big !== -1 };
}

/** `@scope/name/sub` -> `@scope/name`. */
function package_name(specifier: string): string {
	const parts = specifier.split('/');
	return parts.slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
}

/**
 * A generator file: `input(n)` (the arguments of one call), optionally `call(...args)` (the call
 * itself, when it is more than one export: a plugin, a parser built from two packages) and
 * `sizes`. It may import Node's built-ins, the package, and the packages the package itself
 * resolves (its dependencies and peers): nothing of the project.
 */
function generator_source(
	path: string,
	pkg: string
): { source: string; packages: string[]; call: boolean } {
	const src = readFileSync(path, 'utf8');
	const packages = new Set<string>();
	for (const m of src.matchAll(/^\s*import\s[^'"]*?['"]([^'"]+)['"]/gm)) {
		const s = m[1];
		if (s.startsWith('node:')) continue;
		if (s.startsWith('.') || s.startsWith('/') || s.startsWith('#'))
			fail(
				`--input ${path} imports ${s}: a reproduction script may import only packages, never the project's files`
			);
		const name = package_name(s);
		if (name !== pkg) packages.add(name);
	}
	if (!/\bfunction\s+input\s*\(|\binput\s*=/.test(src)) fail(`--input ${path} defines no input(n)`);
	return {
		source: src,
		packages: [...packages].sort(),
		call: /\bfunction\s+call\s*\(|\bconst\s+call\s*=/.test(src)
	};
}

/** The function's change between the two versions, as `git diff` shows it with 3 lines around. */
function function_diff(
	old_file: string,
	new_file: string,
	from: number,
	to: number
): string | null {
	const rel = (p: string) => realpathSync(p).split(sep).join('/').replace(/^\/+/, '');
	let out = '';
	try {
		out = execFileSync(
			'git',
			[
				'diff',
				'--no-index',
				'--no-color',
				'--no-ext-diff',
				'-U3',
				'--',
				rel(old_file),
				rel(new_file)
			],
			{ cwd: '/', encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }
		);
	} catch (e) {
		const err = e as { status?: number; stdout?: string };
		if (err.status !== 1 || typeof err.stdout !== 'string') return null;
		out = err.stdout;
	}
	const hunks: string[][] = [];
	for (const line of out.split('\n')) {
		if (line.startsWith('@@')) hunks.push([line]);
		else if (hunks.length > 0) hunks.at(-1)!.push(line);
	}
	// Each hunk cut to the function's lines and 3 around them (a hunk that added a whole module
	// holds much more than the function), reaching further up over the lines added with it (its
	// doc comment) up to MAX_LEAD, with its header counted again for what is left. A hunk with no
	// added or removed line inside the function is left out.
	const lo = from - 3;
	const hi = to + 3;
	const kept: string[] = [];
	for (const h of hunks) {
		const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(h[0]);
		if (!m) continue;
		const all: Array<{ l: string; old_at: number; new_at: number }> = [];
		let old_at = Number(m[1]);
		let new_at = Number(m[2]);
		for (const l of h.slice(1)) {
			if (l === '' || l.startsWith('\\')) continue;
			all.push({ l, old_at, new_at });
			if (l[0] !== '+') old_at++;
			if (l[0] !== '-') new_at++;
		}
		let first = all.findIndex((x) => x.new_at >= lo);
		if (first === -1) continue;
		const floor = Math.max(0, first - MAX_LEAD);
		const comment = (l: string) => l[0] === '+' && /^\s*(?:\/\/|\/\*|\*)/.test(l.slice(1));
		while (first > floor && comment(all[first - 1].l)) first--;
		const body: string[] = [];
		let start: [number, number] | null = null;
		const counts = [0, 0];
		let touches = false;
		for (const x of all.slice(first)) {
			if (x.new_at > hi) break;
			const kind = x.l[0];
			start ??= [x.old_at, x.new_at];
			body.push(x.l);
			if (kind !== '+') counts[0]++;
			if (kind !== '-') counts[1]++;
			if (kind !== ' ' && x.new_at >= from && x.new_at <= to) touches = true;
		}
		if (!touches || !start) continue;
		// as git writes it: a side with no lines starts at the line before
		const os = counts[0] === 0 ? start[0] - 1 : start[0];
		const ns = counts[1] === 0 ? start[1] - 1 : start[1];
		kept.push(`@@ -${os},${counts[0]} +${ns},${counts[1]} @@${m[3]}`, ...body);
	}
	if (kept.length === 0) return null;
	let lines = kept;
	// the hunk header's function context is the old file's text: kept, it is the package's own code
	if (lines.length > MAX_DIFF_LINES)
		lines = [...lines.slice(0, MAX_DIFF_LINES), `… ${lines.length - MAX_DIFF_LINES} more lines`];
	return lines.join('\n');
}

function fence(text: string, lang: string): string {
	const runs = text.match(/`+/g) ?? [];
	const f = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
	return `${f}${lang}\n${text}\n${f}`;
}

function n_steps(n: number): string {
	return Math.round(n).toLocaleString('en-US');
}

/** What the timings say next to the counts, when they do not show the change. */
function time_note(timings: readonly Timing[]): string[] {
	const moved = timings.map((t) => t.new_ms / t.old_ms - 1);
	if (moved.some((m) => m >= TIME_NOISE)) return [];
	return [
		moved.some((m) => m <= -TIME_NOISE)
			? 'These timings do not show the change; the counts below do. At these sizes the extra work is small next to what the call takes.'
			: `These timings move by less than ${Math.round(TIME_NOISE * 100)}%, within what runs on one machine vary by; the counts below show the change exactly.`,
		''
	];
}

function ms_text(ms: number): string {
	if (ms >= 100) return `${ms.toFixed(1)} ms`;
	if (ms >= 1) return `${ms.toFixed(2)} ms`;
	return `${(ms * 1000).toPrecision(3)} µs`;
}

function change(a: number, b: number): string {
	if (a === 0) return b === 0 ? '0' : 'new';
	const r = b / a;
	if (r >= 2) return `${r.toFixed(1)}×`;
	const p = (r - 1) * 100;
	return `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(1)}%`;
}

/**
 * A scratch project with `node_modules/<name>` linked to one installed version, and each of
 * `extra` linked to the copy that version resolves (its own dependency or peer). Returns the
 * directory and the extra packages' versions.
 */
function version_dir(
	work: string,
	name: string,
	version: string,
	pkg_dir: string,
	extra: readonly string[]
): { dir: string; versions: Map<string, string> } {
	const dir = join(work, `v-${version}`);
	remove_tree(dir);
	const link = (n: string, to: string) => {
		mkdirSync(join(dir, 'node_modules', ...n.split('/').slice(0, -1)), { recursive: true });
		symlinkSync(to, join(dir, 'node_modules', ...n.split('/')), 'dir');
	};
	link(name, pkg_dir);
	const versions = new Map<string, string>();
	for (const e of extra) {
		const found = findPackageJSON(e, pathToFileURL(join(pkg_dir, 'package.json')).href);
		if (!found) fail(`the input imports ${e}, which ${name}@${version} does not resolve`);
		const at = realpathSync(dirname(found));
		link(e, at);
		const v = (JSON.parse(readFileSync(join(at, 'package.json'), 'utf8')) as { version?: string })
			.version;
		versions.set(e, v ?? 'latest');
	}
	writeFileSync(
		join(dir, 'package.json'),
		JSON.stringify({ private: true, type: 'module' }) + '\n'
	);
	return { dir, versions };
}

/** The environment a reproduction runs in: the project's preloads and flags left out. */
function plain_env(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out = { ...env };
	delete out.NODE_OPTIONS;
	delete out[CONDITIONS_ENV];
	return out;
}

async function run_script(
	dir: string,
	script: string,
	time_ms: number,
	env: NodeJS.ProcessEnv
): Promise<Map<number, { ms: number; runs: number } | { error: string }>> {
	writeFileSync(join(dir, 'repro.ts'), script);
	let stdout: string;
	try {
		stdout = (
			await run_process(process.execPath, ['--no-warnings', 'repro.ts'], {
				cwd: dir,
				env: { ...plain_env(env), REPRO_TIME_MS: String(time_ms) },
				timeout_ms: 10 * 60_000
			})
		).stdout;
	} catch (e) {
		const tail =
			e instanceof ProcessError
				? (e.stderr || e.stdout).trim().split('\n').slice(-2).join(' ')
				: '';
		fail(`the reproduction script does not run: ${one_line(e)}${tail ? `: ${tail}` : ''}`);
	}
	const out = new Map<number, { ms: number; runs: number } | { error: string }>();
	for (const line of stdout.split('\n')) {
		const ok = /n=(\d+)\s+median ([\d.e+-]+) ms\s+\((\d+) runs\)/.exec(line);
		if (ok) out.set(Number(ok[1]), { ms: Number(ok[2]), runs: Number(ok[3]) });
		const bad = /^n=(\d+) failed: (.*)$/.exec(line);
		if (bad) out.set(Number(bad[1]), { error: bad[2] });
	}
	return out;
}

async function count_script(dir: string, bench: string, env: NodeJS.ProcessEnv): Promise<Report> {
	writeFileSync(join(dir, 'count.bench.ts'), bench);
	const out = join(dir, 'count.json');
	try {
		await run_process(
			process.execPath,
			['--no-warnings', own_file('cli'), 'run', 'count.bench.ts', '--root', dir, '--out', out],
			{ cwd: dir, env: plain_env(env), timeout_ms: 10 * 60_000 }
		);
	} catch (e) {
		const tail =
			e instanceof ProcessError
				? (e.stderr || e.stdout).trim().split('\n').slice(-2).join(' ')
				: '';
		fail(`counting the reproduction failed: ${one_line(e)}${tail ? `: ${tail}` : ''}`);
	}
	return JSON.parse(readFileSync(out, 'utf8')) as Report;
}

/** The arguments the case passed to the entry, recorded in a child on the PR's checkout. */
async function record_input(
	r: UpgradeResult,
	c: UpgradeCase,
	pkg_dir: string,
	label: string,
	module: string,
	path: string,
	work: string,
	o: DraftOptions
): Promise<Sample> {
	const file = join(pkg_dir, ...module.slice(label.length + 1).split('/'));
	if (!existsSync(file)) fail(`${module} is not installed at ${pkg_dir}`);
	const job = join(work, 'record.job.json');
	const out = join(work, 'record.bin');
	writeFileSync(
		job,
		JSON.stringify({
			root: r.root,
			file: c.file,
			case: c.case,
			module: realpathSync(file),
			path,
			out
		})
	);
	try {
		await run_process(
			process.execPath,
			[...(o.node_args ?? process.execArgv), own_file('upstream/child'), job],
			{
				cwd: r.root,
				env: o.env ?? process.env,
				timeout_ms: 10 * 60_000
			}
		);
	} catch (e) {
		fail(`recording the input failed: ${one_line(e)}`);
	}
	const rec = load_records(out).find((x) => x.id.endsWith(` > ${path}`));
	const samples = (rec?.samples ?? []).filter((s) => !s.stand_ins && !s.threw);
	if (samples.length === 0)
		fail(
			rec && rec.uncloneable > 0
				? `the arguments of ${path} could not be recorded (not cloneable): give --input <generator.ts>`
				: `${c.case} never called ${module} > ${path}: give --entry and --input`
		);
	const size = (s: Sample) =>
		(s.sizes ?? s.args.map((a) => input_size(a))).reduce((x, y) => x + y, 0);
	return [...samples].sort((a, b) => size(b) - size(a))[0];
}

export async function draft_upstream(o: DraftOptions): Promise<Draft> {
	const log = o.log ?? (() => {});
	const r = o.upgrade;
	const { c, f, bump } = pick_finding(r, o);
	if (!bump.dirs.from || !bump.dirs.to)
		fail(
			`the installed files of ${bump.name} were not found: the upgrade could not compare its versions`
		);
	const label = `${bump.name}@${bump.to}`;
	const file = f.module.slice(label.length + 1);
	log(`upstream: ${bump.name} ${bump.from} → ${bump.to}, ${f.module} > ${f.function}`);

	// the call: --entry, the generator's own `call`, or the entry the upgrade found
	const gen = o.input ? generator_source(o.input, bump.name) : null;
	let specifier: string | null;
	let export_name: string;
	let entry_module: string | null = null;
	let entry_path: string | null = null;
	if (o.entry) {
		const at = o.entry.lastIndexOf('#');
		if (at <= 0) fail('--entry takes specifier#export (`svelte/compiler#compile`)');
		specifier = o.entry.slice(0, at);
		export_name = o.entry.slice(at + 1);
		if (package_name(specifier) !== bump.name)
			fail(`--entry ${o.entry} is not a part of ${bump.name}`);
	} else if (gen?.call) {
		specifier = null;
		export_name = 'call';
	} else {
		// the first entry a stranger can import: a named function the package exports
		const entries = c.entries[bump.name] ?? [];
		if (entries.length === 0)
			fail(`nothing outside ${bump.name} calls it in ${c.case}: give --entry`);
		let found: { e: (typeof entries)[number]; spec: string } | null = null;
		for (const e of entries) {
			if (!/^[A-Za-z_$][\w$]*$/.test(e.function)) continue;
			const spec = import_specifier(
				bump.dirs.to,
				bump.name,
				e.module.slice(label.length + 1),
				e.function
			);
			if (spec) {
				found = { e, spec };
				break;
			}
		}
		if (!found)
			fail(
				`${bump.name} exports none of the functions the case calls it by (${entries.map((e) => `${e.module} > ${e.function}`).join(', ')}): give --entry`
			);
		specifier = found.spec;
		export_name = found.e.function;
		entry_module = found.e.module;
		entry_path = found.e.function;
	}
	if (!/^[A-Za-z_$][\w$]*$/.test(export_name))
		fail(`--entry: ${export_name} is not an export name`);

	const own_work = o.work === undefined;
	const made = own_work ? mkdtempSync(join(tmpdir(), 'heisenbench-upstream-')) : resolve(o.work!);
	mkdirSync(made, { recursive: true });
	const work = realpathSync(made);
	try {
		// the input
		let input: string;
		let sizes = DEFAULT_SIZES;
		if (gen) {
			// the script defines its own sizes; the generator's are read off its source
			const declared = /^export\s+const\s+sizes\s*=\s*\[([\d\s,]+)\]\s*;?\s*$/m.exec(gen.source);
			if (declared) {
				const got = declared[1]
					.split(',')
					.map((x) => Number(x.trim()))
					.filter((x) => x > 0);
				if (got.length > 0) sizes = got;
			}
			input = gen.source
				.replace(/^export\s+const\s+sizes\s*=.*$/m, '')
				.replace(/^export\s+/gm, '')
				.replace(/\n{3,}/g, '\n\n');
		} else {
			if (!entry_module || !entry_path)
				fail('--entry needs --input (a generator of its arguments)');
			log(`upstream: recording the arguments of ${entry_path} in ${c.case}`);
			const sample = await record_input(
				r,
				c,
				bump.dirs.to,
				label,
				entry_module,
				entry_path,
				work,
				o
			);
			const got = input_source(sample, {
				roots: [r.root, r.base_root],
				call: `${export_name}`
			});
			input = got.source;
			if (!got.grows) sizes = [1];
		}
		if (input.length > MAX_INPUT_CHARS)
			fail(
				`the input is ${input.length} characters of source: give --input <generator.ts> that builds it`
			);

		const extra = gen?.packages ?? [];
		const old_v = version_dir(work, bump.name, bump.from, bump.dirs.from, extra);
		const new_v = version_dir(work, bump.name, bump.to, bump.dirs.to, extra);
		const old_dir = old_v.dir;
		const new_dir = new_v.dir;
		const spec: ReproSpec = {
			name: bump.name,
			from: bump.from,
			to: bump.to,
			specifier,
			export_name,
			input,
			sizes,
			// the versions the new side resolves (when the two differ, the old side's are in its line)
			extra: extra.map((e) => ({ name: e, version: new_v.versions.get(e)! })),
			function: f.function,
			file
		};
		for (const e of extra)
			if (old_v.versions.get(e) !== new_v.versions.get(e))
				fail(
					`${bump.name} ${bump.from} resolves ${e}@${old_v.versions.get(e)} and ${bump.to} resolves ${e}@${new_v.versions.get(e)}: the reproduction would compare both; give an input that does not import ${e}`
				);
		const env = o.env ?? process.env;

		// the sizes both versions run
		const probe_old = await run_script(old_dir, repro_script(spec, true), 1, env);
		const probe_new = await run_script(new_dir, repro_script(spec, true), 1, env);
		const runs = spec.sizes.filter((n) => {
			const a = probe_old.get(n);
			const b = probe_new.get(n);
			return a !== undefined && b !== undefined && !('error' in a) && !('error' in b);
		});
		if (runs.length === 0) {
			const first = [...probe_old.values(), ...probe_new.values()].find((x) => 'error' in x);
			fail(
				`the reproduction does not run on both versions${first && 'error' in first ? `: ${first.error}` : ''}: give --input`
			);
		}
		spec.sizes = runs;

		// the counts: the same calls, counted on both versions
		const bench_url = own_url('bench').href;
		log(`upstream: counting the reproduction on ${bump.from} and ${bump.to}`);
		const old_count = await count_script(old_dir, count_bench(spec, bench_url), env);
		const new_count = await count_script(new_dir, count_bench(spec, bench_url), env);
		const files = package_diffs(bump.dirs.from, bump.dirs.to, `${bump.name}@${bump.from}`, label);
		const d = diff_reports(old_count, new_count, { files });
		const counts: CountRow[] = [];
		let lines: Draft['lines'] = [];
		for (const n of spec.sizes) {
			const name = `n=${n}`;
			const a = old_count.cases.find((x) => x.name === name);
			const b = new_count.cases.find((x) => x.name === name);
			if (!a || !b || a.error || b.error)
				fail(`the reproduction did not count at ${name}: ${a?.error ?? b?.error ?? 'missing'}`);
			const ch = d.changes.find(
				(x) => x.case === name && x.module === f.module && x.function === f.function
			);
			counts.push({
				n,
				old_total: a.totals.steps,
				new_total: b.totals.steps,
				old_self: ch?.base?.self_steps ?? 0,
				new_self:
					ch?.pr?.self_steps ??
					b.functions.find((x) => x.module === f.module && x.path === f.function)?.self_steps ??
					0,
				old_calls: ch?.base?.calls ?? 0,
				new_calls: ch?.pr?.calls ?? 0
			});
			if (n === spec.sizes.at(-1) && ch) {
				lines = [...ch.findings]
					.filter((x) => Math.abs(x.delta.steps) > 1e-6)
					.sort((x, y) => Math.abs(y.delta.steps) - Math.abs(x.delta.steps) || x.line - y.line)
					.slice(0, 4)
					.map((x) => ({
						line: x.line,
						delta_steps: x.delta.steps,
						upstream: x.kind === 'new code' || x.kind === 'new function'
					}));
			}
		}
		const largest = counts.at(-1)!;
		if (!(largest.new_self > largest.old_self))
			fail(
				`the reproduction's input does not reach the slower code: ${f.function} does ${n_steps(largest.old_self)} → ${n_steps(largest.new_self)} steps on it; give --input with an input that does`
			);
		// a function that got slower inside a call that got faster is no report: the version is better
		if (!(largest.new_total > largest.old_total))
			fail(
				`${f.function} does more work (${n_steps(largest.old_self)} → ${n_steps(largest.new_self)} steps), but the call as a whole does less (${n_steps(largest.old_total)} → ${n_steps(largest.new_total)}): nothing to report`
			);
		// the report says the extra work is in this function: on the script's input, most of it must be
		const added = largest.new_total - largest.old_total;
		const held = (largest.new_self - largest.old_self) / added;
		if (held < MIN_SHARE) {
			const top = d.changes
				.filter((x) => x.case === `n=${largest.n}` && x.delta.self_steps > 0)
				.sort((x, y) => y.delta.self_steps - x.delta.self_steps)[0];
			fail(
				`${f.function} holds ${Math.round(held * 100)}% of the call's extra ${n_steps(added)} steps on the script's input${top ? `; the most is in ${top.module} > ${top.function} (+${n_steps(top.delta.self_steps)}): --function '${top.function}'` : ''}`
			);
		}

		// the timings
		const time_ms = o.time_ms ?? 1000;
		log(`upstream: timing the reproduction on ${bump.from} and ${bump.to}`);
		const script = repro_script(spec);
		// the versions take turns, and each keeps its lower median: a slow moment of the machine
		// lands on one turn, not on one version
		const best = new Map<string, { ms: number; runs: number }>();
		for (let round = 0; round < TIME_ROUNDS; round++) {
			for (const [side, dir] of [
				['old', old_dir],
				['new', new_dir]
			] as const) {
				const t = await run_script(dir, script, time_ms, env);
				for (const n of spec.sizes) {
					const got = t.get(n);
					if (!got || 'error' in got) fail(`the reproduction did not time n=${n}`);
					const k = `${side} ${n}`;
					const was = best.get(k);
					if (!was || got.ms < was.ms) best.set(k, got);
				}
			}
		}
		const timings: Timing[] = spec.sizes.map((n) => {
			const a = best.get(`old ${n}`)!;
			const b = best.get(`new ${n}`)!;
			return { n, old_ms: a.ms, new_ms: b.ms, old_runs: a.runs, new_runs: b.runs };
		});

		const machine = `${cpus()[0]?.model?.trim() ?? 'unknown CPU'}, Node ${process.version.slice(1)}, ${process.platform}`;
		const draft = render_draft({
			spec,
			f,
			bump,
			file,
			counts,
			timings,
			lines,
			machine,
			script,
			entry_function: entry_path
		});
		const words = project_words(
			r.root,
			[...new Set(c.functions.map((x) => x.module).filter((m) => !package_of(m)))],
			bump.name,
			o.redact ?? []
		);
		const hit = named_in(draft.issue + '\n' + script, words);
		if (hit)
			fail(
				`the draft names the project (${JSON.stringify(hit)}): ${o.input ? 'change the generator' : 'give --input <generator.ts>'} so it does not, or pass --redact to check other words`
			);
		return {
			title: draft.title,
			issue: draft.issue,
			repro: script,
			package: { name: bump.name, from: bump.from, to: bump.to },
			function: { module: f.module, path: f.function, file, line: f.line },
			entry: { specifier, export_name },
			sizes: spec.sizes,
			timings,
			counts,
			lines,
			machine
		};
	} finally {
		if (own_work) remove_tree(work);
	}
}

function render_draft(x: {
	spec: ReproSpec;
	f: UpgradeFunction;
	bump: Bump;
	file: string;
	counts: CountRow[];
	timings: Timing[];
	lines: Draft['lines'];
	machine: string;
	script: string;
	entry_function: string | null;
}): { title: string; issue: string } {
	const { spec, f, bump, file, counts, timings, lines } = x;
	const big = counts.at(-1)!;
	const ratio = change(big.old_self, big.new_self);
	const whole = change(big.old_total, big.new_total);
	const held = (big.new_self - big.old_self) / (big.new_total - big.old_total);
	const more = (c: string) => (c.endsWith('×') ? `${c} as much` : `${c.replace(/^\+/, '')} more`);
	const as_than = (c: string) => (c.endsWith('×') ? 'as' : 'than');
	const call = spec.specifier ? `\`${spec.export_name}\`` : 'the call';
	const title =
		big.old_self === 0
			? `\`${f.function}\` (${file}), new in ${bump.to}, makes ${call} do ${more(whole)} work ${as_than(whole)} in ${bump.from}`
			: `\`${f.function}\` (${file}) does ${more(ratio)} work in ${bump.to} ${as_than(ratio)} in ${bump.from}`;
	const top = lines[0];
	const at = top ? ` at line ${top.line}` : '';
	// the gap widening with the input says the new code grows faster than the old
	const ratios = counts.filter((r) => r.old_self > 0).map((r) => r.new_self / r.old_self);
	const widens =
		ratios.length >= 2 &&
		ratios.every((v, i) => i === 0 || v > ratios[i - 1]) &&
		ratios.at(-1)! > 1.5 * ratios[0];
	const out: string[] = [
		`<!-- Drafted by heisenbench upstream draft. Nothing was posted. Review it before you file it. -->`,
		`# ${title}`,
		'',
		`Since ${bump.name} ${bump.to} (from ${bump.from}), ${spec.specifier ? `\`${spec.export_name}\` from \`${spec.specifier}\`` : 'the call below'} does ${more(whole)} work on the same input${as_than(whole) === 'as' ? ' as before' : ''}, and ${held >= 0.995 ? 'the extra work is' : `${Math.round(held * 100)}% of the extra work is`} in \`${f.function}\` (\`${file}\`)${at}.${
			widens
				? ` The gap grows with the input: ${counts
						.filter((r) => r.old_self > 0)
						.map((r) => `${change(r.old_self, r.new_self)} at n=${r.n}`)
						.join(', ')}.`
				: ''
		}`,
		'',
		'## Reproduction',
		'',
		fence(x.script.trimEnd(), 'ts'),
		'',
		fence(
			[
				`${install_line(spec, bump.from)} && node repro.ts`,
				`${install_line(spec, bump.to)} && node repro.ts`
			].join('\n'),
			'sh'
		),
		'',
		`Median time per call, the lowest of ${TIME_ROUNDS} runs of the script per version, taking turns (${x.machine}):`,
		'',
		`| n | ${bump.from} | ${bump.to} | Change |`,
		'| ---: | ---: | ---: | ---: |',
		...timings.map(
			(t) =>
				`| ${t.n} | ${ms_text(t.old_ms)} | ${ms_text(t.new_ms)} | ${change(t.old_ms, t.new_ms)} |`
		),
		'',
		...time_note(timings),
		'## Where',
		'',
		`Operation counts of the same calls, counted per line with [heisenbench](https://www.npmjs.com/package/heisenbench) (a count, not a timing: the same on every run):`,
		'',
		`| n | ${spec.specifier ? `\`${spec.export_name}\`` : 'One call'}, all it does | \`${f.function}\`, its own lines | Calls of \`${f.function}\` |`,
		'| ---: | ---: | ---: | ---: |',
		...counts.map(
			(r) =>
				`| ${r.n} | ${n_steps(r.old_total)} → ${n_steps(r.new_total)} (${change(r.old_total, r.new_total)}) | ${n_steps(r.old_self)} → ${n_steps(r.new_self)} (${change(r.old_self, r.new_self)}) | ${r.old_calls.toLocaleString('en-US')} → ${r.new_calls.toLocaleString('en-US')} |`
		)
	];
	if (lines.length > 0) {
		out.push(
			'',
			`At n=${big.n}, the lines of \`${f.function}\` whose count changed (${bump.to}):`,
			'',
			...lines.map(
				(l) =>
					`- line ${l.line}: ${l.delta_steps > 0 ? '+' : '−'}${n_steps(Math.abs(l.delta_steps))} steps${l.upstream ? ' (a line changed in this version)' : ''}`
			)
		);
	}
	if (top && bump.dirs.to) {
		const from = Math.max(1, top.line - 3);
		const code = package_lines(bump.dirs.to, file, from, top.line + 3);
		if (code) {
			const w = String(top.line + 3).length;
			out.push(
				'',
				`\`${file}\` in ${bump.to}, around line ${top.line}:`,
				'',
				fence(
					code
						.map(
							(l, i) => `${from + i === top.line ? '>' : ' '}${String(from + i).padStart(w)} | ${l}`
						)
						.join('\n'),
					'js'
				)
			);
		}
	}
	if (bump.dirs.from && bump.dirs.to) {
		const old_file = f.old_module
			? f.old_module.slice(`${bump.name}@${bump.from}`.length + 1)
			: file;
		const d = function_diff(
			join(bump.dirs.from, ...old_file.split('/')),
			join(bump.dirs.to, ...file.split('/')),
			f.line,
			f.end_line
		);
		if (d) {
			out.push(
				'',
				`What changed in \`${f.function}\` between ${bump.from} and ${bump.to}${old_file !== file ? ` (the file was \`${old_file}\`)` : ''}:`,
				'',
				fence(d, 'diff')
			);
		}
	}
	out.push(
		'',
		`Versions: ${bump.name} ${bump.from} and ${bump.to}, Node ${process.version.slice(1)}.`,
		''
	);
	return { title, issue: out.join('\n') };
}

/** Write the draft: the issue, and the script beside it. */
export function write_draft(d: Draft, out: string, repro: string): void {
	writeFileSync(out, d.issue);
	writeFileSync(repro, d.repro);
}
