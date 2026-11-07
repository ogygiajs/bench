import { StepCapError } from '../src/runtime/index.ts';
import type { Program } from './gen.ts';
import type { Lab } from './lab.ts';
import type { Failure } from './check.ts';
import { Rng } from './rng.ts';

/*
 * Oracle 8, the runtime under stress: each program runs under a step cap somewhere inside its
 * whole run (a runaway loop's fate), then again without one. The capped run must end (with a
 * StepCapError, or normally when the program caught it and had nothing left that counts), leave
 * the shadow stack empty and the cap off, and the run after it must count exactly what a run of a
 * fresh copy counts: nothing of the capped run is left behind.
 */

export async function check_runtime(
	lab: Lab,
	prog: Program
): Promise<{ failures: Failure[]; runs: number }> {
	const failures: Failure[] = [];
	const fail = (detail: string): void => void failures.push({ oracle: 'runtime', detail });
	const rt = lab.rt;
	const rng = new Rng(prog.seed * 13 + 5);
	const full = await lab.counted(lab.load(prog.source, prog.lang));
	const total = full.snap.steps;
	if (prog.deep || total < 10) return { failures, runs: 1 };
	const cap = 1 + rng.int(Math.max(1, Math.floor(total)));

	const l = lab.load(prog.source, prog.lang);
	let thrown: unknown = null;
	lab.around = { before: () => void (rt.cap = cap) };
	try {
		const c = await lab.counted(l);
		if (!c.trace.end.startsWith('StepCapError') && !c.trace.end.startsWith('return'))
			thrown = c.trace.end;
	} catch (e) {
		thrown = e;
	} finally {
		lab.around = {};
		// async work the cut-short run left behind (a sibling of a Promise.all) is still running:
		// it ends at the cap too before the next run starts, or it would count in that one
		for (let i = 0; i < 50; i++) await new Promise<void>((r) => setImmediate(r));
		rt.cap = Infinity;
	}
	if (thrown !== null && !(thrown instanceof StepCapError) && typeof thrown !== 'string')
		fail(`a capped run (${cap} of ${total} steps) crashed: ${String(thrown)}`);
	if (rt.depth !== 0) fail(`after a capped run the shadow stack is ${rt.depth} deep`);

	const again = await lab.counted(l, true);
	if (
		JSON.stringify(again.report) !==
		JSON.stringify(full.report).split(full.module.meta.id).join(l.module_id)
	)
		fail(`after a capped run (${cap} of ${total} steps) a new run counts differently`);
	return { failures, runs: 3 };
}
