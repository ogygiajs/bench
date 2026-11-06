import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { SeedResult, Suite } from './worker.ts';
import type { Failure } from './check.ts';
import { coverage_of } from './coverage.ts';
import { check_corpus } from './corpus.ts';

/*
 * The fuzzer: `pnpm --filter @bench/abax fuzz -- --seed N --runs M --time T`.
 *
 *   --seed N        first seed (default 1); program i is seed N + i, so a run is reproducible
 *   --runs M        programs per suite (default 100)
 *   --time T        stop starting new programs after T seconds (default: no limit); the
 *                   cross-process check and minimizing run after it
 *   --jobs J        worker processes at once (default: half the cores, at most 4)
 *   --suites a,b    programs, diff, maps, runtime (default all)
 *   --corpus dirs   also transform every .ts/.js file under these directories (and check the
 *                   real-world differential runs); `default` picks ogygia's packages next door
 *   --out dir       repros and summary.json (default fuzz-out)
 *   --no-minimize   keep failing programs as they are
 *
 * Each worker (worker.ts) runs a chunk of seeds and prints a line per program. A worker that dies
 * or stops printing for --hang seconds is killed; the seed it was on fails ("crash") and the rest
 * of its chunk goes to a new worker. A sample of programs is counted again in other processes:
 * the report must be the same (determinism across processes). Failing seeds are minimized and
 * written to out/repros, the original and the minimized program side by side.
 */

const WORKER = fileURLToPath(new URL('./worker.ts', import.meta.url));
const ALL: Suite[] = ['programs', 'diff', 'maps', 'runtime'];

const { values } = parseArgs({
	args: process.argv.slice(2).filter((a) => a !== '--'),
	options: {
		seed: { type: 'string', default: '1' },
		runs: { type: 'string', default: '100' },
		time: { type: 'string' },
		jobs: { type: 'string' },
		suites: { type: 'string' },
		corpus: { type: 'string' },
		out: { type: 'string', default: 'fuzz-out' },
		hang: { type: 'string', default: '120' },
		chunk: { type: 'string', default: '10' },
		'no-minimize': { type: 'boolean', default: false }
	}
});

const first = Number(values.seed);
const runs = Number(values.runs);
const deadline = values.time ? Date.now() + Number(values.time) * 1000 : Infinity;
const jobs = Number(
	values.jobs ?? Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)))
);
const suites = (values.suites ? values.suites.split(',') : ALL) as Suite[];
const out = resolve(values.out);
const hang_ms = Number(values.hang) * 1000;
const chunk = Number(values.chunk);

interface Job {
	suite: Suite;
	seeds: number[];
	extra: string[];
}

