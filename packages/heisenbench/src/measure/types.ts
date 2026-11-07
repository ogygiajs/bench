import type { TimeStats } from './time.ts';
import type { LeakResult } from './leak.ts';

/** What the plain-build layers and the steps -> ns estimate add to one case of a report. */
export interface CaseMeasure {
	/** tinybench on the plain build. */
	time?: TimeStats | null;
	/** Real vs estimated bytes per call, per function (alloc.ts, elision.ts). */
	bytes?: BytesMeasure | null;
	leak?: LeakResult | null;
	/** Estimated ns per call from the steps -> ns weights (calibrate/weights.ts). */
	estimate?: Estimate | null;
	/** Layer failures, by layer. */
	errors?: Record<string, string>;
}

export interface BytesMeasure {
	/** Real bytes per call charged to source functions, and the estimate for the same functions. */
	real: number;
	estimated: number;
	functions: FunctionBytesMeasure[];
}

export interface FunctionBytesMeasure {
	id: string;
	estimated: number;
	real: number;
	/** The engine allocates far less than the estimate: allocations elided or folded. */
	elided: boolean;
	/** Allocation lines of the function the gap is put on (when elided). */
	lines: number[];
}

export interface Estimate {
	/** Estimated ns per call of the case. */
	ns: number;
	weights_version: number;
	/** Fit of this case in the calibration corpus, when it was part of it. */
	r2: number | null;
	/** Measured ns per call over estimated (when the time layer ran). */
	ratio: number | null;
	/** The estimate is not trusted for this case: read the time layer. */
	time_led: boolean;
}
