import {
	TraceMap,
	originalPositionFor,
	GREATEST_LOWER_BOUND,
	LEAST_UPPER_BOUND
} from '@jridgewell/trace-mapping';
import type { SourceMapInput } from '@jridgewell/trace-mapping';

export interface Position {
	line: number;
	col: number;
}

/**
 * Maps an offset in the code being instrumented to a line/column in the original source.
 * Without an input map the code is the original (TS stripped to whitespace keeps every offset).
 */
export class Positions {
	#starts: number[];
	#map: TraceMap | null;
	source: string | null = null;

	constructor(code: string, input_map?: SourceMapInput | null) {
		const starts = [0];
		for (let i = 0; i < code.length; i++) {
			if (code.charCodeAt(i) === 10) starts.push(i + 1);
		}
		this.#starts = starts;
		this.#map = input_map ? new TraceMap(input_map) : null;
		if (this.#map) {
			const sources = this.#map.sources.filter((s): s is string => s != null);
			this.source = sources.length > 0 ? sources[0] : null;
		}
	}

	/** Generated line (1-based) and column (0-based) of an offset. */
	generated(offset: number): Position {
		const starts = this.#starts;
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (starts[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return { line: lo + 1, col: offset - starts[lo] };
	}

	/** Original line (1-based) and column; line 0 when the code has no mapping there (generated). */
	original(offset: number): Position {
		const g = this.generated(offset);
		if (!this.#map) return g;
		let o = originalPositionFor(this.#map, {
			line: g.line,
			column: g.col,
			bias: GREATEST_LOWER_BOUND
		});
		if (o.line == null) {
			o = originalPositionFor(this.#map, { line: g.line, column: g.col, bias: LEAST_UPPER_BOUND });
		}
		if (o.line == null) return { line: 0, col: 0 };
		return { line: o.line, col: o.column ?? 0 };
	}
}
