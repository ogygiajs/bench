import type { Tier } from './types.ts';

/*
 * V8 natives (`--allow-natives-syntax`), reached through `new Function` because `%Name(...)` is not
 * TypeScript. Only the health child loads this module.
 *
 * %GetOptimizationStatus returns a bit field whose layout moves between V8 versions, so the bits are
 * calibrated at start-up: probe functions are put in each known state (never run, interpreted,
 * baseline, Maglev, TurboFan) and the bits that differ name the states.
 */

type Native = (f: unknown) => unknown;

function native(body: string): Native {
	return new Function('f', body) as Native;
}

export interface Natives {
	status: (f: unknown) => number;
	prepare: (f: unknown) => void;
	optimize: (f: unknown) => void;
	script_id: (f: unknown) => number;
	position: (f: unknown) => number;
}

export function natives(): Natives {
	const status = native('return %GetOptimizationStatus(f)');
	const prepare = native('%PrepareFunctionForOptimization(f)');
	const optimize = native('%OptimizeFunctionOnNextCall(f)');
	const script_id = native('return %FunctionGetScriptId(f)');
	const position = native('return %FunctionGetScriptSourcePosition(f)');
	return {
		status: (f) => status(f) as number,
		prepare: (f) => void prepare(f),
		optimize: (f) => void optimize(f),
		script_id: (f) => script_id(f) as number,
		position: (f) => position(f) as number
	};
}

export interface StatusBits {
	lazy: number;
	interpreted: number;
	baseline: number;
	optimized: number;
	maglev: number;
	turbofan: number;
}

type Probe = (xs: number[]) => number;

let probes = 0;

/** A fresh function with its own code (a distinct source, so nothing is shared through caches). */
function probe(): Probe {
	return new Function(
		`return function probe(xs) { let s = ${probes++}; for (let i = 0; i < xs.length; i++) s += xs[i]; return s; }`
	)() as Probe;
}

/** Put probe functions in each state and read which bits name it. */
export function calibrate(n: Natives): StatusBits {
	const baseline_now = native('%CompileBaseline(f)');
	const maglev_next = native('%OptimizeMaglevOnNextCall(f)');
	const xs = [1, 2, 3];

	const lazy = n.status(probe());
	let f = probe();
	f(xs);
	const interpreted = n.status(f);
	f = probe();
	f(xs);
	baseline_now(f);
	const baseline = n.status(f);
	f = probe();
	n.prepare(f);
	f(xs);
	f(xs);
	maglev_next(f);
	f(xs);
	const maglev = n.status(f);
	f = probe();
	n.prepare(f);
	f(xs);
	f(xs);
	n.optimize(f);
	f(xs);
	const turbofan = n.status(f);

	const common = lazy & interpreted & baseline & maglev & turbofan;
	return {
		lazy: lazy & ~common & ~interpreted,
		interpreted: interpreted & ~common & ~lazy,
		baseline: baseline & ~common & ~interpreted & ~lazy,
		optimized: maglev & turbofan & ~common,
		maglev: maglev & ~turbofan & ~common,
		turbofan: turbofan & ~maglev & ~common
	};
}

/** A status word in plain words. A function that is only "lazy" was never compiled (or lost its code). */
export function decode(status: number, bits: StatusBits): Tier {
	if (bits.optimized !== 0 && (status & bits.optimized) === bits.optimized) {
		if (bits.turbofan !== 0 && (status & bits.turbofan) !== 0) return 'turbofan';
		if (bits.maglev !== 0 && (status & bits.maglev) !== 0) return 'maglev';
	}
	if (bits.baseline !== 0 && (status & bits.baseline) !== 0) return 'baseline';
	if (bits.interpreted !== 0 && (status & bits.interpreted) !== 0) return 'interpreted';
	return 'not compiled';
}
