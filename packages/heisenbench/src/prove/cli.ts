import { writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { UsageError } from '../usage.ts';
import { prove_candidate, read_candidate, samples_of, target_of } from './index.ts';
import type { ProveOptions, ProveReport } from './index.ts';
import {
	DEFAULT_MODEL,
	SETUP_MESSAGE,
	claude_provider,
	has_key,
	run_proposals
} from './propose.ts';
import type { Provider } from './propose.ts';
import { prove_lines, render_prove } from './report.ts';

/*
 * `heisenbench prove <module> <function> --candidate <file>` and `... --propose`. Exit 0 when the
 * candidate (or at least one proposal) is proven, 1 when none is, 2 when the command line is wrong.
 */

function list(v: string | undefined): string[] | undefined {
	return v === undefined ? undefined : v.split(',').filter((x) => x !== '');
}

export async function prove_command(
	positional: string[],
	flags: Map<string, string>,
	/** The provider `--propose` asks (tests inject one); default: the Claude API. */
	provider?: Provider
): Promise<number> {
	const [module, fn] = positional;
	const propose = flags.has('propose');
	const candidate = flags.get('candidate');
	if (propose === (candidate !== undefined))
		throw new UsageError('give a candidate (--candidate <file>) or --propose, one of them');
	if (propose && !provider && !has_key()) {
		console.error(SETUP_MESSAGE);
		return 1;
	}
	const num = (k: string): number | undefined => (flags.has(k) ? Number(flags.get(k)) : undefined);
	const deps = flags.get('deps');
	const o: ProveOptions = {
		root: flags.get('root') ?? process.cwd(),
		module,
		fn,
		records: list(flags.get('records')),
		bench: list(flags.get('bench')),
		deps: deps === undefined || deps === 'all' ? true : deps === 'none' ? false : list(deps),
		sizes: list(flags.get('sizes'))?.map(Number),
		cap: num('cap'),
		variants: num('variants'),
		edge: flags.get('edge') as ProveOptions['edge'],
		seed: num('seed'),
		tolerance: flags.has('tolerance') ? Number(flags.get('tolerance')) / 100 : undefined,
		tolerance_steps: num('tolerance-steps'),
		setup_tolerance: flags.has('setup-tolerance')
			? Number(flags.get('setup-tolerance')) / 100
			: undefined,
		log: (l) => console.log(l)
	};
	if (!o.records && !o.bench)
		throw new UsageError(
			'where are the inputs? give --records <dir> (recorded calls) and/or --bench <files>'
		);
	const t = target_of(o.root, module, fn);
	// the SDK is found (or its absence said) before any input is read
	const proposer =
		propose && !provider ? await claude_provider(flags.get('model') ?? DEFAULT_MODEL) : null;
	const { samples, calls } = await samples_of(o, t);
	console.log(`prove    ${t.id}: ${samples.length} recorded inputs (of ${calls} recorded calls)`);
	const out = flags.get('out') ?? 'heisenbench-prove.json';
	const md = flags.get('md');
	if (!propose) {
		const name = relative(process.cwd(), resolve(candidate!)) || candidate!;
		const r = await prove_candidate(o, t, samples, read_candidate(candidate!), name);
		console.log(prove_lines(r));
		writeFileSync(out, JSON.stringify(r, null, '\t') + '\n');
		if (md) writeFileSync(md, render_prove(r));
		return r.verdict.proven ? 0 : 1;
	}
	const p = provider ?? proposer!;
	const outcomes = await run_proposals(o, t, samples, p, {
		count: num('proposals') ?? 3,
		send_inputs: flags.has('send-inputs'),
		log: (l) => console.log(l)
	});
	const proven = outcomes
		.map((x) => x.report)
		.filter((r): r is ProveReport => r !== null && r.verdict.proven);
	for (const r of proven) console.log(prove_lines(r));
	console.log(`propose  ${proven.length} of ${outcomes.length} proposals proven`);
	writeFileSync(
		out,
		JSON.stringify(
			{
				function: t.id,
				provider: p.name,
				proposals: outcomes.map((x) => ({ n: x.n, outcome: x.outcome })),
				proven
			},
			null,
			'\t'
		) + '\n'
	);
	if (md) {
		const text = proven.length
			? proven.map(render_prove).join('\n')
			: `#### Proposals for \`${t.id}\`\n\nNone of ${outcomes.length} proposals was proven.\n`;
		writeFileSync(md, text);
	}
	return proven.length > 0 ? 0 : 1;
}
