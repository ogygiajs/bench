import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { brotliDecompress } from 'node:zlib';
import { createDecipheriv, scrypt } from 'node:crypto';
import { FrameMapper, PSEUDO_FRAMES } from './frames.ts';
import type { Frame, FrameMapperOptions } from './frames.ts';
import { WEIGHTS_SCHEMA, canonical_function } from './weights.ts';
import type { AppWeights, FunctionWeight, Traffic } from './weights.ts';

/*
 * Real-traffic weights: what each counted function costs a real request, from production
 * profiles. The output is a weights file (weights.ts) with one unit, `real request`, whose function
 * weights carry the measured self and total ns per request, the samples behind them, and counted
 * calls when the profile counted them. The cost model (cost.ts) turns a change found by a bench
 * into CPU time on that traffic.
 *
 * Three inputs:
 *
 *   .cpuprofile          V8's CPU profile (`node --cpu-prof`, the inspector, DevTools): sampled.
 *                        Self time per frame from the samples and their time deltas; total time
 *                        counts a function once per sampled stack. It does not say how many
 *                        requests it covered: `requests` must be given.
 *   ogygia profiler      a report dump (`ogygia-profiler-dump`, plain JSON or `.ogp`, decrypted
 *                        with the profiler's secret), or the curated report JSON
 *                        (`ogygia-profiler-report`, its hot functions only). Per function self and
 *                        total ms, calls when V8 precise coverage counted them, the window, and
 *                        the requests it served.
 *   heisenbench-traffic  the format anyone can produce (README "Real traffic"):
 *                          { "schema": "heisenbench-traffic/1", "requests": 1200,
 *                            "window_ms": 600000, "start": "...", "end": "...",
 *                            "functions": [{ "id": "packages/core/src/router/match.ts > match",
 *                                            "self_ms": 120.5, "total_ms": 300, "calls": 4800,
 *                                            "samples": 241 }] }
 *                        where a function is named by its Heisenbench id, or by a frame
 *                        (`"url", "name", "line"` 1-based, `"col"` 0-based) to be mapped here.
 *
 * Nothing about a request is read or kept: no URL, header, cookie or body. Only function ids,
 * times, counts, and the number of requests and the recording window.
 *
 * Profiles are summed in the order of their contents' hashes, so the same files give the same
 * weights file in any order.
 */

export const TRAFFIC_SCHEMA = 'heisenbench-traffic/1';
export const TRAFFIC_UNIT = 'real request';
/** Unmatched frames listed in the file. */
const TOP_UNMATCHED = 10;

/** One function's numbers in one profile, before it is mapped. */
interface Row {
	frame: Frame | null;
	/** A Heisenbench id given as is (the simple format). */
	id: string | null;
	self_ms: number;
	total_ms: number;
	samples: number;
	calls: number | null;
}

export interface Profile {
	format: 'cpuprofile' | 'ogygia' | 'json';
	rows: Row[];
	/** null: the profile does not say (a .cpuprofile). */
	requests: number | null;
	window_ms: number;
	start: string | null;
	end: string | null;
	/** Sampled time of frames that are no code at all ((idle), (program), (root)): left out. */
	pseudo_ms: number;
}

interface CpuNode {
	id: number;
	callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
	children?: number[];
}

interface CpuProfile {
	nodes: CpuNode[];
	startTime: number;
	endTime: number;
	samples: number[];
	timeDeltas: number[];
}

function is_cpuprofile(x: unknown): x is CpuProfile {
	const p = x as Partial<CpuProfile> | null;
	return !!p && Array.isArray(p.nodes) && Array.isArray(p.samples) && Array.isArray(p.timeDeltas);
}

/**
 * A V8 CPU profile's self and total time per frame. Sample `i` lasted until the next one
 * (`timeDeltas[i + 1]`); the last one lasted the mean interval. Frames of one function (the same
 * URL, line, column and name, under different callers) add up; total time counts a frame once per
 * stack, so recursion is not counted twice.
 */
