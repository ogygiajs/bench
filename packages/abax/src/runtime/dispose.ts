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
}

const reflect_apply = Reflect.apply;

function noop(): void {}

export class DisposeScope {
	#resources: Resource[] = [];
	#error: { e: unknown } | null = null;

	use<T>(value: T, awaited: boolean): T {
		if (value == null) {
			if (awaited) this.#resources[this.#resources.length] = { value, method: null, awaited };
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
		if (method === undefined) method = v[Symbol.dispose];
		if (typeof method !== 'function')
			throw new TypeError('Symbol(Symbol.dispose) is not a function');
		this.#resources[this.#resources.length] = {
			value,
			method: method as Resource['method'],
			awaited
		};
		return value;
	}

	fail(e: unknown): void {
		this.#error = { e };
	}

	#record(e: unknown): void {
		this.#error = this.#error
			? { e: new SuppressedError(e, this.#error.e, 'An error was suppressed during disposal.') }
			: { e };
	}

	/**
	 * Dispose resources from the last one until one has to be awaited: returns that promise (it
	 * never rejects; errors are recorded), or the scope itself when every resource is done.
	 */
	step(): unknown {
		const list = this.#resources;
		while (list.length > 0) {
			const r = list[list.length - 1];
			list.length--;
			try {
				const out = r.method ? reflect_apply(r.method, r.value, []) : undefined;
				if (r.awaited) {
					return Promise.resolve(out).then(noop, (e: unknown) => this.#record(e));
				}
			} catch (e) {
				this.#record(e);
				if (r.awaited) return Promise.resolve();
			}
		}
		return this;
	}

	/** After the last step: throw what the block or its disposals threw. */
	finish(): void {
		if (this.#error) throw this.#error.e;
	}
}