/** Run one worker over a list of seeds; resolves with every program's result, crashes included. */
function run_worker(job: Job): Promise<SeedResult[]> {
	return new Promise((done) => {
		const results: SeedResult[] = [];
		const left = new Set(job.seeds);
		let current: number | null = null;
		let buf = '';
		let stderr = '';
		// Instrumented code takes more stack per call than plain code: a program run close to the
		// stack limit would overflow only when instrumented, and do something else. With four times
		// the stack, the programs (whose depth the generator bounds) are far from it on both sides;
		// the ones that recurse without end still overflow on both.
		const child = spawn(
			process.execPath,
			[
				'--no-warnings',
				'--stack-size=3900',
				WORKER,
				job.suite,
				'--seeds',
				job.seeds.join(','),
				...job.extra
			],
			{ stdio: ['ignore', 'pipe', 'pipe'] }
		);
		let timer = setTimeout(() => child.kill('SIGKILL'), hang_ms);
		const touch = (): void => {
			clearTimeout(timer);
			timer = setTimeout(() => child.kill('SIGKILL'), hang_ms);
		};
		child.stderr.on('data', (d: Buffer) => {
			stderr = (stderr + d.toString()).slice(-4000);
		});
		child.stdout.on('data', (d: Buffer) => {
			touch();
			buf += d.toString();
			let nl: number;
			while ((nl = buf.indexOf('\n')) !== -1) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line.startsWith('{')) continue;
				const msg = JSON.parse(line) as SeedResult | { start: number };
				if ('start' in msg) current = msg.start;
				else {
					results.push(msg);
					left.delete(msg.seed);
					current = null;
				}
			}
		});
		child.on('close', async (code, signal) => {
			clearTimeout(timer);
			// died between programs: the next one is the one it could not start
			if (current === null && left.size > 0) current = Math.min(...left);
			if (current !== null) {
				const what =
					signal === 'SIGKILL' ? `no progress for ${hang_ms / 1000} s` : `exit ${code ?? signal}`;
				results.push({
					suite: job.suite,
					seed: current,
					lang: 'js',
					hash: '',
					failures: [
						{ oracle: 'crash', detail: `the worker died (${what}): ${stderr.trim().slice(-1500)}` }
					],
					features: [],
					types: [],
					runs: 0,
					blocks: 0,
					sites: 0,
					cut_short: 0,
					ms: 0
				});
				left.delete(current);
			}
			// what the dead worker did not get to (each death takes one seed: this ends)
			if (left.size > 0) results.push(...(await run_worker({ ...job, seeds: [...left] })));
			done(results);
		});
	});
}

/** `until`: start no job after it (the --time limit is on new programs, not on the checks after). */
async function pool(
	list: Job[],
	on_result: (r: SeedResult) => void,
	until = Infinity
): Promise<void> {
	let next = 0;
	const lane = async (): Promise<void> => {
		while (next < list.length && Date.now() < until) {
			const job = list[next++];
			for (const r of await run_worker(job)) on_result(r);
		}
	};
	await Promise.all(Array.from({ length: jobs }, lane));
}

function chunks(suite: Suite, seeds: number[], extra: string[] = []): Job[] {
	const out: Job[] = [];
	for (let i = 0; i < seeds.length; i += chunk)
		out.push({ suite, seeds: seeds.slice(i, i + chunk), extra });
	return out;
}

