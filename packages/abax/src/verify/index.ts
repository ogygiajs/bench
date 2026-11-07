import { availableParallelism } from 'node:os';
import { app_checks } from './app.ts';
import { key_checks } from './keys.ts';
import { time_checks } from './time.ts';
import { VERIFY_LAYERS } from './types.ts';
import type { Check, VerifyLayer, VerifyRow } from './types.ts';

/*
 * `abax verify` (spec 12): every planted case of every layer, measured by the CLI the way CI
 * measures a PR, and checked against what Abax must say. A planted slowdown must be flagged where
 * it was planted (and nowhere else); a planted no-op must stay quiet.
 *
 *   steps     extra loop, extra allocation, quadratic helper; rename, comments, reorder, formatting
 *   elision   an allocation the engine removes: counted, shown, never called a regression
 *   leak      a module-level array that keeps every row; its twin keeps only the last. A closure
 *             cache keyed by the row object; its twin is keyed by row id (twenty entries)
 *   engine    shape order, int -> double, delete, megamorphic access; their same-line twins; no-ops
 *   growth    linear -> quadratic; a constant factor that is not a class change
 *   search    quadratic inputs found; a linear function has none
 *   app       a change ranked by real-app weight: hot shown, cold small suppressed, cold large shown
 *   time      the time layer's verdict and the steps agree: slower, faster, same
 *
 * Deterministic layers run a few at a time; the timing-sensitive ones (real bytes, leaks, time) run
 * one at a time after them, with nothing else in flight.
 */

export type { VerifyRow, VerifyLayer } from './types.ts';
export { VERIFY_LAYERS } from './types.ts';

export interface VerifyOptions {
	layers?: VerifyLayer[];
	/** Deterministic checks in flight at once (default: half the cores, 2..6). */
	jobs?: number;
	filter?: string;
	log?: (row: VerifyRow) => void;
}

export function all_checks(): Check[] {
	return [...key_checks(), ...app_checks(), ...time_checks()];
}

async function run_one(c: Check): Promise<VerifyRow> {
	const t0 = performance.now();
	let got: string;
	let pass: boolean;
	try {
		({ pass, got } = await c.run());
	} catch (e) {
		pass = false;
		got = `error: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`;
	}
	return {
		layer: c.layer,
		name: c.name,
		what: c.what,
		planted: c.planted,
		expect: c.expect,
		got,
		pass,
		ms: Math.round(performance.now() - t0)
	};
}

export async function run_verify(o: VerifyOptions = {}): Promise<VerifyRow[]> {
	const layers = new Set(o.layers ?? VERIFY_LAYERS);
	const checks = all_checks().filter(
		(c) =>
			layers.has(c.layer) && (!o.filter || c.name.includes(o.filter) || c.layer.includes(o.filter))
	);
	const rows = new Map<Check, VerifyRow>();
	const shared = checks.filter((c) => !c.exclusive);
	const jobs = o.jobs ?? Math.max(2, Math.min(6, availableParallelism() >> 1));
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(jobs, shared.length) }, async () => {
			while (next < shared.length) {
				const c = shared[next++];
				const row = await run_one(c);
				rows.set(c, row);
				o.log?.(row);
			}
		})
	);
	for (const c of checks.filter((x) => x.exclusive)) {
		const row = await run_one(c);
		rows.set(c, row);
		o.log?.(row);
	}
	const order = VERIFY_LAYERS;
	return checks
		.map((c) => rows.get(c)!)
		.sort((a, b) => order.indexOf(a.layer) - order.indexOf(b.layer));
}

const cell = (s: string) => s.replaceAll('|', '\\|').replaceAll('\n', ' ');

/** The pass table, as markdown (a job summary) or plain lines (a terminal). */
export function render_verify(rows: readonly VerifyRow[], markdown = true): string {
	const passed = rows.filter((r) => r.pass).length;
	const head = `Abax verify: ${passed} of ${rows.length} planted cases pass`;
	if (!markdown) {
		const w = Math.max(...rows.map((r) => `${r.layer}/${r.name}`.length));
		return [
			head,
			...rows.map(
				(r) =>
					`${r.pass ? 'pass' : 'FAIL'}  ${`${r.layer}/${r.name}`.padEnd(w)}  ${r.planted ? 'planted' : 'no-op  '}  ${r.got}${r.pass ? '' : `   (expected: ${r.expect})`}`
			)
		].join('\n');
	}
	const out = [
		`### ${head}`,
		'',
		'| | Layer | Case | Planted | Expected | Abax said | Time |',
		'| --- | --- | --- | --- | --- | --- | ---: |'
	];
	for (const r of rows) {
		out.push(
			`| ${r.pass ? '✅' : '❌'} | ${r.layer} | ${cell(r.name)} | ${r.planted ? 'slowdown' : 'no-op'} | ${cell(r.expect)} | ${cell(r.got)} | ${(r.ms / 1000).toFixed(1)} s |`
		);
	}
	return out.join('\n') + '\n';
}
