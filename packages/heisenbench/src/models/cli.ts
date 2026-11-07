import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { UsageError } from '../usage.ts';
import { needs_bench_repo, package_file } from '../own.ts';
import {
	DEFAULT_SEED,
	FEEL_FILE,
	feel_text,
	load_feel_model,
	read_feel_dataset,
	render_feel_evaluation,
	train_feel
} from './feel.ts';

/*
 * heisenbench feel train [--data-version 1] [--seed 1] [--data dir] [--out feel.json] [--md eval.md]
 *     fit the "will users feel it" odds on a training dataset, print its held-out scores
 * heisenbench feel check [--out feel.json]
 *     fit it again from the dataset the model file names: exit 1 unless the bytes are the same
 *
 * Both need the dataset under calibration/data/, so they run in a clone of the bench repo only.
 */

/** `--data-version` and `--seed` are checked as numbers by the CLI's option parser. */
export function feel_command(positional: string[], flags: Map<string, string>): number {
	const what = positional[0];
	const out = flags.get('out') ?? package_file(FEEL_FILE);
	const data = flags.get('data');
	if (data === undefined) needs_bench_repo('calibration/data');
	if (what === 'train') {
		const version = Number(flags.get('data-version') ?? 1);
		const seed = Number(flags.get('seed') ?? DEFAULT_SEED);
		const model = train_feel(read_feel_dataset(version, data), { seed });
		writeFileSync(out, feel_text(model));
		const md = render_feel_evaluation(model);
		const md_out = flags.get('md');
		if (md_out) writeFileSync(md_out, md);
		console.log(md);
		console.log(`wrote ${out}`);
		return 0;
	}
	if (what === 'check') {
		if (!existsSync(out))
			throw new UsageError(`no model at ${out} (heisenbench feel train writes it)`);
		const committed = load_feel_model(out)!;
		const again = feel_text(
			train_feel(read_feel_dataset(committed.dataset.version, data), {
				seed: committed.seed,
				l2: committed.l2
			})
		);
		if (again === readFileSync(out, 'utf8')) {
			console.log(
				`${out}: the same bytes, fitted again from dataset v${committed.dataset.version}`
			);
			return 0;
		}
		console.error(
			`${out}: fitting again from dataset v${committed.dataset.version} gives other bytes (run heisenbench feel train)`
		);
		return 1;
	}
	throw new UsageError(`feel takes train or check, not ${JSON.stringify(what)}`);
}
