import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { serialize } from 'node:v8';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile_svelte, is_svelte_module, is_ts, ts_to_js } from '../transform/index.ts';
import { record_transform } from './record-transform.ts';
import { SIZE_BANDS, load_records, replay, size_band } from './recorder.ts';
import type { FunctionRecord, ReplayResult } from './recorder.ts';

/*
 * Replaying what a test run recorded (spec 8): the sample files of every test process merged into
 * one record per function, then each recorded module loaded again (in this process, with the
 * recording transform, so its functions are callable by id) and every sample called once more.
 * The output must come back the same, else the function reads state its inputs do not carry.
 */

const MAX_SAMPLES = 5;

type Sample = FunctionRecord['samples'][number];

function key_of(s: Sample): string {
	return createHash('sha1')
		.update(serialize([s.args, s.this_value]))
		.digest('hex');
}

function total(s: Sample): number | null {
	if (!s.sizes) return null;
	let n = 0;
	for (const x of s.sizes) n += x;
	return n;
}

/**
 * The samples a merged record keeps, the same whatever order the files came in: one per size band
 * (the largest input in it; past SIZE_BANDS bands, bands spread evenly from the smallest to the
 * largest), then the smallest faithful samples (no stand-ins) up to MAX_SAMPLES more. Ordered by
 * size, then by each argument's size, then key.
 */
function keep(samples: Map<string, Sample>): Sample[] {
	// Ordered by size before key: inputs a test builds with a temporary path or a random name
	// differ in content (their key) from run to run, not in size, so the choice holds across runs.
	const sizes = (s: Sample): string =>
		(s.sizes ?? []).map((n) => String(n).padStart(12, '0')).join();
	const by_key = [...samples].sort(
		(a, b) =>
			(total(a[1]) ?? -1) - (total(b[1]) ?? -1) ||
			(sizes(a[1]) < sizes(b[1]) ? -1 : sizes(a[1]) > sizes(b[1]) ? 1 : 0) ||
			(a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
	);
	const bands = new Map<number, [string, Sample]>();
	for (const e of by_key) {
		const t = total(e[1]);
		if (t === null) continue;
		const b = size_band(t);
		const held = bands.get(b);
		// the largest input of the band, a faithful one before a stand-in
		if (!held || held[1].stand_ins || !e[1].stand_ins) bands.set(b, e);
	}
	let band_list = [...bands].sort((a, b) => a[0] - b[0]).map(([, e]) => e);
	if (band_list.length > SIZE_BANDS) {
		const n = band_list.length;
		const picked = new Set<number>();
		for (let i = 0; i < SIZE_BANDS; i++) picked.add(Math.round((i * (n - 1)) / (SIZE_BANDS - 1)));
		band_list = [...picked].sort((a, b) => a - b).map((i) => band_list[i]);
	}
	const chosen = new Map<string, Sample>(band_list);
	let extra = 0;
	for (const [k, s] of by_key) {
		if (extra >= MAX_SAMPLES) break;
		if (chosen.has(k) || s.stand_ins) continue;
		chosen.set(k, s);
		extra++;
	}
	return [...chosen]
		.sort((a, b) => (total(a[1]) ?? -1) - (total(b[1]) ?? -1) || (a[0] < b[0] ? -1 : 1))
		.map(([, s]) => s);
}

/** One record per function from the records of many processes (samples deduplicated by input). */
export function merge_records(lists: ReadonlyArray<readonly FunctionRecord[]>): FunctionRecord[] {
	const out = new Map<string, FunctionRecord & { keys: Map<string, Sample> }>();
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
			if (r.sizes) {
				if (!m.sizes) m.sizes = { ...r.sizes };
				else {
					m.sizes.sized += r.sizes.sized;
					m.sizes.min = Math.min(m.sizes.min, r.sizes.min);
					m.sizes.max = Math.max(m.sizes.max, r.sizes.max);
				}
			}
			for (const s of r.samples) {
				const k = key_of(s);
				const earlier = m.keys.get(k);
				if (earlier) {
					if (earlier.stand_ins || s.stand_ins) {
						// keep the faithful one of the two
						if (earlier.stand_ins && !s.stand_ins) m.keys.set(k, s);
						continue;
					}
					const same =
						earlier.threw || s.threw
							? JSON.stringify(earlier.threw) === JSON.stringify(s.threw)
							: isDeepStrictEqual(earlier.out, s.out);
					if (!same) m.inconsistent++;
					continue;
				}
				m.keys.set(k, s);
			}
		}
	}
	return [...out.values()]
		.map(({ keys, ...r }) => ({ ...r, samples: keep(keys) }))
		.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Records of one module under another module's id, merged with that module's own: a built module
 * (`pkg/dist/x.js`) whose functions the tests called is recorded as its source (`pkg/src/x.ts`)
 * when the build keeps each source file's functions and their names. `aliases` maps module ids.
 */
export function alias_records(
	records: readonly FunctionRecord[],
	aliases: Readonly<Record<string, string>>
): FunctionRecord[] {
	const renamed = records.map((r) => {
		const m = module_of(r.id);
		const to = Object.prototype.hasOwnProperty.call(aliases, m) ? aliases[m] : undefined;
		return to === undefined ? r : { ...r, id: to + r.id.slice(m.length) };
	});
	// each record its own list: merge_records joins the ones that now share an id
	return merge_records(renamed.map((r) => [r]));
}

/** Every `*.bin` sample file under `dir`, merged (in name order; the merge does not depend on it). */
export function read_record_dir(dir: string): FunctionRecord[] {
	const files = readdirSync(dir)
		.filter((f) => f.endsWith('.bin'))
		.sort();
	return merge_records(files.map((f) => load_records(join(dir, f))));
}

/**
 * Load every module of `targets` (absolute file -> its id and the function paths to wrap) with the
 * recording transform, in this thread, from now on. Svelte files are compiled for the server
 * (Node cannot load them as they are); everything else loads as Node loads it.
 */
export function register_record_hooks(
	targets: ReadonlyMap<string, { id: string; paths: ReadonlySet<string> | undefined }>,
	/**
	 * Bench files import private functions (`__heisenbench`): with a root, every source module
	 * under it (outside node_modules) exports them, the targets with their functions recorded.
	 */
	expose_under?: string
): void {
	const prefix = expose_under === undefined ? null : expose_under.replace(/\/?$/, '/');
	registerHooks({
		load(url, context, next) {
			if (!url.startsWith('file:')) return next(url, context);
			const file = fileURLToPath(url);
			const t = targets.get(file);
			const own =
				prefix !== null &&
				file.startsWith(prefix) &&
				!file.includes('/node_modules/') &&
				/\.(m?[jt]s|svelte)$/.test(file) &&
				!file.endsWith('.d.ts');
			if (!t && !own) {
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
			const r = record_transform(code, {
				filename: file,
				id: t?.id ?? file,
				targets: t?.paths ?? new Set(),
				expose: prefix !== null
			});
			return { format: 'module', source: r.code, shortCircuit: true };
		}
	});
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
	register_record_hooks(targets);
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
