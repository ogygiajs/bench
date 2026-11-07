import type { CaseReport } from '../report.ts';

/*
 * The determinism self-check of an app run: the same phase counted twice must give the same
 * counts, function by function. A function whose calls, steps, allocations or bytes differ between
 * the two runs is "unstable" (a finding in itself: hidden state, a real clock, a race).
 */

export interface UnstableFunction {
	id: string;
	a: { calls: number; self_steps: number; allocations: number };
	b: { calls: number; self_steps: number; allocations: number };
}

const EPS = 1e-6;

export function unstable_functions(a: CaseReport, b: CaseReport): UnstableFunction[] {
	const out: UnstableFunction[] = [];
	const zero = { calls: 0, self_steps: 0, allocations: 0, bytes: 0 };
	const by_id = new Map(b.functions.map((f) => [f.id, f]));
	const seen = new Set<string>();
	const check = (id: string, fa: typeof zero, fb: typeof zero): void => {
		if (
			fa.calls !== fb.calls ||
			Math.abs(fa.self_steps - fb.self_steps) > EPS ||
			fa.allocations !== fb.allocations ||
			Math.abs(fa.bytes - fb.bytes) > EPS
		) {
			out.push({
				id,
				a: { calls: fa.calls, self_steps: fa.self_steps, allocations: fa.allocations },
				b: { calls: fb.calls, self_steps: fb.self_steps, allocations: fb.allocations }
			});
		}
	};
	for (const fa of a.functions) {
		seen.add(fa.id);
		check(fa.id, fa, by_id.get(fa.id) ?? zero);
	}
	for (const fb of b.functions) if (!seen.has(fb.id)) check(fb.id, zero, fb);
	return out.sort((x, y) => (x.id < y.id ? -1 : 1));
}
