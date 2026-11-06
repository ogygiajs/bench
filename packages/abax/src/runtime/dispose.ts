/*
 * `await using` in a counted async function (spec 10: the shadow stack across awaits).
 *
 * The disposal at the end of an `await using` block is an await the code does not spell out, so
 * the transform cannot wrap it in suspend/resume, and the function would stay on the shadow stack
 * while it waits. The transform rewrites the block instead:
 *
 *   { S1; await using a = A; S2 }
 *   ->
 *   { const u = R.scope(); try { S1; const a = u.use(A, true); S2 }
 *     catch (e) { u.fail(e) }
 *     finally { for (let p; (p = u.step()) !== u;) R.resume(r, await R.suspend(r, p)); u.finish() } }
 *
 * so every disposal await is a spelled-out await that suspends and resumes the frame. This class
 * keeps the semantics of the language's DisposeResources: resources dispose in reverse order,
 * `Symbol.asyncDispose` (or `Symbol.dispose` for an `await using`) is awaited, a sync `using` in
 * the same block is not, `await using x = null` still awaits once, and errors chain as
 * SuppressedError (the newest error suppressing the one before, the body's error first).
 */

interface Resource {
	value: unknown;
	method: ((this: unknown) => unknown) | null;
	awaited: boolean;
	/** An `await using` of a value with only `Symbol.dispose`: its result is not awaited. */
	sync: boolean;
}

const reflect_apply = Reflect.apply;

export class DisposeScope {
	#resources: Resource[] = [];
	#error: { e: unknown } | null = null;

	use<T>(value: T, awaited: boolean): T {
		if (value == null) {
			if (awaited)
				this.#resources[this.#resources.length] = { value, method: null, awaited, sync: true };
			return value;
		}
		// The errors are worded as V8 words them, so a program that reads them sees no difference.
		if (typeof value !== 'object' && typeof value !== 'function') {
			throw new TypeError('An object is expected with `using` declarations');
		}
		const v = value as Record<symbol, unknown>;
		let method = awaited ? v[Symbol.asyncDispose] : undefined;
		if (method !== undefined && typeof method !== 'function') {
			throw new TypeError('Symbol(Symbol.asyncDispose) is not a function');
		}
		const sync = method === undefined;
		if (sync) method = v[Symbol.dispose];
		if (typeof method !== 'function')
			throw new TypeError('Symbol(Symbol.dispose) is not a function');
		this.#resources[this.#resources.length] = {
			value,
			method: method as Resource['method'],
			awaited,
			sync
		};
		return value;
	}

	fail(e: unknown): void {
		this.#error = { e };
	}

	/** A disposal threw, or what it returned rejected when awaited. */
	record(e: unknown): void {
		this.#error = this.#error
			? { e: new SuppressedError(e, this.#error.e, 'An error was suppressed during disposal.') }
			: { e };
	}

	/** An `await using x = null` was passed: the language awaits once, later, if nothing else did. */
	#needs_await = false;
	#has_awaited = false;

	/**
	 * Dispose resources from the last one until one has to be awaited: returns what the language
	 * awaits there (DisposeResources), so the awaits take as many turns of the microtask queue as
	 * the language's own; or the scope itself when every resource is done. The transform's loop
	 * awaits it and hands a rejection to `record`.
	 *
	 *   `await using` of a disposer      its result is awaited
	 *   ... with only `Symbol.dispose`   called; a resolved promise is awaited
	 *   ... of null or undefined         nothing yet; one await at the end (or before the next sync
	 *                                    disposal) when no other disposal awaited
	 *   a call that throws               recorded, not awaited
	 */
	step(): unknown {
		const list = this.#resources;
		while (list.length > 0) {
			const r = list[list.length - 1];
			if (!r.awaited && this.#needs_await && !this.#has_awaited) {
				this.#needs_await = false;
				return undefined;
			}
			list.length--;
			if (!r.method) {
				this.#needs_await = true;
				continue;
			}
			try {
				const out = reflect_apply(r.method, r.value, []);
				if (r.awaited) {
					this.#has_awaited = true;
					return r.sync ? undefined : out;
				}
			} catch (e) {
				this.record(e);
			}
		}
		if (this.#needs_await && !this.#has_awaited) {
			this.#needs_await = false;
			return undefined;
		}
		return this;
	}

	/** After the last step: throw what the block or its disposals threw. */
	finish(): void {
		if (this.#error) throw this.#error.e;
	}
}
