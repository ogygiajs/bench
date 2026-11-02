#!/usr/bin/env node
// Build the framework apps for the benchmark: generate posts, sync the shared Counter/posts into
// each blog app, then each scenario's data and shared UI into its apps; install every app on its
// own and build it (timed, with its client output measured).
//
//   node build-all.ts                                   # every framework, ogygia@latest
//   node build-all.ts --fast                            # only the apps marked `fast` in the config
//   node build-all.ts --no-blog --scenarios docs        # one scenario's apps only
//   OGYGIA_SPEC=0.11.4 node build-all.ts                # an npm version or dist-tag
//   OGYGIA_SPEC=https://pkg.pr.new/ogygia@<sha7> node build-all.ts   # one commit's preview build
//
// `--spec <s>` is the same as OGYGIA_SPEC. The spec is the ONE input that changes between runs;
// every other framework keeps the exact pins in its own package.json.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ENV } from './harness/serve.ts';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OGYGIA_APP = join(ROOT, 'frameworks', 'ogygia');
// The packages the ogygia app imports (`ogygia`, `@ogygia/content`) plus the core both of them
// depend on. All three move together so the app never mixes builds.
const OGYGIA_PACKAGES = ['ogygia', '@ogygia/core', '@ogygia/content'];

function parseArgs(argv) {
	const args = {
		fast: process.env.BENCH_FAST === '1',
		spec: process.env.OGYGIA_SPEC || 'latest',
		scenarios: process.env.BENCH_SCENARIOS || 'all',
		blog: true
	};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--fast') args.fast = true;
		else if (argv[i] === '--full') args.fast = false;
		else if (argv[i] === '--spec') args.spec = argv[++i];
		else if (argv[i] === '--scenarios') args.scenarios = argv[++i];
		else if (argv[i] === '--no-blog') args.blog = false;
	}
	// `all` (default), `none`, or a comma list. The blog apps in frameworks/ build unless --no-blog.
	args.scenarios =
		args.scenarios === 'none' ? [] : args.scenarios === 'all' ? null : args.scenarios.split(',');
	return args;
}

const run = (cmd, args, opts = {}) => {
	const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
};

const npmView = (what, fields) => {
	const r = spawnSync('npm', ['view', what, ...fields, '--json'], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`npm view ${what} failed:\n${r.stderr}`);
	return JSON.parse(r.stdout || 'null');
};

