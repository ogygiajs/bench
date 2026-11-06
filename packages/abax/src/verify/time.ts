import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { TimeComparison } from '../measure/time.ts';
import { CLI, KEYS, cli, key_files, make_pair, temp_dir } from './fixture.ts';
import type { Check } from './types.ts';

/*
 * The time answer key (test/time-key): `work()` made four times slower, a quarter as long, or only
 * commented; `steady()` never changes. Both sides are timed by `abax time` (the plain build, both
 * in one process taking turns) and judged by the no-overlap noise rule: the planted changes must be
 * significant in their direction, everything else "same". The step counts must agree with the
 * verdicts (more steps where it got slower, none changed where nothing did).
 *
 * Seven rounds: two sets of seven samples fall fully apart by chance with probability
 * 2 / C(14, 7) = 0.06%, before the rule also asks for a gap above the spread and the 3% floor.
 */

const exec = promisify(execFile);
const REPEATS = 7;

type Verdict = 'slower' | 'faster' | 'same';

export function time_checks(): Check[] {
	const dir = join(KEYS, 'time-key');
	return readdirSync(dir)
		.filter((d) => d !== 'base')
		.sort()
		.map((name) => {
			const e = JSON.parse(readFileSync(join(dir, name, 'expect.json'), 'utf8')) as {
				what: string;
				time: Record<string, Verdict>;
			};
			const planted = Object.values(e.time).some((v) => v !== 'same');
			const show = (t: Record<string, string>) =>
				Object.entries(t)
					.map(([k, v]) => `${k} ${v}`)
					.join(', ');
			return {
				layer: 'time' as const,
				name,
				what: e.what,
				planted,
				expect: show(e.time),
				exclusive: true,
				run: async () => {
					const tmp = temp_dir('abax-verify-time-');
					const p = make_pair(tmp, key_files('time-key', 'base'), key_files('time-key', name));
					const out = join(tmp, 'time.json');
					await exec(
						process.execPath,
						[
							'--no-warnings',
							CLI,
							'time',
							'lib.bench.ts',
							'--base',
							p.base_dir,
							'--pr',
							p.pr_dir,
							'--repeats',
							String(REPEATS),
							'--time-ms',
							'100',
							'--out',
							out,
							'--md',
							join(tmp, 'time.md')
						],
						{ cwd: tmp }
					);
					const t = JSON.parse(readFileSync(out, 'utf8')) as TimeComparison;
					const [b, pr] = await Promise.all([cli(p.base_dir, ['run']), cli(p.pr_dir, ['run'])]);
					const got: Record<string, string> = {};
					let pass = t.errors.length === 0;
					for (const [c, want] of Object.entries(e.time)) {
						const tc = t.cases.find((x) => x.name === c);
						const v = tc?.verdicts.p50_ns;
						const verdict: Verdict = v?.regressed ? 'slower' : v?.improved ? 'faster' : 'same';
						const bs = b.cases.find((x) => x.name === c)?.totals.steps ?? NaN;
						const ps = pr.cases.find((x) => x.name === c)?.totals.steps ?? NaN;
						const steps: Verdict = ps > bs ? 'slower' : ps < bs ? 'faster' : 'same';
						const pct = v ? ((v.pr - v.base) / v.base) * 100 : NaN;
						got[c] =
							`${verdict} (p50 ${pct > 0 ? '+' : ''}${pct.toFixed(0)}%, steps ${steps === 'same' ? '=' : steps === 'slower' ? 'up' : 'down'})`;
						if (verdict !== want || steps !== want) pass = false;
					}
					return { pass, got: show(got) };
				}
			};
		});
}