export function read_cpuprofile(p: CpuProfile): Profile {
	const by_id = new Map<number, CpuNode>();
	const parent = new Map<number, number>();
	for (const n of p.nodes) {
		by_id.set(n.id, n);
		for (const c of n.children ?? []) parent.set(c, n.id);
	}
	const n = p.samples.length;
	const span = p.timeDeltas.slice(1).reduce((a, b) => a + b, 0);
	const mean = n > 1 ? span / (n - 1) : 0;
	const key_of = (node: CpuNode) => {
		const f = node.callFrame;
		return `${f.url}\u0000${f.lineNumber}\u0000${f.columnNumber}\u0000${f.functionName}`;
	};
	const rows = new Map<string, Row>();
	let pseudo_us = 0;
	for (let i = 0; i < n; i++) {
		const us = Math.max(0, i + 1 < n ? p.timeDeltas[i + 1] : mean);
		const leaf = by_id.get(p.samples[i]);
		if (!leaf) continue;
		const lf = leaf.callFrame;
		if (PSEUDO_FRAMES.has(lf.functionName) && lf.url === '') {
			pseudo_us += us;
			continue;
		}
		const seen = new Set<string>();
		for (let node: CpuNode | undefined = leaf; node; node = by_id.get(parent.get(node.id) ?? -1)) {
			const f = node.callFrame;
			if (PSEUDO_FRAMES.has(f.functionName) && f.url === '') continue;
			const key = key_of(node);
			let row = rows.get(key);
			if (!row) {
				row = {
					frame: { url: f.url, name: f.functionName, line: f.lineNumber + 1, col: f.columnNumber },
					id: null,
					self_ms: 0,
					total_ms: 0,
					samples: 0,
					calls: null
				};
				rows.set(key, row);
			}
			if (node === leaf) {
				row.self_ms += us / 1000;
				row.samples++;
			}
			if (!seen.has(key)) {
				seen.add(key);
				row.total_ms += us / 1000;
			}
		}
	}
	return {
		format: 'cpuprofile',
		rows: [...rows.values()],
		requests: null,
		window_ms: Math.max(0, (p.endTime - p.startTime) / 1000),
		start: null,
		end: null,
		pseudo_ms: pseudo_us / 1000
	};
}

interface OgygiaFrame {
	name: string;
	path?: string;
	url?: string;
	file?: string;
	line: number;
	col?: number;
	column?: number | null;
	self_ms: number;
	total_ms: number;
	calls?: number;
}

interface OgygiaDump {
	kind: 'ogygia-profiler-dump';
	meta: {
		created: number;
		trigger: string;
		duration_ms: number;
		sample_interval_us: number;
		requests?: Array<{ internal?: boolean }>;
		runs?: number[];
	};
	analysis: { duration_ms?: number; functions: OgygiaFrame[] };
}

interface OgygiaReport {
	schema: 'ogygia-profiler-report';
	target?: { runs?: number[] | null; request?: unknown };
	summary: { window_ms: number; sample_count?: number };
	hot_functions: OgygiaFrame[];
	meta?: { created?: number; trigger?: string; requests?: number; sample_interval_us?: number };
}

function is_ogygia_dump(x: unknown): x is OgygiaDump {
	const d = x as Partial<OgygiaDump> | null;
	return !!d && d.kind === 'ogygia-profiler-dump' && !!d.meta && !!d.analysis;
}

function is_ogygia_report(x: unknown): x is OgygiaReport {
	const r = x as Partial<OgygiaReport> | null;
	return !!r && r.schema === 'ogygia-profiler-report' && Array.isArray(r.hot_functions);
}

/** The requests an ogygia profile covered: its renders, its one request, or the window's. */
function ogygia_requests(trigger: string, runs: unknown, requests: unknown): number {
	if (trigger === 'page' && Array.isArray(runs)) return runs.length;
	if (trigger === 'request' || trigger === 'trap') return 1;
	if (Array.isArray(requests))
		return requests.filter((r) => !(r as { internal?: boolean })?.internal).length;
	return typeof requests === 'number' ? requests : 0;
}

function ogygia_row(f: OgygiaFrame, interval_us: number): Row | null {
	const name = f.name ?? '';
	if (PSEUDO_FRAMES.has(name)) return null;
	// a component row merges a component's frames under `C:<name>`: its file and line still say where
	const url = f.path ?? f.url ?? f.file ?? '';
	const col = f.col ?? f.column ?? 0;
	return {
		frame: {
			url,
			name: name === '(anonymous)' ? '' : name,
			line: f.line,
			col: col > 0 ? col - 1 : 0
		},
		id: null,
		self_ms: f.self_ms,
		total_ms: f.total_ms,
		samples: interval_us > 0 ? (f.self_ms * 1000) / interval_us : 0,
		calls: typeof f.calls === 'number' ? f.calls : null
	};
}

