/**
 * Calibration (spec 2 + 6). Run on a quiet machine, then commit what it writes.
 *
 *   node scripts/calibrate.ts prices [--keys a,b] [--sizes 16,64,256] [--out prices.json] [--time-ms 100]
 *       Fits each priced built-in's curve over sizes; writes prices.json (version + 1 on change).
 *
 *   node scripts/calibrate.ts weights [bench files...] [--root dir] [--out weights.json] [--time-ms 150]
 *       Fits steps -> ns weights per op kind (non-negative least squares) over a corpus of bench
 *       cases (default: calibration/corpus.bench.ts); writes weights.json and prints R^2 per family.
 */
import { calibrate_prices, calibrate_weights } from '../src/calibrate/index.ts';
import { DEFAULT_WEIGHTS_PATH } from '../src/calibrate/weights.ts';

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Map<string, string>();
const files: string[] = [];
for (let i = 0; i < rest.length; i++) {
	if (rest[i].startsWith('--')) flags.set(rest[i].slice(2), rest[++i] ?? '');
	else files.push(rest[i]);
}
const num = (k: string) => (flags.has(k) ? Number(flags.get(k)) : undefined);
const log = (l: string) => console.log(l);

if (cmd === 'prices') {
	const r = await calibrate_prices({
		keys: flags.get('keys')?.split(','),
		sizes: flags.get('sizes')?.split(',').map(Number),
		out: flags.get('out'),
		time_ms: num('time-ms'),
		log
	});
	console.log(
		`step = ${r.step_ns.toFixed(3)} ns; prices v${r.version}${r.changed ? ' (written)' : ' (unchanged)'}`
	);
} else if (cmd === 'weights') {
	const { weights } = await calibrate_weights({
		root: flags.get('root'),
		files: files.length > 0 ? files : undefined,
		out: flags.get('out') ?? DEFAULT_WEIGHTS_PATH,
		time_ms: num('time-ms'),
		repeats: num('repeats'),
		log
	});
	console.log(
		`weights v${weights.version}: R^2 ${weights.fit.r2} over ${weights.fit.points} points`
	);
} else {
	console.error('usage: node scripts/calibrate.ts prices|weights [options]');
	process.exitCode = 2;
}
