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
 * charged to the nearest frame on its stack that belongs to a source module under the root (so
 * bytes allocated inside a built-in such as Array.prototype.map are charged to the function that
 * called it). The child runs without inlining (spawn.ts), so a frame's bytes are its own.
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
	const attributor = new Attributor(root);
	for (let done = 0; done < warm; done += batch) await run_batch(c, Math.min(batch, warm - done));
	gc?.();

	const session = new Session();
	session.connect();
	const totals = new Map<string, { node: CallFrame; bytes: number }>();
	try {
		await session.post('HeapProfiler.enable');
		for (let done = 0; done < runs; done += batch) {
			const n = Math.min(batch, runs - done);
			let sampling = false;
			await run_batch(c, n, async () => {
				if (!sampling) {
					await session.post('HeapProfiler.startSampling', {
						samplingInterval: o.interval ?? 32,
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
				collect(profile.head, null, totals, (url) => attributor.wants(url));
			});
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
	return { runs, bytes: round(bytes / runs), other: round(other / runs), functions };
}

const OTHER = '<other>';

function round(n: number): number {
	return Math.round(n * 100) / 100;
}

function collect(
	node: ProfileNode,
	owner: CallFrame | null,
	totals: Map<string, { node: CallFrame; bytes: number }>,
	wants: (url: string) => boolean
): void {
	const cf = node.callFrame;
	const here = cf.url && wants(cf.url) ? cf : owner;
	if (node.selfSize > 0) {
		const key = here ? `${here.url}:${here.lineNumber}:${here.columnNumber}` : OTHER;
		const t = totals.get(key);
		if (t) t.bytes += node.selfSize;
		else totals.set(key, { node: here ?? cf, bytes: node.selfSize });
	}
	for (const ch of node.children) collect(ch, here, totals, wants);
}
