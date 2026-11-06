import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diff_reports } from '../diff/index.ts';
import { git_diff } from '../diff/git.ts';
import { CountedServer } from '../app/server.ts';
import { counted_plugins } from '../app/vite.ts';
import type { AppCaseReport, AppReport } from '../app/types.ts';
import { build_weights } from '../weight/weights.ts';
import type { AppWeights } from '../weight/weights.ts';
import { rank_changes } from '../weight/rank.ts';
import { KEYS, cli, key_files, make_pair, temp_dir, write_all } from './fixture.ts';
import type { Check } from './types.ts';

/*
 * The app-level answer key (test/app-key): real-app weights decide what a bench change costs.
 *
 * A small framework package (`fakekit`: a SvelteKit-shaped `Server` whose requests render one part
 * per character of the path) is bundled with the counting plugins and served by the counted server,
 * which makes three requests: that gives the weights (calls per request of every function). The
 * same module, as the source of `packages/fakekit/src/server.js`, is benched before and after each
 * planted change, and the change is ranked by those weights:
 *
 *   hot-small    two more steps per call on the function every request runs per character: shown
 *   cold-small   two more steps per call on a function no request runs: suppressed
 *   cold-large   a 64-step loop on that cold function: shown (big enough to matter to a caller)
 *   hot-noop     a renamed local and a comment on the hot function: nothing to rank
 */

const SOURCE = 'packages/fakekit/src/server.js';
const PATH = '/catalog/items';

let weights: Promise<AppWeights> | null = null;

async function app_weights(): Promise<AppWeights> {
	const dir = temp_dir('abax-verify-app-');
	write_all(dir, {
		'node_modules/fakekit/package.json': '{"name":"fakekit","version":"1.0.0","type":"module"}',
		'node_modules/fakekit/server.js': readFileSync(
			join(KEYS, 'app-key', 'base', 'lib.ts.txt'),
			'utf8'
		),
		'server-entry.js': `export { Server } from 'fakekit/server.js';`
	});
	const { rolldown } = await import('rolldown');
	const server_dir = join(dir, 'out', 'server');
	const bundle = await rolldown({
		input: join(dir, 'server-entry.js'),
		cwd: dir,
		platform: 'node',
		plugins: counted_plugins({ packages: ['fakekit'], root: dir, target: 'server' })
	});
	await bundle.write({ dir: server_dir, format: 'esm', entryFileNames: 'index.js' });
	write_all(server_dir, { 'manifest-full.js': 'export const manifest = {};' });
	const server = await CountedServer.start({ server_dir, static_dirs: [], env: {}, cwd: dir });
	try {
		const repeat = 3;
		const { results, loaded } = await server.count(
			[{ name: `GET ${PATH}`, requests: [{ path: PATH }], repeat }],
			'http://127.0.0.1',
			dir
		);
		const r = results[0];
		if (!r.report || r.error)
			throw new Error(`abax verify: the counted request failed: ${r.error}`);
		const c: AppCaseReport = {
			...r.report,
			app: {
				scenario: 'fake',
				side: 'server',
				unit: 'request',
				units: repeat,
				label: `GET ${PATH}`,
				unstable_functions: []
			}
		};
		const report: AppReport = {
			schema: 'abax-report/1' as AppReport['schema'],
			prices: { version: 0, hash: '' },
			node: process.version,
			git: { sha: null, prefix: '' },
			cases: [c],
			app: { packages: ['fakekit'], ogygia: {}, scenarios: ['fake'], loaded }
		} as AppReport;
		return build_weights([report]);
	} finally {
		await server.stop();
	}
}

export function app_checks(): Check[] {
	const dir = join(KEYS, 'app-key');
	return readdirSync(dir)
		.filter((d) => d !== 'base')
		.sort()
		.map((name) => {
			const e = JSON.parse(readFileSync(join(dir, name, 'expect.json'), 'utf8')) as {
				what: string;
				function: string | null;
				heat: string | null;
				show: boolean;
			};
			return {
				layer: 'app' as const,
				name,
				what: e.what,
				planted: e.function !== null,
				expect:
					e.function === null
						? 'nothing ranked'
						: `${e.function}: ${e.heat}, ${e.show ? 'shown' : 'suppressed'}`,
				exclusive: false,
				run: async () => {
					const w = await (weights ??= app_weights());
					const p = make_pair(
						temp_dir('abax-verify-'),
						key_files('app-key', 'base', SOURCE),
						key_files('app-key', name, SOURCE)
					);
					const [b, pr] = await Promise.all([cli(p.base_dir, ['run']), cli(p.pr_dir, ['run'])]);
					const d = diff_reports(b, pr, { files: git_diff(p.repo, p.base_sha, p.pr_sha) });
					const ranked = rank_changes(d, w, null);
					const got =
						ranked.length === 0
							? 'nothing ranked'
							: ranked
									.map(
										(r) =>
											`${r.function}: ${r.judgement.heat}, ${r.judgement.show ? 'shown' : 'suppressed'} (${r.delta_per_call > 0 ? '+' : ''}${r.delta_per_call} steps/call${r.judgement.top ? `, ${r.judgement.top.calls} calls/request` : ''})`
									)
									.join('; ');
					if (e.function === null) return { pass: ranked.length === 0, got };
					const pass =
						ranked.length === 1 &&
						ranked[0].function === e.function &&
						ranked[0].judgement.heat === e.heat &&
						ranked[0].judgement.show === e.show &&
						ranked[0].delta_per_call > 0;
					return { pass, got };
				}
			};
		});
}
