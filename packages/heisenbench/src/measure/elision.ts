import type { CaseReport } from '../report.ts';
import type { BytesResult } from './alloc.ts';
import type { BytesMeasure, FunctionBytesMeasure } from './types.ts';

/*
 * Estimated bytes (counting build, layout.ts) next to real bytes (plain build, alloc.ts), per
 * function and per call. The estimate is what the code asks for; the engine may give less: escape
 * analysis drops objects that never leave an optimized function, constant folding drops strings.
 *
 * A function is "elided" when its estimate is at least ELIDED_MIN bytes and the real bytes are
 * below half of it. The real bytes are per function, not per line, so the gap is put on the
 * function's allocation sites, largest first, until the sites cover it (all of them when nothing
 * was allocated at all). Real bytes above the estimate (backing store growth inside built-ins,
 * hidden allocations the model does not price) are reported, never flagged.
 */

export const ELIDED_MIN = 32;

export function compare_bytes(c: CaseReport, real: BytesResult): BytesMeasure {
	const by_id = new Map(real.functions.map((f) => [f.id, f.bytes]));
	const functions: FunctionBytesMeasure[] = [];
	let estimated = 0;
	for (const f of c.functions) {
		const r = by_id.get(f.id) ?? 0;
		by_id.delete(f.id);
		if (f.bytes === 0 && r === 0) continue;
		estimated += f.bytes;
		const elided = f.bytes >= ELIDED_MIN && r < f.bytes / 2;
		let lines: number[] = [];
		if (elided) {
			const gap = f.bytes - r;
			const sites = [...f.sites].sort((a, b) => b.bytes - a.bytes || a.line - b.line);
			let covered = 0;
			for (const s of sites) {
				if (covered >= gap) break;
				covered += s.bytes;
				lines.push(s.line);
			}
			lines = [...new Set(lines)].sort((a, b) => a - b);
		}
		functions.push({ id: f.id, estimated: f.bytes, real: r, elided, lines });
	}
	// functions the plain build allocated in that the counting run did not see allocate
	for (const [id, r] of by_id)
		functions.push({ id, estimated: 0, real: r, elided: false, lines: [] });
	functions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return { real: real.bytes, estimated: Math.round(estimated * 100) / 100, functions };
}