export function read_ogygia(x: OgygiaDump | OgygiaReport): Profile {
	if (is_ogygia_dump(x)) {
		const m = x.meta;
		const window_ms = m.duration_ms ?? x.analysis.duration_ms ?? 0;
		const rows = x.analysis.functions
			.map((f) => ogygia_row(f, m.sample_interval_us ?? 0))
			.filter((r): r is Row => r !== null);
		return {
			format: 'ogygia',
			rows,
			requests: ogygia_requests(m.trigger, m.runs, m.requests),
			window_ms,
			start: typeof m.created === 'number' ? new Date(m.created).toISOString() : null,
			end: typeof m.created === 'number' ? new Date(m.created + window_ms).toISOString() : null,
			pseudo_ms: 0
		};
	}
	const meta = x.meta ?? {};
	const window_ms = x.summary.window_ms;
	const interval = meta.sample_interval_us ?? 0;
	return {
		format: 'ogygia',
		rows: x.hot_functions.map((f) => ogygia_row(f, interval)).filter((r): r is Row => r !== null),
		requests: ogygia_requests(
			meta.trigger ?? (x.target?.runs ? 'page' : x.target?.request ? 'request' : 'window'),
			x.target?.runs,
			meta.requests
		),
		window_ms,
		start: typeof meta.created === 'number' ? new Date(meta.created).toISOString() : null,
		end: typeof meta.created === 'number' ? new Date(meta.created + window_ms).toISOString() : null,
		pseudo_ms: 0
	};
}

interface TrafficFile {
	schema: typeof TRAFFIC_SCHEMA;
	requests: number;
	window_ms?: number;
	start?: string | null;
	end?: string | null;
	functions: Array<{
		id?: string;
		url?: string;
		name?: string;
		line?: number;
		col?: number;
		self_ms: number;
		total_ms?: number;
		calls?: number;
		samples?: number;
	}>;
}

export function read_traffic(x: TrafficFile, file: string): Profile {
	if (!(x.requests >= 0)) throw new Error(`heisenbench: ${file}: "requests" must be a number`);
	return {
		format: 'json',
		rows: x.functions.map((f) => {
			if (!f.id && !f.url)
				throw new Error(`heisenbench: ${file}: a function needs an "id" or a "url"`);
			return {
				frame: f.id
					? null
					: { url: f.url!, name: f.name ?? '', line: f.line ?? 1, col: f.col ?? 0 },
				id: f.id ?? null,
				self_ms: f.self_ms,
				total_ms: f.total_ms ?? f.self_ms,
				samples: f.samples ?? 0,
				calls: typeof f.calls === 'number' ? f.calls : null
			};
		}),
		requests: x.requests,
		window_ms: x.window_ms ?? 0,
		start: x.start ?? null,
		end: x.end ?? null,
		pseudo_ms: 0
	};
}

const OGP_MAGIC = 'OGP1';
const OGP_DEV_KEY = 'ogygia-profiler-dev-key';

/**
 * An `.ogp` file: 'OGP1', salt (16), iv (12), AES-256-GCM ciphertext of the Brotli-compressed dump,
 * tag (16); the key is scrypt(secret, salt, 32). Without a secret, the profiler's dev key.
 */
export async function decode_ogp(bytes: Buffer, secret: string | undefined): Promise<unknown> {
	const salt = bytes.subarray(4, 20);
	const iv = bytes.subarray(20, 32);
	const tag = bytes.subarray(bytes.length - 16);
	const ct = bytes.subarray(32, bytes.length - 16);
	const key = (await promisify(scrypt)(secret || OGP_DEV_KEY, salt, 32)) as Buffer;
	const d = createDecipheriv('aes-256-gcm', key, iv);
	d.setAuthTag(tag);
	let plain: Buffer;
	try {
		plain = Buffer.concat([d.update(ct), d.final()]);
	} catch {
		throw new Error(
			'heisenbench: the .ogp does not open with this secret (--secret, or OGYGIA_PROFILER_SECRET)'
		);
	}
	return JSON.parse((await promisify(brotliDecompress)(plain)).toString('utf8'));
}

/** A profile file in any of the three formats; `hash` orders profiles for summing. */
export async function read_profile(
	file: string,
	o: { secret?: string } = {}
): Promise<Profile & { hash: string }> {
	const bytes = readFileSync(file);
	const hash = createHash('sha256').update(bytes).digest('hex');
	let x: unknown;
	if (bytes.subarray(0, 4).toString('latin1') === OGP_MAGIC) {
		x = await decode_ogp(bytes, o.secret);
	} else {
		try {
			x = JSON.parse(bytes.toString('utf8'));
		} catch {
			throw new Error(`heisenbench: ${file} is neither JSON nor an .ogp file`);
		}
	}
	let p: Profile;
	if (is_cpuprofile(x)) p = read_cpuprofile(x);
	else if (is_ogygia_dump(x) || is_ogygia_report(x)) p = read_ogygia(x);
	else if ((x as Partial<TrafficFile> | null)?.schema === TRAFFIC_SCHEMA)
		p = read_traffic(x as TrafficFile, file);
	else
		throw new Error(
			`heisenbench: ${file} is not a .cpuprofile, an ogygia profiler report or a ${TRAFFIC_SCHEMA} file`
		);
	return { ...p, hash };
}

