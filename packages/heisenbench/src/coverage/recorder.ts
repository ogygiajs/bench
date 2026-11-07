import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { isDeepStrictEqual } from 'node:util';
import { INJECTED_OPEN, original_source } from './markers.ts';
import { clone_with_stand_ins, portable_clone, revive } from './portable.ts';
import { SIZE_BUDGET, arg_sizes } from '../growth/scale.ts';

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
	/** Each argument's size at entry (growth/scale.ts input_size). Absent in older sample files. */
	sizes?: number[];
	/**
	 * A callback in the inputs closed over state and is kept as a stand-in that returns undefined
	 * (portable.ts): the sample serves growth, never a replay of the output (no `out` is kept).
	 */
	stand_ins?: true;
}

export interface FunctionRecord {
	id: string;
	calls: number;
	/** Calls whose inputs or output could not be cloned. */
	uncloneable: number;
	/** Calls with the inputs of an earlier sample but another output: state the inputs miss. */
	inconsistent: number;
	samples: Sample[];
	/**
	 * The input sizes every call came with (sum over the arguments), smallest and largest, over the
	 * `sized` calls whose arguments were walked (each function has a walk budget). Absent in older
	 * sample files.
	 */
	sizes?: { sized: number; min: number; max: number };
}

/**
 * Samples are kept two ways. The first `max_samples` distinct inputs (what a replay checks), and
 * one input per size band (half an octave of the summed argument sizes, at most SIZE_BANDS bands):
 * the ladder of sizes growth fits steps over (growth/recorded.ts).
 */
export const SIZE_BANDS = 24;

/** The size band of a summed input size: half octaves (1, 1.4, 2, 2.8, 4 ...). */
export function size_band(size: number): number {
	return Math.floor(2 * Math.log2(size + 1));
}

/** Values one function's size walks may visit in a process, over all its calls. */
const FUNCTION_SIZE_BUDGET = 1 << 21;

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
	sizes: number[] | null;
	/** The inputs were cloned with stand-ins for callbacks (portable.ts clone_with_stand_ins). */
	stood: boolean;
	out?: unknown;
	threw?: { name: string; message: string };
	done: boolean;
	bad: boolean;
}

const NOT_CLONED = Symbol('not cloned');

function sum(xs: readonly number[]): number {
	let s = 0;
	for (const x of xs) s += x;
	return s;
}

function error_of(e: unknown): { name: string; message: string } {
	const err = e as { name?: unknown; message?: unknown } | null;
	return { name: String(err?.name ?? 'Error'), message: String(err?.message ?? e) };
}

/** Same output, or the same error. */
function same_result(a: Sample, b: Sample): boolean {
	if (a.threw || b.threw) {
		return (
			a.threw !== undefined &&
			b.threw !== undefined &&
			a.threw.name === b.threw.name &&
			a.threw.message === b.threw.message
		);
	}
	return b.out !== NOT_CLONED && a.out !== NOT_CLONED && isDeepStrictEqual(a.out, b.out);
}

/** structuredClone, keeping functions that close over nothing and Node modules (portable.ts). */
function clone(v: unknown): unknown {
	if (v === globalThis) return undefined;
	try {
		return portable_clone(v);
	} catch {
		return NOT_CLONED;
	}
}

export class Recorder {
	/** Distinct samples kept per function (besides one per size band). */
	max_samples = 5;
	/** While true (a replay runs), calls are not recorded. */
	replaying = false;
	#records = new Map<string, FunctionRecord>();
	/** Per function: inputs key -> the sample kept for those inputs. */
	#keys = new Map<string, Map<string, Sample>>();
	/** Per function: the size bands it holds a sample of. */
	#bands = new Map<string, Set<number>>();
	/** Per function: what its size walks may still visit. */
	#budget = new Map<string, number>();

