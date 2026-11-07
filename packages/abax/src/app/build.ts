import { spawn } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { CountedPluginOptions } from './vite.ts';
import { own_file } from '../own.ts';

/*
 * A counted build of an installed app (spec 8): a copy of the app's sources next to a link to its
 * node_modules, built with the app's own Vite config plus the counting plugins (vite.ts). The app
 * itself is not touched: its normal build stays what the app benchmark measures.
 */

const VITE_PLUGINS = own_file('app/vite');

/** What a copy leaves out: installs, build output, files a build writes. */
const NOT_COPIED = new Set([
	'node_modules',
	'build',
	'dist',
	'.svelte-kit',
	'.bench-build.json',
	'pnpm-lock.yaml'
]);

export const COUNTED_CONFIG = 'vite.abax.config.ts';

export interface CountedBuildOptions extends Omit<CountedPluginOptions, 'root'> {
	/** The installed app (has node_modules and a vite.config.ts). */
	app_dir: string;
	/** Where the copy is made and built (emptied first). */
	work_dir: string;
	log?: (line: string) => void;
	/** Environment of the build (a prerendered page signs with the secret it is built with). */
	env?: Record<string, string>;
}

export interface CountedBuild {
	dir: string;
	/** `.svelte-kit/output/server` of the build. */
	server_dir: string;
	/** Static files, in the order a server looks them up. */
	static_dirs: string[];
	ms: number;
}

function config_file(app_dir: string): string {
	for (const f of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
		if (existsSync(join(app_dir, f))) return f;
	}
	throw new Error(`abax: no vite.config in ${app_dir}`);
}

/** The wrapper config: the app's config with the counting plugins appended. */
export function counted_config_source(app_config: string, o: CountedPluginOptions): string {
	return (
		`import app from './${app_config}';\n` +
		`import { counted_plugins } from ${JSON.stringify(VITE_PLUGINS)};\n` +
		`const extra = counted_plugins(${JSON.stringify(o)});\n` +
		`export default async (env) => {\n` +
		`\tconst c = typeof app === 'function' ? await app(env) : app;\n` +
		`\treturn { ...c, plugins: [...(c.plugins ?? []), ...extra] };\n` +
		`};\n`
	);
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolve_, reject) => {
		const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
		let log = '';
		child.stdout.on('data', (d) => (log += d));
		child.stderr.on('data', (d) => (log += d));
		child.on('error', reject);
		child.on('exit', (code) =>
			code === 0
				? resolve_(log)
				: reject(new Error(`${cmd} ${args.join(' ')} failed (${code}):\n${log.slice(-6000)}`))
		);
	});
}

export async function counted_build(o: CountedBuildOptions): Promise<CountedBuild> {
	const app = resolve(o.app_dir);
	const dir = resolve(o.work_dir);
	if (!existsSync(join(app, 'node_modules'))) throw new Error(`abax: ${app} is not installed`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	for (const e of readdirSync(app)) {
		if (NOT_COPIED.has(e)) continue;
		cpSync(join(app, e), join(dir, e), { recursive: true });
	}
	symlinkSync(join(app, 'node_modules'), join(dir, 'node_modules'), 'dir');
	const plugin_options: CountedPluginOptions = {
		packages: o.packages,
		overlay: o.overlay,
		root: dir
	};
	writeFileSync(join(dir, COUNTED_CONFIG), counted_config_source(config_file(app), plugin_options));
	const vite = join(dir, 'node_modules', '.bin', 'vite');
	const t0 = performance.now();
	o.log?.(`  counted build of ${app}`);
	await run(vite, ['build', '--config', COUNTED_CONFIG, '--logLevel', 'warn'], dir, {
		...process.env,
		...o.env,
		NODE_ENV: 'production'
	});
	const ms = Math.round(performance.now() - t0);
	const server_dir = join(dir, '.svelte-kit', 'output', 'server');
	if (!existsSync(join(server_dir, 'index.js'))) {
		throw new Error(`abax: the counted build of ${app} has no SvelteKit server output`);
	}
	const static_dirs = [
		join(dir, 'build', 'client'),
		join(dir, 'build', 'prerendered'),
		join(dir, 'build'),
		join(dir, '.svelte-kit', 'output', 'client')
	].filter((d) => existsSync(d));
	return { dir, server_dir, static_dirs, ms };
}

/** The installed ogygia packages of an app: name -> version (from their package.json files). */
export function installed_versions(
	app_dir: string,
	packages: readonly string[]
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const p of packages) {
		if (p.endsWith('/*')) {
			const scope = join(app_dir, 'node_modules', p.slice(0, -2));
			if (!existsSync(scope)) continue;
			for (const name of readdirSync(scope)) {
				const v = version_of(join(scope, name));
				if (v) out[`${p.slice(0, -2)}/${name}`] = v;
			}
		} else {
			const v = version_of(join(app_dir, 'node_modules', p));
			if (v) out[p] = v;
		}
	}
	return out;
}

function version_of(dir: string): string | null {
	try {
		return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string })
			.version;
	} catch {
		return null;
	}
}