export interface ImportOptions extends Omit<FrameMapperOptions, 'root'> {
	root: string;
	/** Requests the profiles that do not say (a .cpuprofile) covered, all of them together. */
	requests?: number;
	secret?: string;
}

/** Rounded the same way everywhere, so a weights file is the same bytes from the same inputs. */
function r4(n: number): number {
	return Math.round(n * 1e4) / 1e4;
}

/**
 * The weights of real traffic from profiles (already read): one `real request` unit, every
 * mapped function's ns per request, and how much of the sampled time mapped.
 */
export function traffic_weights(
	profiles: ReadonlyArray<Profile & { hash: string }>,
	o: ImportOptions
): AppWeights {
	const mapper = new FrameMapper(o);
	const sorted = [...profiles].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
	const unknown = sorted.filter((p) => p.requests === null);
	if (unknown.length > 0 && !(o.requests !== undefined && o.requests > 0)) {
		throw new Error(
			`heisenbench: ${unknown.length} profile(s) (${unknown[0].format}) do not say how many requests they covered: give --requests`
		);
	}
	let requests = 0;
	let window_ms = 0;
	let sampled_ms = 0;
	let mapped_ms = 0;
	const starts: string[] = [];
	const ends: string[] = [];
	const formats: Record<string, number> = {};
	const sums = new Map<
		string,
		{ self: number; total: number; samples: number; calls: number; counted: boolean; seen: number }
	>();
	const unmatched = new Map<string, { frame: string; reason: string; self_ms: number }>();
	for (const p of sorted) {
		formats[p.format] = (formats[p.format] ?? 0) + 1;
		requests += p.requests ?? 0;
		window_ms += p.window_ms;
		if (p.start) starts.push(p.start);
		if (p.end) ends.push(p.end);
		for (const row of p.rows) {
			sampled_ms += row.self_ms;
			let id: string | null;
			if (row.id !== null) {
				const at = row.id.indexOf(' > ');
				id = at === -1 ? null : canonical_function(row.id.slice(0, at), row.id.slice(at + 3));
			} else {
				const m = mapper.map(row.frame!);
				id = m.id;
				if (m.id === null) {
					const frame = mapper.label(row.frame!);
					const u = unmatched.get(frame) ?? { frame, reason: m.reason, self_ms: 0 };
					u.self_ms += row.self_ms;
					unmatched.set(frame, u);
				}
			}
			if (id === null) continue;
			mapped_ms += row.self_ms;
			const s = sums.get(id) ?? { self: 0, total: 0, samples: 0, calls: 0, counted: true, seen: 0 };
			s.self += row.self_ms;
			s.total += row.total_ms;
			s.samples += row.samples;
			if (row.calls === null) s.counted = false;
			else s.calls += row.calls;
			s.seen++;
			sums.set(id, s);
		}
	}
	if (unknown.length > 0) requests += o.requests!;
	const per = Math.max(requests, 1);
	const functions: AppWeights['functions'] = {};
	for (const id of [...sums.keys()].sort()) {
		const s = sums.get(id)!;
		const w: FunctionWeight = {
			calls: s.counted ? r4(s.calls / per) : 0,
			self_steps: 0,
			inclusive_steps: 0,
			self_ns: r4((s.self * 1e6) / per),
			total_ns: r4((s.total * 1e6) / per),
			samples: Math.round(s.samples),
			calls_counted: s.counted
		};
		functions[id] = { [TRAFFIC_UNIT]: w };
	}
	// A function the profile lists under each caller adds up above; a total over its callers
	// cannot exceed the window, but callers' totals can overlap: they are kept as given.
	const traffic: Traffic = {
		profiles: Object.fromEntries(Object.entries(formats).sort()),
		requests,
		window_ms: r4(window_ms),
		start: starts.length ? starts.sort()[0] : null,
		end: ends.length ? ends.sort()[ends.length - 1] : null,
		sampled_ms: r4(sampled_ms),
		mapped_ms: r4(mapped_ms),
		unmatched: [...unmatched.values()]
			.sort((a, b) => b.self_ms - a.self_ms || (a.frame < b.frame ? -1 : 1))
			.slice(0, TOP_UNMATCHED)
			.map((u) => ({ ...u, self_ms: r4(u.self_ms) }))
	};
	return {
		schema: WEIGHTS_SCHEMA,
		source: { sha: null, ogygia: {}, scenarios: [] },
		units: { [TRAFFIC_UNIT]: { steps: 0, units: requests, side: 'server', traffic } },
		functions
	};
}

/** `heisenbench weights import`: read every profile, then weigh. */
export async function import_traffic(
	files: readonly string[],
	o: ImportOptions
): Promise<AppWeights> {
	const profiles = [];
	for (const f of files) profiles.push(await read_profile(f, { secret: o.secret }));
	return traffic_weights(profiles, o);
}