// pkg.pr.new serves every package of one publish at `<base><name>@<ref>`, where <base> is
// `https://pkg.pr.new/` (or `https://pkg.pr.new/<owner>/<repo>/`) and <ref> is a short sha or a PR
// number. Its rewritten package.json files point the inter-package deps at the same ref, so taking
// all three from one ref gives one consistent build.
const PKG_PR_NEW = /^(https:\/\/pkg\.pr\.new\/(?:[^/@]+\/[^/@]+\/)?)ogygia@([^/?#]+)$/;

/** Turn the spec into one install specifier per ogygia package. */
function resolveOgygia(spec) {
	const preview = PKG_PR_NEW.exec(spec);
	if (preview) {
		const [, base, ref] = preview;
		return Object.fromEntries(OGYGIA_PACKAGES.map((name) => [name, `${base}${name}@${ref}`]));
	}
	if (/^[a-z]+:/i.test(spec)) throw new Error(`unsupported OGYGIA_SPEC: ${spec}`);

	// npm: the three packages version independently, so a spec names `ogygia`'s version and the
	// others follow from it. Core is whatever that ogygia depends on. Content is the same dist-tag
	// when it has one, else the newest stable content that was out when that ogygia was published.
	let view = npmView(`ogygia@${spec}`, ['version', 'dependencies']);
	if (Array.isArray(view)) view = view.at(-1);
	if (!view) throw new Error(`no ogygia version matches ${spec}`);
	const core = view.dependencies?.['@ogygia/core'];
	if (!core) throw new Error(`ogygia@${view.version} has no @ogygia/core dependency`);

	let content = process.env.OGYGIA_CONTENT_SPEC;
	if (!content) {
		const tags = npmView('@ogygia/content', ['dist-tags']) ?? {};
		if (tags[spec]) content = tags[spec];
		else {
			const published = npmView('ogygia', ['time'])[view.version];
			const times = npmView('@ogygia/content', ['time']);
			content = Object.entries(times)
				.filter(([v, t]) => /^\d+\.\d+\.\d+$/.test(v) && t <= published)
				.sort((a, b) => a[1].localeCompare(b[1]))
				.at(-1)?.[0];
			if (!content) throw new Error(`no @ogygia/content release predates ogygia@${view.version}`);
		}
	}
	return { ogygia: view.version, '@ogygia/core': core, '@ogygia/content': content };
}

// pnpm exits non-zero on unapproved native build scripts (esbuild/workerd) and refuses to purge a
// stale node_modules without a TTY — neither of which actually breaks the install. Run it CI-mode and
// verify by PRESENCE (node_modules/.modules.yaml) rather than exit code. `own_workspace`: the app has
// its own pnpm-workspace.yaml (the ogygia app's overrides), which `--ignore-workspace` would skip; it
// is the nearest one, so the install still never reaches a parent workspace.
const pnpmInstall = (cwd, env, own_workspace = false) => {
	// The marker of an EARLIER install would pass the presence check even when this one fails, and
	// the run would quietly measure the previous ogygia build. pnpm 11 also skips an install it
	// thinks is "already up to date" from its state file without rewriting the marker, so both go.
	// A leftover lockfile is never wanted either: pnpm re-verifies it against the release-age
	// policy and fails on the old entries.
	rmSync(join(cwd, 'node_modules', '.modules.yaml'), { force: true });
	rmSync(join(cwd, 'node_modules', '.pnpm-workspace-state-v1.json'), { force: true });
	rmSync(join(cwd, 'pnpm-lock.yaml'), { force: true });
	spawnSync(
		'pnpm',
		[
			'install',
			...(own_workspace ? [] : ['--ignore-workspace']),
			'--no-lockfile',
			'--config.confirmModulesPurge=false'
		],
		{
			stdio: 'inherit',
			cwd,
			env: { ...env, CI: '1' }
		}
	);
	if (!existsSync(join(cwd, 'node_modules', '.modules.yaml')))
		throw new Error(`pnpm install produced no node_modules in ${cwd}`);
};

function installAndBuild(fw) {
	const cwd = join(ROOT, 'frameworks', fw.id);
	console.log(`\n▸ ${fw.id}`);
	run('node', [join(ROOT, 'shared', 'sync.ts'), fw.id]);
	installAndBuildIn(cwd, fw.install, fw.out ?? (fw.install === 'bun' ? null : 'build'));
}

/** Bytes of every file under `dir`, leaving out paths (relative to `dir`) in `skip`. */
function dirBytes(dir, skip = new Set(), rel = '') {
	let total = 0;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const r = rel ? `${rel}/${e.name}` : e.name;
		if (skip.has(r)) continue;
		const p = join(dir, e.name);
		total += e.isDirectory() ? dirBytes(p, skip, r) : e.isFile() ? statSync(p).size : 0;
	}
	return total;
}

/** Every file path under `dir`, relative to it. */
function listFiles(dir, rel = '', out = new Set()) {
	if (!existsSync(dir)) return out;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const r = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) listFiles(join(dir, e.name), r, out);
		else out.add(r);
	}
	return out;
}

/**
 * Install an app on its own and build it. The `build` command is timed, and the app's client
 * output is measured, into `.bench-build.json` for benchmark.ts. `out` is the build output
 * (removed before the build), `client` the parts of it a browser can fetch (default: all of
 * `out`). Files the build copied from the app's public dir are left out of the size: they are the
 * scenario's shared static files, the same for every app.
 */
function installAndBuildIn(cwd, install, out, client = out ? [out] : [], publicDir = null) {
	const env = { ...process.env, ...APP_ENV, ASTRO_TELEMETRY_DISABLED: '1' };
	rmSync(join(cwd, '.bench-build.json'), { force: true });
	if (out) rmSync(join(cwd, out), { recursive: true, force: true });
	let t0;
	if (install === 'bun') {
		run('bun', ['install'], { cwd, env });
		t0 = performance.now();
		run('bun', ['run', 'build'], { cwd, env });
	} else {
		pnpmInstall(cwd, env, existsSync(join(cwd, 'pnpm-workspace.yaml')));
		t0 = performance.now();
		// pnpm 11 re-checks deps before `run` and would install again, this time with a lockfile.
		run('pnpm', ['--config.verify-deps-before-run=false', 'run', 'build'], { cwd, env });
	}
	const buildMs = Math.round(performance.now() - t0);
	const shared = publicDir ? listFiles(join(cwd, publicDir)) : new Set();
	const dirs = client.filter((d) => existsSync(join(cwd, d)));
	const outBytes = dirs.length ? dirs.reduce((s, d) => s + dirBytes(join(cwd, d), shared), 0) : null;
	writeFileSync(join(cwd, '.bench-build.json'), JSON.stringify({ buildMs, outBytes }) + '\n');
	console.log(`  build ${(buildMs / 1000).toFixed(1)} s${outBytes ? `, client output ${(outBytes / 1024).toFixed(0)} KB` : ''}`);
}