	#record(id: string): FunctionRecord {
		let r = this.#records.get(id);
		if (!r) {
			r = { id, calls: 0, uncloneable: 0, inconsistent: 0, samples: [] };
			this.#records.set(id, r);
			this.#keys.set(id, new Map());
			this.#bands.set(id, new Set());
			this.#budget.set(id, FUNCTION_SIZE_BUDGET);
		}
		return r;
	}

	/** Each argument's size, within the function's walk budget (null once it is spent). */
	#sizes(rec: FunctionRecord, args: ArrayLike<unknown>): number[] | null {
		const left = this.#budget.get(rec.id)!;
		if (left <= 0) return null;
		const walk = arg_sizes(Array.from(args), Math.min(SIZE_BUDGET, left));
		this.#budget.set(rec.id, left - walk.visits);
		const total = sum(walk.sizes);
		const s = (rec.sizes ??= { sized: 0, min: total, max: total });
		s.sized++;
		if (total < s.min) s.min = total;
		if (total > s.max) s.max = total;
		return walk.sizes;
	}

	/**
	 * Sizing and cloning read the inputs, which can run recorded code (a getter, a toJSON): those
	 * calls are the recorder's own reading, never recorded (else a getter would record itself
	 * while being read, without end).
	 */
	#busy = false;

	enter(id: string, args: ArrayLike<unknown>, this_value: unknown): Frame | null {
		if (this.replaying || this.#busy) return null;
		this.#busy = true;
		try {
			return this.#enter(id, args, this_value);
		} finally {
			this.#busy = false;
		}
	}

	#enter(id: string, args: ArrayLike<unknown>, this_value: unknown): Frame | null {
		const rec = this.#record(id);
		rec.calls++;
		const sizes = this.#sizes(rec, args);
		const bands = this.#bands.get(id)!;
		const new_band = sizes !== null && bands.size < SIZE_BANDS && !bands.has(size_band(sum(sizes)));
		const faithful = this.#faithful(id);
		if (faithful >= this.max_samples && !new_band) return null;
		let a = clone(Array.from(args));
		let t = clone(this_value);
		let stood = false;
		if ((a === NOT_CLONED || t === NOT_CLONED) && new_band) {
			// growth still wants this size: the callbacks that close over state stood in
			try {
				const sa = clone_with_stand_ins(Array.from(args));
				const st =
					this_value === globalThis
						? { value: undefined, stand_ins: false }
						: clone_with_stand_ins(this_value);
				a = sa.value;
				t = st.value;
				stood = sa.stand_ins || st.stand_ins;
			} catch {
				// not even with stand-ins (a class instance holding a function, a DOM node...)
			}
		}
		let bad = a === NOT_CLONED || t === NOT_CLONED;
		let key = '';
		if (!bad) {
			try {
				key = createHash('sha1')
					.update(serialize([a, t]))
					.digest('hex');
			} catch {
				// structuredClone takes some host objects (a KeyObject) a sample file cannot hold
				bad = true;
			}
		}
		return {
			rec,
			args: bad ? [] : (a as unknown[]),
			this_value: bad ? undefined : t,
			key,
			sizes,
			stood,
			done: false,
			bad
		};
	}

	/** Samples of `id` that are its inputs as they came (no stand-ins). */
	#faithful(id: string): number {
		let n = 0;
		for (const s of this.#records.get(id)!.samples) if (!s.stand_ins) n++;
		return n;
	}

	out<T>(f: Frame | null, v: T): T {
		if (f && !f.done) {
			f.done = true;
			// a sample with stand-ins serves growth alone, which needs no output
			const was = this.#busy;
			this.#busy = true;
			try {
				const o = f.stood ? undefined : clone(v);
				if (o === NOT_CLONED) f.bad = true;
				else f.out = o;
			} finally {
				this.#busy = was;
			}
		}
		return v;
	}

	fail(f: Frame | null, e: unknown): void {
		if (f && !f.done) {
			f.done = true;
			f.threw = error_of(e);
		}
	}

	exit(f: Frame | null): void {
		if (!f) return;
		if (!f.done) {
			f.done = true;
			f.out = undefined;
		}
		if (f.bad || f.stood) f.rec.uncloneable++;
		if (f.bad) return;
		const keys = this.#keys.get(f.rec.id)!;
		const s: Sample = { args: f.args, this_value: f.this_value };
		if (f.threw) s.threw = f.threw;
		else s.out = f.out;
		if (f.sizes) s.sizes = f.sizes;
		if (f.stood) s.stand_ins = true;
		const earlier = keys.get(f.key);
		if (earlier) {
			if (!f.stood && !earlier.stand_ins && !same_result(earlier, s)) f.rec.inconsistent++;
			return;
		}
		const bands = this.#bands.get(f.rec.id)!;
		const band = f.sizes ? size_band(sum(f.sizes)) : null;
		const new_band = band !== null && bands.size < SIZE_BANDS && !bands.has(band);
		if ((f.stood || this.#faithful(f.rec.id) >= this.max_samples) && !new_band) return;
		keys.set(f.key, s);
		if (band !== null) bands.add(band);
		f.rec.samples.push(s);
	}

	records(): FunctionRecord[] {
		return [...this.#records.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
	}

	reset(): void {
		this.#records.clear();
		this.#keys.clear();
		this.#bands.clear();
		this.#budget.clear();
	}

	save(path: string): void {
		const records = this.records();
		let bytes: Buffer;
		try {
			bytes = serialize(records);
		} catch {
			// an output only structuredClone could hold: those samples go, counted as uncloneable
			bytes = serialize(
				records.map((r) => {
					const samples = r.samples.filter((s) => {
						try {
							serialize(s);
							return true;
						} catch {
							return false;
						}
					});
					return { ...r, samples, uncloneable: r.uncloneable + r.samples.length - samples.length };
				})
			);
		}
		writeFileSync(path, bytes);
	}
}

export function load_records(path: string): FunctionRecord[] {
	return deserialize(readFileSync(path)) as FunctionRecord[];
}

const G = Symbol.for('heisenbench.recorder');
const TO_STRING = Symbol.for('heisenbench.recorder.to-string');

/*
 * Code that serializes a function (`fn.toString()` into an inline script) must get the function as
 * written, not with the recorder's calls in it (they would name a binding the script does not
 * have). While recorded code runs, Function.prototype.toString gives back the original text. It
 * stays a native-looking function (a Proxy of the real one), so code that checks for native
 * functions by their text is not fooled.
 */
const g = globalThis as unknown as Record<symbol, unknown>;
if (!g[TO_STRING]) {
	g[TO_STRING] = true;
	const native = Function.prototype.toString;
	// oxlint-disable-next-line no-extend-native
	Function.prototype.toString = new Proxy(native, {
		apply(target, self, args) {
			const text = Reflect.apply(target, self, args) as string;
			return text.includes(INJECTED_OPEN) ? original_source(text) : text;
		}
	});
}

/** The process-wide recorder every record-transformed module reports to. */
export const recorder: Recorder = ((globalThis as unknown as Record<symbol, Recorder | undefined>)[
	G
] ??= new Recorder());

/**
 * Call each recorded function again with copies of its samples' inputs and compare outputs.
 * `fns` maps function ids to callable functions (a record-transformed module's `__heisenbench_rec_fns`).
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
			// samples with stand-ins do not carry the call's inputs: they never stand for its output
			const samples = r.samples.filter((s) => !s.stand_ins);
			const base = { id: r.id, samples: samples.length, mismatches: 0 };
			if (samples.length === 0) {
				out.push({ ...base, status: r.uncloneable > 0 ? 'not cloneable' : 'no samples' });
				continue;
			}
			if (typeof fn !== 'function') {
				out.push({ ...base, status: 'not replayable' });
				continue;
			}
			let mismatches = 0;
			// Twice per sample: a function that keeps state of its own answers differently the
			// second time even when the first replay happens to match.
			for (let round = 0; round < 2; round++) {
				for (const s of samples) {
					const got: Sample = { args: s.args, this_value: s.this_value };
					try {
						got.out = clone(
							Reflect.apply(
								fn,
								revive(structuredClone(s.this_value)),
								revive(structuredClone(s.args)) as unknown[]
							)
						);
					} catch (e) {
						got.threw = error_of(e);
					}
					if (!same_result(s, got)) mismatches++;
				}
			}
			const hidden = mismatches > 0 || r.inconsistent > 0;
			out.push({ ...base, mismatches, status: hidden ? 'hidden state' : 'reproduced' });
		}
	} finally {
		recorder.replaying = was;
	}
	return out;
}
