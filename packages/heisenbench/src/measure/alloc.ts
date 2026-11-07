import { Session } from 'node:inspector/promises';
import type { BenchCase } from '../bench.ts';
import { Attributor } from './attribute.ts';

/*
 * Real bytes (spec 4, second half): what V8 actually allocates, on the plain build, next to the
 * counting build's estimate (layout.ts).
 *
 * The case is warmed until its code is optimized, then run in batches under the sampling heap
 * profiler (HeapProfiler.startSampling) with a small interval and with objects later collected by
 * minor and major GCs kept in the profile: every allocation counts, not only what survives. V8
 * scales each sample by its probability, so a node's selfSize is an unbiased estimate of the bytes
 * allocated there. Setup and teardown run between batches, outside sampling.
 *
 * Attribution: a profile node is a call frame (script URL, function position). Each sampled byte is
 * charged to the nearest frame on its stack that belongs to a source module under the root, through
 * built-ins (bytes allocated inside Array.prototype.map are the function's that called it) but not
 * through a dependency (its bytes are its own, as in the counted build): the same scope the
 * estimate covers, whose built-in calls count what their results allocate. Both sides are per
 * call. The child runs without inlining (spawn.ts), so a frame's bytes are its own.
 *
 * The interval grows with what a call allocates (MAX_SAMPLES): the profile of a batch comes back
 * as one string, which a large case would push past the longest string V8 can make.
 *
 * The heap profile is per function, not per line: a function whose estimate is far above its real
 * bytes is a function where the engine elided (escape analysis) or folded allocations; the lines
 * flagged are that function's allocation sites (report side, see elision.ts).
 */

export interface BytesOptions {
	/** Calls before sampling, so the code is optimized as it would be in a hot path (default 2000). */
	warm?: number;
	/** Sampled calls (default 1000). */
	runs?: number;
	/** Calls per batch (setup for the batch first, then the sampled calls). Default 100. */
	batch?: number;
	/** Average bytes between samples (default 32). */
	interval?: number;
}

export interface FunctionBytes {
	id: string;
	module: string;
	path: string;
	line: number;
	/** Real bytes per call of the case. */
	bytes: number;
}

export interface BytesResult {
	runs: number;
	/** Average bytes between samples the batches used (see MAX_SAMPLES). */
	interval?: number;
	/** Real bytes per call charged to source functions under the root. */
	bytes: number;
	/** Bytes per call allocated with no source function on the stack (harness, runtime). */
	other: number;
	functions: FunctionBytes[];
}

interface CallFrame {
	functionName: string;
	url: string;
	lineNumber: number;
	columnNumber: number;
}

interface ProfileNode {
	callFrame: CallFrame;
	selfSize: number;
	children: ProfileNode[];
}

const gc = (globalThis as { gc?: () => void }).gc;

async function run_batch(c: BenchCase, n: number, between?: () => Promise<void>): Promise<void> {
	const ctxs: unknown[] = [];
	for (let i = 0; i < n; i++) ctxs.push(c.setup ? await c.setup() : undefined);
	if (between) await between();
	for (let i = 0; i < n; i++) await c.fn(ctxs[i]);
	if (between) await between();
	if (c.teardown) for (let i = 0; i < n; i++) await c.teardown(ctxs[i]);
}