async function main(): Promise<number> {
	const t0 = Date.now();
	mkdirSync(join(out, 'repros'), { recursive: true });
	const results: SeedResult[] = [];
	const seeds = Array.from({ length: runs }, (_, i) => first + i);
	// interleaved, so a time limit leaves every suite with some programs
	const list: Job[] = [];
	const per = suites.map((s) => chunks(s, seeds));
	for (let i = 0; per.some((p) => i < p.length); i++)
		for (const p of per) if (i < p.length) list.push(p[i]);
	let done = 0;
	await pool(
		list,
		(r) => {
			results.push(r);
			done++;
			if (r.failures.length > 0) {
				const f = r.failures[0];
				console.log(
					`FAIL ${r.suite} seed ${r.seed}: ${f.oracle}: ${f.detail.split('\n')[0].slice(0, 300)}`
				);
			}
			if (done % 50 === 0)
				console.log(`... ${done} programs, ${Math.round((Date.now() - t0) / 1000)} s`);
		},
		deadline
	);

	// the same reports in other processes. Not a program that recurses until the stack overflows:
	// where it overflows depends on frame sizes, so its counts differ by nature (check.ts, `deep`).
	const sample = results.filter(
		(r) =>
			r.suite === 'programs' &&
			r.hash &&
			r.failures.length === 0 &&
			r.seed % 10 === 3 &&
			!r.features.includes('stack-overflow')
	);
	const by_seed = new Map(sample.map((r) => [r.seed, r]));
	const again: SeedResult[] = [];
	await pool(
		chunks('programs', sample.map((r) => r.seed).reverse(), ['--only', 'determinism']),
		(r) => again.push(r)
	);
	for (const r of again) {
		const a = by_seed.get(r.seed);
		if (a && r.hash && r.hash !== a.hash) {
			a.failures.push({
				oracle: 'determinism',
				detail: `another process counts it differently (${a.hash} vs ${r.hash})`
			});
			console.log(`FAIL programs seed ${r.seed}: determinism across processes`);
		}
	}

	// minimized repros of what failed
	const failed = results.filter((r) => r.failures.length > 0);
	if (!values['no-minimize']) {
		const mins = new Map<string, string>();
		await pool(
			failed.slice(0, 30).map((r) => ({ suite: r.suite, seeds: [r.seed], extra: ['--minimize'] })),
			(r) => {
				if (r.minimized) mins.set(`${r.suite}-${r.seed}`, r.minimized);
			}
		);
		for (const r of failed) r.minimized = mins.get(`${r.suite}-${r.seed}`);
	}
	for (const r of failed) {
		const ext = r.lang === 'ts' ? '.ts' : '.mjs';
		const name = `${r.suite}-${r.seed}`;
		if (r.source) writeFileSync(join(out, 'repros', name + ext), r.source);
		if (r.minimized) writeFileSync(join(out, 'repros', `${name}.min${ext}`), r.minimized);
	}

	const corpus = values.corpus
		? await check_corpus(values.corpus === 'default' ? [] : values.corpus.split(','))
		: null;

	const types = new Set<string>();
	const features = new Set<string>();
	let executions = 0;
	let blocks = 0;
	let sites = 0;
	let cut_short = 0;
	for (const r of results) {
		for (const t of r.types) types.add(t);
		for (const f of r.features) features.add(f);
		executions += r.runs;
		blocks += r.blocks;
		sites += r.sites;
		cut_short += r.cut_short;
	}
	const by_oracle: Record<string, number> = {};
	const all_failures: Array<Failure & { suite: Suite; seed: number }> = [];
	for (const r of results)
		for (const f of r.failures) {
			by_oracle[f.oracle] = (by_oracle[f.oracle] ?? 0) + 1;
			all_failures.push({ ...f, suite: r.suite, seed: r.seed });
		}
	if (corpus) for (const f of corpus.failures) by_oracle[f.oracle] = (by_oracle[f.oracle] ?? 0) + 1;
	const cov = coverage_of(types);
	const summary = {
		seeds: { first, last: first + runs - 1 },
		suites,
		programs: results.length,
		executions,
		blocks_checked: blocks,
		sites_checked: sites,
		sites_cut_short: cut_short,
		processes_compared: again.length,
		failures: by_oracle,
		coverage: cov,
		features: features.size,
		corpus: corpus
			? { files: corpus.files, runs: corpus.runs, failures: corpus.failures.length }
			: null,
		seconds: Math.round((Date.now() - t0) / 1000)
	};
	writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, '\t') + '\n');
	writeFileSync(
		join(out, 'failures.json'),
		JSON.stringify([...all_failures, ...(corpus?.failures ?? [])], null, '\t') + '\n'
	);
	console.log(
		`\n${summary.programs} programs (${executions} runs) in ${summary.seconds} s; ${blocks} block counts and ${sites} allocation sites checked against V8; ${again.length} reports compared across processes`
	);
	console.log(
		`transform node types covered: ${cov.share}% (${cov.covered.length} of ${cov.covered.length + cov.missing.length})${cov.missing.length ? `; not generated: ${cov.missing.join(', ')}` : ''}`
	);
	if (corpus)
		console.log(
			`corpus: ${corpus.files} files transformed, ${corpus.runs} real-world runs, ${corpus.failures.length} failures`
		);
	const n = Object.values(by_oracle).reduce((a, b) => a + b, 0);
	console.log(
		n === 0
			? 'no failures'
			: `${n} failure(s): ${JSON.stringify(by_oracle)}; repros in ${join(out, 'repros')}`
	);
	return n === 0 ? 0 : 1;
}

process.exitCode = await main();
