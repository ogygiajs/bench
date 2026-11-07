/**
 * Calibration (spec 2 + 6). Run on a quiet machine, then commit what it writes.
 *
 *   node scripts/calibrate.ts prices [--keys a,b] [--sizes 16,64,256] [--out prices.json] [--time-ms 100]
 *       Fits each priced built-in's curve over sizes; writes prices.json (version + 1 on change).
 *
 *   node scripts/calibrate.ts weights [bench files...] [--root dir] [--out weights.json] [--time-ms 150]
 *       Fits steps -> ns weights per op kind (non-negative least squares) over a corpus of bench
 *       cases (default: calibration/corpus.bench.ts); writes weights.json and prints R^2 per family.
 *
 * Same as `heisenbench calibrate prices|weights`.
 */
import { measure_command } from '../src/measure/cli.ts';

const args = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
	if (args[i].startsWith('--')) flags.set(args[i].slice(2), args[++i] ?? '');
	else positional.push(args[i]);
}
process.exitCode = (await measure_command('calibrate', positional, flags)) ?? 2;
