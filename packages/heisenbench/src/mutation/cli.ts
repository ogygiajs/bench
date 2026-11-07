import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Report } from '../report.ts';
import { UsageError } from '../usage.ts';
import { load_weights_list } from '../weight/weights.ts';
import { DEFAULT_SAMPLE, mutation_score } from './index.ts';
import { render_mutation } from './markdown.ts';
import { OPERATORS } from './operators.ts';
import type { Operator } from './operators.ts';

/**
 * `heisenbench mutate <bench files...> --root <dir> --list <sources.txt>`: performance mutants in
 * every function of the sources, and which ones the bench cases notice (mutation/index.ts).
 */
export async function mutate_command(
	positional: string[],
	flags: Map<string, string>,
	read_report: (path: string) => Report,
	deps: boolean | string[]
): Promise<number> {
	const root = resolve(flags.get('root') ?? process.cwd());
	const list = flags.get('list');
	if (list === undefined)
		throw new UsageError(
			'--list <file> is required: the source files whose functions get mutants, one per line'
		);
	if (!existsSync(list)) throw new UsageError(`--list ${list}: no such file`);
	const sources = readFileSync(list, 'utf8')
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	const ops = flags.get('operators')?.split(',').filter(Boolean) as Operator[] | undefined;
	const bad = ops?.filter((op) => !OPERATORS.includes(op));
	if (bad && bad.length > 0)
		throw new UsageError(`--operators takes ${OPERATORS.join(', ')}, not ${bad.join(', ')}`);
	const sample_flag = flags.get('sample') ?? String(DEFAULT_SAMPLE);
	const sample = sample_flag === 'all' ? 'all' : Number(sample_flag);
	if (sample !== 'all' && !(Number.isInteger(sample) && sample > 0))
		throw new UsageError(
			`--sample takes a whole number above 0 or all, not ${JSON.stringify(sample_flag)}`
		);
	const records = flags.get('records');
	if (records !== undefined && !(existsSync(records) && statSync(records).isDirectory()))
		throw new UsageError(`--records ${records} is not a directory`);
	const num = (k: string) => (flags.has(k) ? Number(flags.get(k)) : undefined);
	const modules = flags.get('modules');
	const result = await mutation_score({
		root,
		files: positional,
		sources,
		report: flags.has('report') ? read_report(flags.get('report')!) : null,
		operators: ops,
		sample,
		seed: num('seed'),
		modules: modules ? new Set(modules.split(',').filter(Boolean)) : null,
		include_deps: flags.get('mutate-deps') === 'on',
		sizes: flags.get('sizes')?.split(',').map(Number),
		cap: num('cap'),
		records: records ? { dir: records, alias: flags.get('alias') ?? null } : null,
		weights: flags.has('weights') ? load_weights_list(flags.get('weights')!) : null,
		requests_per_day: num('requests-per-day'),
		deps,
		jobs: num('jobs'),
		max_recounts: num('max-recounts'),
		budget_ms: num('budget-ms'),
		work: flags.get('work'),
		suggestions: num('suggestions'),
		log: (l) => console.log(l)
	});
	const md = render_mutation(result);
	const md_out = flags.get('md');
	if (md_out) writeFileSync(md_out, md);
	console.log('\n' + md);
	const out = flags.get('out');
	if (out) writeFileSync(out, JSON.stringify(result, null, '\t') + '\n');
	return 0;
}
