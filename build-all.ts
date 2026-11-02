#!/usr/bin/env node
// Build the framework apps for the benchmark: generate posts, sync the shared Counter/posts into
// each app, install it on its own and build it.
//
//   node build-all.ts                                   # every framework, ogygia@latest
//   node build-all.ts --fast                            # only the apps marked `fast` in the config
//   OGYGIA_SPEC=0.11.4 node build-all.ts                # an npm version or dist-tag
//   OGYGIA_SPEC=https://pkg.pr.new/ogygia@<sha7> node build-all.ts   # one commit's preview build
//
// `--spec <s>` is the same as OGYGIA_SPEC. The spec is the ONE input that changes between runs;
// every other framework keeps the exact pins in its own package.json.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OGYGIA_APP = join(ROOT, 'frameworks', 'ogygia');
// The packages the ogygia app imports (`ogygia`, `@ogygia/content`) plus the core both of them
// depend on. All three move together so the app never mixes builds.
const OGYGIA_PACKAGES = ['ogygia', '@ogygia/core', '@ogygia/content'];

function parseArgs(argv) {
	const args = { fast: process.env.BENCH_FAST === '1', spec: process.env.OGYGIA_SPEC || 'latest' };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--fast') args.fast = true;
		else if (argv[i] === '--full') args.fast = false;
		else if (argv[i] === '--spec') args.spec = argv[++i];
	}
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
	const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' };
	if (fw.install === 'bun') {
		run('bun', ['install'], { cwd, env });
		run('bun', ['run', 'build'], { cwd, env });
	} else {
		pnpmInstall(cwd, env, existsSync(join(cwd, 'pnpm-workspace.yaml')));
		// pnpm 11 re-checks deps before `run` and would install again, this time with a lockfile.
		run('pnpm', ['--config.verify-deps-before-run=false', 'run', 'build'], { cwd, env });
	}
}

const args = parseArgs(process.argv.slice(2));
const cfg = JSON.parse(readFileSync(join(ROOT, 'frameworks.config.json'), 'utf8'));
const frameworks = cfg.frameworks.filter((fw) => !args.fast || fw.fast);

console.log('▸ generate posts');
run('node', [join(ROOT, 'generate-posts.ts')]);

if (frameworks.some((fw) => fw.id === 'ogygia')) {
	console.log(`\n▸ resolve ogygia (${args.spec})`);
	const packages = resolveOgygia(args.spec);
	for (const [name, at] of Object.entries(packages)) console.log(`  ${name} → ${at}`);
	// The app's package.json asks for `latest`; overrides in its own (gitignored) workspace file
	// swap every copy of the three packages, direct or nested, for the resolved ones. That also
	// collapses content's `@ogygia/core` peer onto the same core ogygia uses.
	// `minimumReleaseAge: 0`: pnpm 11 refuses packages younger than a day by default, and a run
	// right after a release (the weekly `latest` run, a manual one) wants exactly that release.
	// `blockExoticSubdeps: false`: a pkg.pr.new `ogygia` depends on its core by URL, which pnpm 11
	// blocks in subdependencies by default. These URLs are the ones this script chose.
	const yaml = Object.entries(packages)
		.map(([name, at]) => `  '${name}': '${at}'`)
		.join('\n');
	writeFileSync(
		join(OGYGIA_APP, 'pnpm-workspace.yaml'),
		`minimumReleaseAge: 0\nblockExoticSubdeps: false\noverrides:\n${yaml}\n`
	);
	// benchmark.ts reads this back for the result's `meta` block.
	writeFileSync(
		join(OGYGIA_APP, '.ogygia-spec.json'),
		JSON.stringify({ spec: args.spec, packages }, null, '\t') + '\n'
	);
}

for (const fw of frameworks) installAndBuild(fw);

console.log(`\n✓ built ${frameworks.map((fw) => fw.id).join(', ')}`);
