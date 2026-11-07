import { registerHooks } from 'node:module';
import { own_url } from '../own.ts';

/*
 * Preloaded (`--import`) into every process that counts a receipt: `heisenbench/bench`, the one
 * import a receipt's bench files take from Heisenbench, is the engine that counts them, whatever
 * the scratch tree has installed under that name. A receipt for Heisenbench itself installs the
 * released Heisenbench there as the package under test.
 */

export const BENCH_SPECIFIER = 'heisenbench/bench';

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === BENCH_SPECIFIER) return { url: own_url('bench').href, shortCircuit: true };
		return next(specifier, context);
	}
});
