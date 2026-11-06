import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { isDeepStrictEqual } from 'node:util';

/*
 * The input recorder (spec 8, leftovers). Code transformed by record-transform.ts reports each
 * call of a recorded function here: its arguments and `this` (structuredClone at entry, before the
 * function can change them) and its result or error (at exit). A few distinct samples per function
 * are kept; they become that function's real inputs for benches.
 *
 * A replay calls the function again with a copy of each sample's inputs and compares the output:
 *
 *   reproduced      every sample gave the same output again (inputs fully explain the output)
 *   hidden state    some output differs: the function reads state the inputs do not carry
 *                   (module state, a clock, a closure)
 *   not cloneable   its inputs or output cannot be structured-cloned (functions, DOM nodes...)
 *   not replayable  the replay has no handle on it (a nested closure, a class method)
 *   no samples      it never ran while recording
 *
 * Samples are saved with v8.serialize, the format structuredClone itself uses.
 */

export interface Sample {
	args: unknown[];
	this_value: unknown;
	/** The output, unless the call threw. */
	out?: unknown;
	threw?: { name: string; message: string };
}

export interface FunctionRecord {
	id: string;
	calls: number;
	/** Calls whose inputs or output could not be cloned. */
	uncloneable: number;
	samples: Sample[];
}

export type ReplayStatus =
	| 'reproduced'
	| 'hidden state'
	| 'not cloneable'
	| 'not replayable'
	| 'no samples';

export interface ReplayResult {
	id: string;
	status: ReplayStatus;
	samples: number;
	/** Samples whose output differed (hidden state). */
	mismatches: number;
}

interface Frame {
	rec: FunctionRecord;
	args: unknown[];
	this_value: unknown;
	key: string;
	out?: unknown;
	threw?: { name: string; message: string };
	done: boolean;
	bad: boolean;
}

const NOT_CLONED = Symbol('not cloned');

function clone(v: unknown): unknown {
	if (v === globalThis) return undefined;
	try {
		return structuredClone(v);
	} catch {
		return NOT_CLONED;
	}
}

export class Recorder {
	/** Distinct samples kept per function. */
	max_samples = 5;
	/** While true (a replay runs), calls are not recorded. */
	replaying = false;
	#records = new Map<string, FunctionRecord>();
	#keys = new Map<string, Set<string>>();

	#record(id: string): FunctionRecord {
		let r = this.#records.get(id);
		if (!r) {
			r = { id, calls: 0, uncloneable: 0, samples: [] };
			this.#records.set(id, r);
			this.#keys.set(id, new Set());
		}
		return r;
	}

	enter(id: string, args: ArrayLike<unknown>, this_value: unknown): Frame | null {
		if (this.replaying) return null;
		const rec = this.#record(id);
		rec.calls++;
		if (rec.samples.length >= this.max_samples) return null;
		const a = clone(Array.from(args));
		const t = clone(this_value);
		const bad = a === NOT_CLONED || t === NOT_CLONED;
		let key = '';
		if (!bad) {
			try {
				key = createHash('sha1')
					.update(serialize([a, t]))
					.digest('hex');
			} catch {
				key = '';
			}
		}
		return {
			rec,
			args: bad ? [] : (a as unknown[]),
			this_value: bad ? undefined : t,
			key,
			done: false,
			bad
		};
	}

	out<T>(f: Frame | null, v: T): T {
		if (f && !f.done) {
			f.done = true;
			const o = clone(v);
			if (o === NOT_CLONED) f.bad = true;
			else f.out = o;
		}
		return v;
	}

	fail(f: Frame | null, e: unknown): void {
		if (f && !f.done) {
			f.done = true;
			const err = e as { name?: unknown; message?: unknown } | null;
			f.threw = { name: String(err?.name ?? 'Error'), message: String(err?.message ?? e) };
		}
	}

	exit(f: Frame | null): void {
		if (!f) return;
		if (!f.done) {
			f.done = true;
			f.out = undefined;
		}
		if (f.bad) {
			f.rec.uncloneable++;
			return;
		}
		const keys = this.#keys.get(f.rec.id)!;
		if (keys.has(f.key) || f.rec.samples.length >= this.max_samples) return;
		keys.add(f.key);
		const s: Sample = { args: f.args, this_value: f.this_value };
		if (f.threw) s.threw = f.threw;
		else s.out = f.out;
		f.rec.samples.push(s);
	}

	records(): FunctionRecord[] {
		return [...this.#records.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
	}

	reset(): void {
		this.#records.clear();
		this.#keys.clear();
	}

	save(path: string): void {
		writeFileSync(path, serialize(this.records()));
	}
}

export function load_records(path: string): FunctionRecord[] {
	return deserialize(readFileSync(path)) as FunctionRecord[];
}

const G = Symbol.for('abax.recorder');

/** The process-wide recorder every record-transformed module reports to. */
export const recorder: Recorder = ((globalThis as unknown as Record<symbol, Recorder | undefined>)[
	G
] ??= new Recorder());

/**
 * Call each recorded function again with copies of its samples' inputs and compare outputs.
 * `fns` maps function ids to callable functions (a record-transformed module's `__abax_rec_fns`).
 */
export function replay(
	records: readonly FunctionRecord[],
	fns: Readonly<Record<string, unknown>>
): ReplayResult[] {
	const out: ReplayResult[] = [];
	const was = recorder.replaying;
	recorder.replaying = true;
	try {
		for (const r of records) {
			const fn = fns[r.id];
			const base = { id: r.id, samples: r.samples.length, mismatches: 0 };
			if (r.samples.length === 0) {
				out.push({ ...base, status: r.uncloneable > 0 ? 'not cloneable' : 'no samples' });
				continue;
			}
			if (typeof fn !== 'function') {
				out.push({ ...base, status: 'not replayable' });
				continue;
			}
			let mismatches = 0;
			for (const s of r.samples) {
				let got: unknown;
				let threw: { name: string; message: string } | undefined;
				try {
					got = clone(
						Reflect.apply(fn, structuredClone(s.this_value), structuredClone(s.args) as unknown[])
					);
				} catch (e) {
					const err = e as { name?: unknown; message?: unknown } | null;
					threw = { name: String(err?.name ?? 'Error'), message: String(err?.message ?? e) };
				}
				const same = s.threw
					? threw !== undefined && threw.name === s.threw.name && threw.message === s.threw.message
					: threw === undefined && got !== NOT_CLONED && isDeepStrictEqual(got, s.out);
				if (!same) mismatches++;
			}
			out.push({ ...base, mismatches, status: mismatches > 0 ? 'hidden state' : 'reproduced' });
		}
	} finally {
		recorder.replaying = was;
	}
	return out;
}
