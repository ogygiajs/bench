import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { serialize } from 'node:v8';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile_svelte, is_svelte_module, is_ts, ts_to_js } from '../transform/index.ts';
import { record_transform } from './record-transform.ts';
import { load_records, replay } from './recorder.ts';
import type { FunctionRecord, ReplayResult } from './recorder.ts';

/*
 * Replaying what a test run recorded (spec 8): the sample files of every test process merged into
 * one record per function, then each recorded module loaded again (in this process, with the
 * recording transform, so its functions are callable by id) and every sample called once more.
 * The output must come back the same, else the function reads state its inputs do not carry.
 */

const MAX_SAMPLES = 5;

function key_of(s: FunctionRecord['samples'][number]): string {
	return createHash('sha1')
		.update(serialize([s.args, s.this_value]))
		.digest('hex');
}

/** One record per function from the records of many processes (samples deduplicated by input). */
export function merge_records(lists: ReadonlyArray<readonly FunctionRecord[]>): FunctionRecord[] {
	const out = new Map<
		string,
		FunctionRecord & { keys: Map<string, FunctionRecord['samples'][number]> }
	>();
	for (const list of lists) {
		for (const r of list) {
			let m = out.get(r.id);
			if (!m) {
				m = { id: r.id, calls: 0, uncloneable: 0, inconsistent: 0, samples: [], keys: new Map() };
				out.set(r.id, m);
			}
			m.calls += r.calls;
			m.uncloneable += r.uncloneable;
			m.inconsistent += r.inconsistent;
			for (const s of r.samples) {
				const k = key_of(s);
				const earlier = m.keys.get(k);
				if (earlier) {
					const same =
						earlier.threw || s.threw
							? JSON.stringify(earlier.threw) === JSON.stringify(s.threw)
							: isDeepStrictEqual(earlier.out, s.out);
					if (!same) m.inconsistent++;
					continue;
				}
				if (m.samples.length >= MAX_SAMPLES) continue;
				m.keys.set(k, s);
				m.samples.push(s);
			}
		}
	}
	return [...out.values()].map(({ keys: _keys, ...r }) => r).sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Every `*.bin` sample file under `dir`, merged. */
export function read_record_dir(dir: string): FunctionRecord[] {
	const files = readdirSync(dir).filter((f) => f.endsWith('.bin'));
	return merge_records(files.map((f) => load_records(join(dir, f))));
}

function module_of(id: string): string {
	return id.slice(0, id.indexOf(' > '));
}

/**
 * Replay `records` against the modules under `root` they name (module ids are paths relative to
 * root). A module that fails to load makes its functions `not replayable`.
 */
export async function replay_records(
	root: string,
	records: readonly FunctionRecord[],
	log: (line: string) => void = () => {}
): Promise<ReplayResult[]> {
	const by_module = new Map<string, FunctionRecord[]>();
	for (const r of records) {
		const m = module_of(r.id);
		by_module.set(m, [...(by_module.get(m) ?? []), r]);
	}
	const targets = new Map<string, { id: string; paths: Set<string> }>();
	for (const [m, list] of by_module) {
		targets.set(join(root, m), {
			id: m,
			paths: new Set(list.map((r) => r.id.slice(m.length + 3)))
		});
	}
	registerHooks({
		load(url, context, next) {
			if (!url.startsWith('file:')) return next(url, context);
			const file = fileURLToPath(url);
			const t = targets.get(file);
			if (!t) {
				// a recorded module may import Svelte files; Node cannot load them as they are
				if (!is_svelte_module(file) || file.includes('/node_modules/')) return next(url, context);
				const out = compile_svelte(readFileSync(file, 'utf8'), file, 'server');
				return { format: 'module', source: out.code, shortCircuit: true };
			}
			const source = readFileSync(file, 'utf8');
			const code = is_svelte_module(file)
				? compile_svelte(source, file, 'server').code
				: is_ts(file)
					? ts_to_js(source, file).code
					: source;
			const r = record_transform(code, { filename: file, id: t.id, targets: t.paths });
			return { format: 'module', source: r.code, shortCircuit: true };
		}
	});
	const out: ReplayResult[] = [];
	for (const [m, list] of [...by_module].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
		let fns: Record<string, unknown>;
		try {
			const mod = (await import(pathToFileURL(join(root, m)).href)) as {
				__heisenbench_rec_fns?: Record<string, unknown>;
			};
			fns = mod.__heisenbench_rec_fns ?? {};
		} catch (e) {
			log(`replay: ${m} does not load here: ${(e as Error).message.split('\n')[0]}`);
			for (const r of list) {
				out.push({
					id: r.id,
					status:
						r.samples.length === 0
							? r.uncloneable > 0
								? 'not cloneable'
								: 'no samples'
							: 'not replayable',
					samples: r.samples.length,
					mismatches: 0
				});
			}
			continue;
		}
		out.push(...replay(list, fns));
	}
	return out;
}
