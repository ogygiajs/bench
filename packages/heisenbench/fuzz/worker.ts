import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from './gen.ts';
import type { Program } from './gen.ts';
import { Lab } from './lab.ts';
import { check_program } from './check.ts';
import type { Failure, Oracle } from './check.ts';
import { minimize } from './minimize.ts';
import { index_ast } from './ast.ts';
import { check_diff } from './diff.ts';
import { check_maps } from './maps.ts';
import { check_runtime } from './runtime.ts';

/*
 * A fuzzing worker: `node worker.ts <suite> <first seed> <count> [--minimize] [--only a,b]`, or
 * `node worker.ts <suite> --seeds 3,17,40 [...]`.
 * Generates and checks one program per seed, one JSON line per program on stdout (a `{"start":N}`
 * line first, so the parent knows which seed a dead or stuck worker was on):
 *
 *   programs   oracles 1-5 (check.ts) on a generated program
 *   diff       oracle 6 (diff.ts): rewrites that cost nothing, and planted costs
 *   maps       oracle 7 (maps.ts): block lines through TS transpiling and the Svelte compiler
 *   runtime    oracle 8 (runtime.ts): runs cut short by a step cap leave nothing behind
 */

export type Suite = 'programs' | 'diff' | 'maps' | 'runtime';

export interface SeedResult {
	suite: Suite;
	seed: number;
	lang: 'js' | 'ts';
	hash: string;
	failures: Failure[];
	features: string[];
	types: string[];
	/** Program runs (plain, counted, fresh copy, probed). */
	runs: number;
	blocks: number;
	sites: number;
	cut_short: number;
	source?: string;
	minimized?: string;
	ms: number;
}

function message(e: unknown): string {
	if (!(e instanceof Error)) return String(e);
	return e.stack && e.stack.includes(e.message)
		? e.stack
		: `${e.name}: ${e.message}\n${e.stack ?? ''}`;
}

async function check_one(
	suite: Suite,
	lab: Lab,
	prog: Program,
	source: string,
	only?: Set<Oracle>
): Promise<Omit<SeedResult, 'seed' | 'ms' | 'features' | 'types' | 'lang' | 'suite'>> {
	const out = { hash: '', failures: [] as Failure[], runs: 0, blocks: 0, sites: 0, cut_short: 0 };
	if (suite === 'programs') {
		const l = lab.load(source, prog.lang);
		const r = await check_program(lab, l, { only, deep: prog.deep });
		return {
			...out,
			hash: r.hash,
			failures: r.failures,
			runs: prog.deep ? 2 : 4,
			blocks: r.blocks,
			sites: r.sites,
			cut_short: r.cut_short
		};
	}
	if (suite === 'diff') {
		const r = await check_diff(lab, { ...prog, source });
		return { ...out, failures: r.failures, runs: r.runs };
	}
	if (suite === 'runtime') {
		const r = await check_runtime(lab, { ...prog, source });
		return { ...out, failures: r.failures, runs: r.runs };
	}
	const r = check_maps({ ...prog, source });
	return { ...out, failures: r.failures, blocks: r.blocks };
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const suite = args[0] as Suite;
	// `<first> <count>`, or `--seeds a,b,c`
	const seeds_at = args.indexOf('--seeds');
	const seeds =
		seeds_at === -1
			? Array.from({ length: Number(args[2]) }, (_, i) => Number(args[1]) + i)
			: args[seeds_at + 1].split(',').map(Number);
	const do_min = args.includes('--minimize');
	const only_at = args.indexOf('--only');
	const only = only_at === -1 ? undefined : new Set(args[only_at + 1].split(',') as Oracle[]);
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'heisenbench-fuzz-')));
	const lab = new Lab(root);
	if (suite === 'programs') await lab.start_coverage();
	for (const seed of seeds) {
		const t0 = performance.now();
		process.stdout.write(`${JSON.stringify({ start: seed })}\n`);
		const prog = generate(seed, suite === 'maps' ? { lang: 'ts' } : {});
		let types: string[] = [];
		try {
			types = [...index_ast(prog.source, prog.lang).types].sort();
		} catch {
			// the program does not parse: the crash below says so
		}
		const res: SeedResult = {
			suite,
			seed,
			lang: prog.lang,
			hash: '',
			failures: [],
			features: prog.features,
			types,
			runs: 0,
			blocks: 0,
			sites: 0,
			cut_short: 0,
			ms: 0
		};
		try {
			Object.assign(res, await check_one(suite, lab, prog, prog.source, only));
		} catch (e) {
			res.failures = [{ oracle: 'crash', detail: message(e) }];
		}
		if (res.failures.length > 0) {
			res.source = prog.source;
			if (do_min) {
				const oracle = res.failures[0].oracle;
				res.minimized = await minimize(
					prog.source,
					async (src) => {
						try {
							const r = await check_one(suite, lab, prog, src, new Set([oracle]));
							return r.failures.some((f) => f.oracle === oracle);
						} catch {
							return oracle === 'crash';
						}
					},
					prog.lang
				);
			}
		}
		res.ms = Math.round(performance.now() - t0);
		process.stdout.write(`${JSON.stringify(res)}\n`);
	}
}

await main();
