import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cases, set_current_file } from '../bench.ts';
import { one_line } from '../report.ts';
import { recorder } from './recorder.ts';
import { register_record_hooks } from './replay-run.ts';

/*
 * Bench cases as a source of recorded calls (`heisenbench record`). A test run is not the only
 * program that calls a project's functions with real inputs: every bench case does too, often at
 * sizes no test reaches (a page with twenty islands). This runs each case once, uncounted, with the
 * recording transform on the target modules, and saves what the recorder kept in the sample-file
 * format a test run writes, so growth from recorded calls (growth/recorded.ts) and the gate's
 * replay read both the same way.
 */

export interface RecordBenchesOptions {
	files: string[];
	root: string;
	/** `module id -> function paths` to record (the inventory's targets file). */
	targets: Record<string, string[]>;
	/** The sample file to write. */
	out: string;
	/**
	 * Factors a case that declares `scale` runs at too (its input grown by its own scaler), so the
	 * recorder sees the sizes a growth case would (`heisenbench prove --bench`). Default: none.
	 */
	scales?: number[];
	log?: (line: string) => void;
}

/** Run every case of `files` once with the recorder on; returns how many ran and failed. */
export async function record_benches(
	o: RecordBenchesOptions
): Promise<{ ran: number; failed: number }> {
	const root = resolve(o.root);
	const log = o.log ?? (() => {});
	register_record_hooks(
		new Map(
			Object.entries(o.targets).map(([m, paths]) => [
				join(root, m),
				{ id: m, paths: new Set(paths) }
			])
		),
		root
	);
	recorder.reset();
	const start = cases().length;
	for (const f of o.files) {
		const abs = resolve(f);
		set_current_file(relative(root, abs).split(sep).join('/'));
		try {
			await import(pathToFileURL(abs).href);
		} catch (e) {
			log(`FAILED   ${f}: ${one_line(e)}`);
		}
	}
	let ran = 0;
	let failed = 0;
	for (const c of cases().slice(start)) {
		try {
			const ctx = c.setup ? await c.setup() : undefined;
			await c.fn(ctx);
			if (c.teardown) await c.teardown(ctx);
			for (const k of c.scale ? (o.scales ?? []).filter((k) => k !== 1) : []) {
				const grown = c.scale!(c.setup ? await c.setup() : undefined, k);
				await c.fn(grown);
				if (c.teardown) await c.teardown(grown);
			}
			ran++;
		} catch (e) {
			failed++;
			log(`FAILED   ${c.name}: ${one_line(e)}`);
		}
	}
	recorder.save(o.out);
	recorder.reset();
	return { ran, failed };
}

export function read_targets(path: string): Record<string, string[]> {
	return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string[]>;
}