export async function real_bytes(
	c: BenchCase,
	root: string,
	o: BytesOptions = {}
): Promise<BytesResult> {
	const warm = o.warm ?? 2000;
	const runs = o.runs ?? 1000;
	const batch = o.batch ?? 100;
	// a dependency's functions are counted (and estimated) like the project's: their real bytes are
	// theirs too, or each would read as eliding all it allocates
	const attributor = new Attributor(root, { deps: true });
	for (let done = 0; done < warm; done += batch) await run_batch(c, Math.min(batch, warm - done));
	gc?.();

	const session = new Session();
	session.connect();
	const totals = new Map<string, { node: CallFrame; bytes: number }>();
	let interval = o.interval ?? 32;
	try {
		await session.post('HeapProfiler.enable');
		/** One sampled batch of `n` calls; the profile goes to `into` (or nowhere). */
		const sampled = async (
			n: number,
			every: number,
			into: typeof totals | null
		): Promise<number> => {
			let sampling = false;
			let sum = 0;
			await run_batch(c, n, async () => {
				if (!sampling) {
					await session.post('HeapProfiler.startSampling', {
						samplingInterval: every,
						includeObjectsCollectedByMajorGC: true,
						includeObjectsCollectedByMinorGC: true
					});
					sampling = true;
					return;
				}
				const { profile } = (await session.post('HeapProfiler.stopSampling')) as unknown as {
					profile: { head: ProfileNode };
				};
				sampling = false;
				sum = total_of(profile.head);
				if (into) collect(profile.head, null, into, (url) => attributor.wants(url));
			});
			return sum;
		};
		// The profile comes back as one string, a record per sample: a case that allocates a lot
		// would make one longer than V8 can build. A coarse first look at what a call allocates sets
		// the interval so a batch keeps under MAX_SAMPLES samples (the estimate stays unbiased: V8
		// scales each sample by its probability).
		const probe_calls = Math.min(batch, 10);
		const per_call = (await sampled(probe_calls, PROBE_INTERVAL, null)) / probe_calls;
		while ((per_call * batch) / interval > MAX_SAMPLES) interval *= 2;
		for (let done = 0; done < runs; done += batch) {
			await sampled(Math.min(batch, runs - done), interval, totals);
		}
		await session.post('HeapProfiler.disable');
	} finally {
		session.disconnect();
	}

	const attributor_result = new Map<string, FunctionBytes>();
	let other = 0;
	let bytes = 0;
	for (const [key, t] of totals) {
		if (key === OTHER) {
			other += t.bytes;
			continue;
		}
		const ref = attributor.at(t.node.url, t.node.lineNumber, t.node.columnNumber);
		if (!ref) {
			other += t.bytes;
			continue;
		}
		const f = attributor_result.get(ref.id) ?? { ...ref, bytes: 0 };
		f.bytes += t.bytes;
		attributor_result.set(ref.id, f);
		bytes += t.bytes;
	}
	const functions = [...attributor_result.values()]
		.map((f) => ({ ...f, bytes: round(f.bytes / runs) }))
		.sort((a, b) => b.bytes - a.bytes);
	return {
		runs,
		interval,
		bytes: round(bytes / runs),
		other: round(other / runs),
		functions
	};
}

const OTHER = '<other>';
/** Samples a batch may hold (each is a record in the profile string). */
export const MAX_SAMPLES = 200_000;
/** The interval of the first, coarse look at what a call allocates. */
const PROBE_INTERVAL = 64 * 1024;

function round(n: number): number {
	return Math.round(n * 100) / 100;
}

function total_of(node: ProfileNode): number {
	let sum = node.selfSize;
	for (const ch of node.children) sum += total_of(ch);
	return sum;
}

/**
 * Charge each node's bytes to the function that owns them, the way the estimate counts them: the
 * nearest source function under the root for code that has no script of its own (a built-in,
 * Node's own `node:` modules), and nothing (`OTHER`) for code that has one but is not a source
 * function (a dependency, the bench file, the harness). A dependency's allocations are its own, as
 * in the counted build, where it is not instrumented.
 */
function collect(
	node: ProfileNode,
	owner: CallFrame | null,
	totals: Map<string, { node: CallFrame; bytes: number }>,
	wants: (url: string) => boolean
): void {
	const cf = node.callFrame;
	const url = cf.url;
	const here = !url || url.startsWith('node:') ? owner : wants(url) ? cf : null;
	if (node.selfSize > 0) {
		const key = here ? `${here.url}:${here.lineNumber}:${here.columnNumber}` : OTHER;
		const t = totals.get(key);
		if (t) t.bytes += node.selfSize;
		else totals.set(key, { node: here ?? cf, bytes: node.selfSize });
	}
	for (const ch of node.children) collect(ch, here, totals, wants);
}