/**
 * The ogygia apps ask for `latest`; overrides in each one's own (gitignored) workspace file swap
 * every copy of the three packages, direct or nested, for the resolved ones. That also collapses
 * content's `@ogygia/core` peer onto the same core ogygia uses.
 * `minimumReleaseAge: 0`: pnpm 11 refuses packages younger than a day by default, and a run right
 * after a release (the weekly `latest` run, a manual one) wants exactly that release.
 * `blockExoticSubdeps: false`: a pkg.pr.new `ogygia` depends on its core by URL, which pnpm 11
 * blocks in subdependencies by default. These URLs are the ones this script chose.
 */
function pinOgygia(appDir, packages, spec) {
	const yaml = Object.entries(packages)
		.map(([name, at]) => `  '${name}': '${at}'`)
		.join('\n');
	writeFileSync(
		join(appDir, 'pnpm-workspace.yaml'),
		`minimumReleaseAge: 0\nblockExoticSubdeps: false\noverrides:\n${yaml}\n`
	);
	// benchmark.ts reads this back for the result's `meta` block.
	writeFileSync(join(appDir, '.ogygia-spec.json'), JSON.stringify({ spec, packages }, null, '\t') + '\n');
}

const args = parseArgs(process.argv.slice(2));
const cfg = JSON.parse(readFileSync(join(ROOT, 'frameworks.config.json'), 'utf8'));
const frameworks = args.blog ? cfg.frameworks.filter((fw) => !args.fast || fw.fast) : [];
const scenarioNames = Object.keys(cfg.scenarios ?? {}).filter(
	(name) => !args.scenarios || args.scenarios.includes(name)
);
const scenarioApps = scenarioNames.flatMap((name) =>
	cfg.scenarios[name].apps
		.filter((app) => !args.fast || app.fast)
		.map((app) => ({ ...app, scenario: name }))
);

if (frameworks.length) {
	console.log('▸ generate posts');
	run('node', [join(ROOT, 'generate-posts.ts')]);
}

let packages = null;
if ([...frameworks, ...scenarioApps].some((fw) => fw.id === 'ogygia')) {
	console.log(`\n▸ resolve ogygia (${args.spec})`);
	packages = resolveOgygia(args.spec);
	for (const [name, at] of Object.entries(packages)) console.log(`  ${name} → ${at}`);
	pinOgygia(OGYGIA_APP, packages, args.spec);
}

for (const fw of frameworks) installAndBuild(fw);

// Scenario apps: generate the scenario's data once, copy its shared UI into each app, build. A
// scenario app that fails to build is reported and left out; the benchmark skips unbuilt apps.
const failed = [];
for (const name of scenarioNames) {
	const apps = scenarioApps.filter((a) => a.scenario === name);
	if (!apps.length) continue;
	const generator = join(ROOT, 'scenarios', name, 'generate.ts');
	if (existsSync(generator)) {
		console.log(`\n▸ ${name}: generate data`);
		run('node', [generator]);
	}
	for (const app of apps) {
		const cwd = join(ROOT, app.dir);
		console.log(`\n▸ ${name}/${app.id}`);
		try {
			run('node', [
				join(ROOT, 'scenarios', 'sync.ts'),
				name,
				app.dir,
				app.shared ?? 'src/lib/shared',
				app.public ?? 'public'
			]);
			if (app.id === 'ogygia') pinOgygia(cwd, packages, args.spec);
			installAndBuildIn(cwd, app.install, app.out, app.client ?? [app.out], app.public ?? 'public');
		} catch (e) {
			failed.push(`${name}/${app.id}`);
			console.log(`::warning title=build failed::${name}/${app.id}: ${e.message}`);
		}
	}
}

const built = [
	...frameworks.map((fw) => fw.id),
	...scenarioApps.map((a) => `${a.scenario}/${a.id}`).filter((id) => !failed.includes(id))
];
console.log(`\n✓ built ${built.join(', ')}${failed.length ? `\n✗ failed ${failed.join(', ')}` : ''}`);
