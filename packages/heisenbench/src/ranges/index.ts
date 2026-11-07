import { join } from 'node:path';
import { load_weights } from '../calibrate/weights.ts';
import { package_file } from '../own.ts';
import { load_prices } from '../prices.ts';
import { changes_of, load_dataset, weights_of } from './dataset.ts';
import { evaluate_ranges, render_evaluation } from './evaluate.ts';
import type { Evaluation } from './evaluate.ts';
import { DEFAULT_RANGES_PATH, hash_files, train_ranges, write_ranges } from './model.ts';
import type { RangesModel } from './model.ts';

/*
 * `heisenbench calibrate ranges`: train the steps -> ns range model (model.ts) on a version of
 * the training data (calibration/data/training.md) and write ranges.json. The same data and seed
 * give the same file, byte for byte. With `evaluate`, also the held-out evaluation (evaluate.ts),
 * by change and by code.
 */

export const DEFAULT_DATA_DIR = package_file('calibration/data/');
export const DEFAULT_DATASET_VERSION = 1;

export interface CalibrateRangesOptions {
	data?: string;
	version?: number;
	out?: string | URL;
	seed?: number;
	evaluate?: boolean;
	log?: (line: string) => void;
}

export function calibrate_ranges(o: CalibrateRangesOptions = {}): {
	model: RangesModel;
	changed: boolean;
	evaluations: Evaluation[];
	markdown: string;
} {
	const dir = o.data ?? DEFAULT_DATA_DIR;
	const version = o.version ?? DEFAULT_DATASET_VERSION;
	const data = load_dataset(dir, version);
	const obs = data.observations;
	const w = weights_of(obs);
	const prices = load_prices();
	const options = o.seed !== undefined ? { seed: o.seed } : undefined;
	const fit = train_ranges(
		obs.map((x, i) => ({ input: x.input, ns: x.ns, weight: w[i], group: x.change })),
		prices,
		{
			dataset: {
				version,
				observations: obs.length,
				hash: hash_files([
					join(dir, `training-counts-${version}.json`),
					join(dir, `training-times-${version}.json`)
				])
			},
			node: data.node,
			options,
			changes: changes_of(obs, (x) => x.change)
		}
	);
	const { model, changed } = write_ranges(o.out ?? DEFAULT_RANGES_PATH, fit);
	o.log?.(
		`ranges v${model.version} from training data ${version} (${obs.length} timed sides): widened ${model.widen} for a call, ${model.change_widen} for a change${changed ? ' (written)' : ' (unchanged)'}`
	);
	const evaluations: Evaluation[] = [];
	const parts: string[] = [
		'# Steps to ms, with a range: held-out evaluation',
		'',
		`Written by \`heisenbench calibrate ranges --md calibration/ranges.md\` (docs/calibration.md, "Ranges"). ranges.json v${model.version}: training data ${version} (\`${model.dataset.hash}\`), ${obs.length} timed sides, seed ${model.options.seed}; ${model.options.rounds} trees of depth ${model.options.depth} per quantile. A call's 10-90% range is widened by ${model.widen} (log), a change's is its estimate times and over ${Math.exp(model.change_widen).toPrecision(3)}.`,
		'',
		'Every number below is held out: a model trained without the group predicts it.',
		''
	];
	if (o.evaluate) {
		const weights = load_weights();
		if (!weights) throw new Error('heisenbench: the evaluation needs weights.json');
		for (const split of ['change', 'code'] as const) {
			o.log?.(`evaluating, held out by ${split}...`);
			const e = evaluate_ranges(obs, { split, weights, prices, tree: options });
			evaluations.push(e);
			parts.push(`## Held out by ${split}`, '', render_evaluation(e));
		}
	}
	return { model, changed, evaluations, markdown: parts.join('\n') };
}

export { load_ranges, predict_change, predict_range, DEFAULT_RANGES_PATH } from './model.ts';
export type { RangeEstimate, RangesModel } from './model.ts';
export { input_of_units } from './features.ts';
export type { RangeInput } from './features.ts';
