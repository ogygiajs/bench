/**
 * Estimated V8 heap bytes per allocation site.
 *
 * The model assumes a 64-bit V8 with pointer compression (Node's default build):
 *
 * - Every tagged field is 4 B. Objects are 4 B aligned.
 * - JSObject: map + properties + elements = 12 B header, then 4 B per in-object field.
 *   An empty literal `{}` reserves 4 in-object slots (28 B). A literal with k keys gets exactly k.
 *   `new C()` gets one slot per field V8 can predict: class fields plus distinct `this.x =` writes
 *   in the constructor; unknown constructors get the empty-literal reservation.
 * - JSArray: map + properties + elements + length = 16 B. A non-empty backing store is a
 *   FixedArray: map + length = 8 B, then 4 B per element. `[]` shares the empty backing store.
 * - Closure (JSFunction): 32 B. Captured variables live in a Context: 4 B per captured variable
 *   (the context header is shared by every closure of one call and is not charged here).
 * - Bound function: map + properties + elements + target + this + args = 24 B, plus a FixedArray
 *   of bound arguments.
 * - Promise (one per async call): 20 B, plus the suspended async function object (28 B).
 * - Generator object: 40 B, plus a register FixedArray (8 B + 4 B per local).
 * - Regexp literal (a fresh JSRegExp each evaluation): 28 B.
 * - Strings: sequential one-byte string = 12 B header (map + hash + length) + 1 B/char, rounded up
 *   to 4 B. Two-byte strings are not told apart (estimated as flat one-byte).
 * - Joins (`a + b`, `s += x`, template literals): a ConsString of 20 B (header + first + second)
 *   from 13 characters on, a flat copy below that. V8 links the two halves without copying them,
 *   so building a long string piece by piece costs per piece, not per character so far.
 * - Substrings (slice, substring, trim, the parts of split, regex captures): a SlicedString of 20 B
 *   (header + parent + offset) from 13 characters on, a copy below that.
 * - Map / Set: JSMap/JSSet header 16 B plus the initial OrderedHashMap/OrderedHashSet table.
 * - A regex match: a JSArray with 3 more fields (index, input, groups) and its captures.
 *
 * Built-ins are sized by what their result holds that is new (runtime/builtins.ts, result_bytes):
 * a new array or string, the strings `split` cuts, the [key, value] pairs of `Object.entries`,
 * what `JSON.parse` and `structuredClone` build. A result the call already had (sort's array,
 * Object.assign's target, a Map's set) is not new.
 *
 * These are estimates of what the engine would allocate if it elided nothing. The real-bytes
 * check (measure/alloc.ts: V8's sampling heap profiler on the uninstrumented build) measures the
 * same functions per call; a gap between the two means the engine elided or folded allocations.
 */

export const TAGGED = 4;
export const OBJECT_HEADER = 12;
export const EMPTY_OBJECT_SLOTS = 4;
export const ARRAY_HEADER = 16;
export const FIXED_ARRAY_HEADER = 8;
export const CLOSURE = 32;
export const BOUND_FUNCTION = 24;
export const PROMISE = 20;
export const ASYNC_FUNCTION_OBJECT = 28;
export const GENERATOR_OBJECT = 40;
export const REGEXP = 28;
export const STRING_HEADER = 12;
export const CLASS = CLOSURE + OBJECT_HEADER + EMPTY_OBJECT_SLOTS * TAGGED;

export function object_bytes(fields: number): number {
	return OBJECT_HEADER + TAGGED * (fields === 0 ? EMPTY_OBJECT_SLOTS : fields);
}

export function array_bytes(elements: number): number {
	return elements === 0 ? ARRAY_HEADER : ARRAY_HEADER + FIXED_ARRAY_HEADER + TAGGED * elements;
}

export function closure_bytes(captured: number): number {
	return CLOSURE + TAGGED * captured;
}

export function bound_bytes(args: number): number {
	return BOUND_FUNCTION + (args === 0 ? 0 : FIXED_ARRAY_HEADER + TAGGED * args);
}

export function string_bytes(length: number): number {
	return (STRING_HEADER + length + 3) & ~3;
}

/** V8 cuts substrings of at least this many characters as SlicedStrings (a view of the parent). */
export const SLICED_MIN = 13;
export const SLICED_STRING = 20;

export function substring_bytes(length: number): number {
	return length >= SLICED_MIN ? SLICED_STRING : string_bytes(length);
}

/** V8 joins strings of at least this many characters as ConsStrings (ConsString::kMinLength). */
export const CONS_MIN = 13;
export const CONS_STRING = 20;

/** A regex match array (index, input and groups are in-object fields). */
export function match_bytes(captures: number): number {
	return array_bytes(captures) + 3 * TAGGED;
}

export function generator_bytes(locals: number): number {
	return GENERATOR_OBJECT + FIXED_ARRAY_HEADER + TAGGED * locals;
}

/** Built-in constructors with a known fresh-instance size. */
export const KNOWN_CONSTRUCTORS: Record<string, number> = {
	Map: 16 + 72,
	Set: 16 + 56,
	WeakMap: 16 + 72,
	WeakSet: 16 + 56,
	Date: 24,
	Promise: PROMISE,
	Error: object_bytes(4),
	TypeError: object_bytes(4),
	RangeError: object_bytes(4),
	URL: object_bytes(4),
	URLSearchParams: object_bytes(2),
	TextEncoder: object_bytes(0),
	TextDecoder: object_bytes(4),
	Array: ARRAY_HEADER,
	Object: object_bytes(0),
	RegExp: REGEXP,
	AbortController: object_bytes(2)
};
