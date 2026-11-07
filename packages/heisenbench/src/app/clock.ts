/*
 * The page side of a counted browser session (installed before any page script, browser.ts).
 *
 * Chromium's virtual time (Emulation.setVirtualTimePolicy) makes Date, performance.now and timers
 * deterministic, but frames are still made by the compositor on the real clock, and while virtual
 * time is paused no frame comes at all. So everything a page waits a frame for runs on the
 * harness's ticks instead: requestAnimationFrame, requestIdleCallback, IntersectionObserver and
 * ResizeObserver callbacks are queued here and run by `__heisenbench_tick()`, which the harness calls once
 * per 16 virtual ms. Math.random and crypto randomness come from one seeded generator.
 *
 * `__heisenbench_act` drives interactions with the event sequence a real pointer or keyboard makes
 * (pointerover ... click, keydown/input/keyup per character), dispatched in the page: no input
 * pipeline that would wait for a real frame.
 *
 * This function is serialized into the page: it must not reference anything outside itself.
 */
export function page_clock(seed: number): void {
	const w = window as unknown as Record<string, unknown>;
	if (w.__heisenbench_tick) return;

	// ---- seeded randomness (sfc32-style mixing of one 32-bit state)
	let state = seed | 0;
	const random = (): number => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	Math.random = random;
	const fill = <T extends ArrayBufferView | null>(view: T): T => {
		if (view) {
			const b = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
			for (let i = 0; i < b.length; i++) b[i] = Math.floor(random() * 256);
		}
		return view;
	};
	crypto.getRandomValues = fill as typeof crypto.getRandomValues;
	crypto.randomUUID = (() => {
		const b = fill(new Uint8Array(16));
		b[6] = (b[6] & 0x0f) | 0x40;
		b[8] = (b[8] & 0x3f) | 0x80;
		let s = '';
		for (let i = 0; i < 16; i++) {
			s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
			if (i === 3 || i === 5 || i === 7 || i === 9) s += '-';
		}
		return s;
	}) as typeof crypto.randomUUID;

	// ---- frames on the harness's ticks
	let next_id = 0;
	let frames: Array<[number, FrameRequestCallback]> = [];
	let idles: Array<[number, IdleRequestCallback]> = [];
	window.requestAnimationFrame = (cb) => {
		frames.push([++next_id, cb]);
		return next_id;
	};
	window.cancelAnimationFrame = (id) => {
		frames = frames.filter((f) => f[0] !== id);
	};
	window.requestIdleCallback = (cb) => {
		idles.push([++next_id, cb]);
		return next_id;
	};
	window.cancelIdleCallback = (id) => {
		idles = idles.filter((f) => f[0] !== id);
	};

	interface Watched {
		el: Element;
		last: boolean | null;
	}
	const observers: Array<{ kind: 'io' | 'ro'; run: () => void }> = [];

	function margin(m: string | undefined): number {
		const n = parseFloat(m ?? '0');
		return Number.isFinite(n) ? n : 0;
	}

	class TickIntersectionObserver {
		#cb: IntersectionObserverCallback;
		#els: Watched[] = [];
		#margin: number;
		readonly root = null;
		readonly rootMargin: string;
		readonly thresholds: number[] = [0];
		constructor(cb: IntersectionObserverCallback, o?: IntersectionObserverInit) {
			this.#cb = cb;
			this.rootMargin = o?.rootMargin ?? '0px';
			this.#margin = margin(o?.rootMargin);
			observers.push({ kind: 'io', run: () => this.#run() });
		}
		observe(el: Element): void {
			if (!this.#els.some((x) => x.el === el)) this.#els.push({ el, last: null });
		}
		unobserve(el: Element): void {
			this.#els = this.#els.filter((x) => x.el !== el);
		}
		disconnect(): void {
			this.#els = [];
		}
		takeRecords(): IntersectionObserverEntry[] {
			return [];
		}
		#run(): void {
			const out: IntersectionObserverEntry[] = [];
			const m = this.#margin;
			for (const x of this.#els) {
				const r = x.el.getBoundingClientRect();
				const inside =
					x.el.isConnected &&
					r.bottom >= -m &&
					r.right >= -m &&
					r.top <= innerHeight + m &&
					r.left <= innerWidth + m;
				if (inside === x.last) continue;
				x.last = inside;
				out.push({
					target: x.el,
					isIntersecting: inside,
					intersectionRatio: inside ? 1 : 0,
					boundingClientRect: r,
					intersectionRect: r,
					rootBounds: null,
					time: performance.now()
				} as IntersectionObserverEntry);
			}
			if (out.length) this.#cb(out, this as unknown as IntersectionObserver);
		}
	}

	class TickResizeObserver {
		#cb: ResizeObserverCallback;
		#els: Array<{ el: Element; w: number; h: number }> = [];
		constructor(cb: ResizeObserverCallback) {
			this.#cb = cb;
			observers.push({ kind: 'ro', run: () => this.#run() });
		}
		observe(el: Element): void {
			if (!this.#els.some((x) => x.el === el)) this.#els.push({ el, w: -1, h: -1 });
		}
		unobserve(el: Element): void {
			this.#els = this.#els.filter((x) => x.el !== el);
		}
		disconnect(): void {
			this.#els = [];
		}
		#run(): void {
			const out: ResizeObserverEntry[] = [];
			for (const x of this.#els) {
				const r = x.el.getBoundingClientRect();
				if (r.width === x.w && r.height === x.h) continue;
				x.w = r.width;
				x.h = r.height;
				const size = [{ inlineSize: r.width, blockSize: r.height }];
				out.push({
					target: x.el,
					contentRect: r,
					borderBoxSize: size,
					contentBoxSize: size,
					devicePixelContentBoxSize: size
				} as unknown as ResizeObserverEntry);
			}
			if (out.length) this.#cb(out, this as unknown as ResizeObserver);
		}
	}

	w.IntersectionObserver = TickIntersectionObserver;
	w.ResizeObserver = TickResizeObserver;

	// The document's scroll events come with a rendering update (the real clock). They are held
	// back and sent on the tick that sees the scroll position change instead.
	const held = (e: Event): void => {
		if (e.isTrusted && (e.target === document || e.target === window)) e.stopImmediatePropagation();
	};
	addEventListener('scroll', held, { capture: true });
	addEventListener('scrollend', held, { capture: true });
	let scroll_x = 0;
	let scroll_y = 0;

	// View transitions finish with rendering too: the update runs as the API says (in a
	// microtask), `ready` follows it, `finished` resolves on the next tick.
	let transitions: Array<() => void> = [];
	if (typeof document.startViewTransition === 'function') {
		document.startViewTransition = ((
			arg?: ViewTransitionUpdateCallback | { update?: ViewTransitionUpdateCallback }
		) => {
			const update = typeof arg === 'function' ? arg : arg?.update;
			const updateCallbackDone = Promise.resolve().then(() => (update ? update() : undefined));
			const ready = updateCallbackDone.then(() => undefined);
			const finished = updateCallbackDone.then(
				() => new Promise<undefined>((r) => transitions.push(() => r(undefined)))
			);
			ready.catch(() => {});
			finished.catch(() => {});
			return {
				updateCallbackDone,
				ready,
				finished,
				skipTransition() {},
				types: new Set<string>()
			} as unknown as ViewTransition;
		}) as typeof document.startViewTransition;
	}

	const report = (e: unknown): void => {
		try {
			reportError(e);
		} catch {
			/* nothing to report to */
		}
	};

	/**
	 * One frame: held scroll events, animation frame callbacks, observers, finished view
	 * transitions, then idle callbacks. Returns callbacks run.
	 */
	w.__heisenbench_tick = (): number => {
		const now = performance.now();
		if (scrollX !== scroll_x || scrollY !== scroll_y) {
			scroll_x = scrollX;
			scroll_y = scrollY;
			document.dispatchEvent(new Event('scroll', { bubbles: true }));
			document.dispatchEvent(new Event('scrollend', { bubbles: true }));
		}
		const done = transitions;
		transitions = [];
		for (const r of done) r();
		const due = frames;
		frames = [];
		for (const [, cb] of due) {
			try {
				cb(now);
			} catch (e) {
				report(e);
			}
		}
		for (const o of observers.slice()) {
			try {
				o.run();
			} catch (e) {
				report(e);
			}
		}
		const idle = idles;
		idles = [];
		for (const [, cb] of idle) {
			try {
				cb({ didTimeout: false, timeRemaining: () => 50 });
			} catch (e) {
				report(e);
			}
		}
		return due.length + idle.length;
	};

	// ---- interactions
	/** The `nth` (default first) element matching `selector` whose text starts with `text`. */
	const find = (selector: string, text?: string, nth = 0): Element => {
		const all = document.querySelectorAll(selector);
		let n = 0;
		for (const el of all) {
			if (text !== undefined && !(el.textContent ?? '').trim().startsWith(text)) continue;
			if (n++ === nth) return el;
		}
		throw new Error(
			`heisenbench: no element ${selector}${text === undefined ? '' : ` "${text}"`} #${nth}`
		);
	};
	const pointer = (el: Element, type: string): void => {
		const r = el.getBoundingClientRect();
		const init = {
			bubbles: true,
			cancelable: true,
			composed: true,
			clientX: r.left + r.width / 2,
			clientY: r.top + r.height / 2,
			button: 0,
			buttons: type.endsWith('down') ? 1 : 0,
			pointerId: 1,
			pointerType: 'mouse',
			isPrimary: true
		};
		const event = type.startsWith('pointer')
			? new PointerEvent(type, init)
			: type === 'click'
				? new MouseEvent(type, { ...init, detail: 1 })
				: new MouseEvent(type, init);
		el.dispatchEvent(event);
	};
	const key = (el: Element, type: string, k: string): void => {
		el.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true }));
	};

	w.__heisenbench_act = (a: {
		kind: 'click' | 'type' | 'select' | 'scroll' | 'hover';
		selector: string;
		text?: string;
		nth?: number;
		value?: string;
	}): void => {
		const el = find(a.selector, a.text, a.nth);
		if (a.kind === 'scroll') {
			el.scrollIntoView({ block: 'center' });
			return;
		}
		el.scrollIntoView({ block: 'nearest' });
		for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove']) {
			pointer(el, t);
		}
		if (a.kind === 'hover') return;
		if (a.kind === 'click') {
			pointer(el, 'pointerdown');
			pointer(el, 'mousedown');
			if (el instanceof HTMLElement) el.focus();
			pointer(el, 'pointerup');
			pointer(el, 'mouseup');
			// `click()` also runs the activation behaviour: a link navigates, a summary toggles.
			if (el instanceof HTMLElement) el.click();
			else pointer(el, 'click');
			return;
		}
		if (el instanceof HTMLElement) el.focus();
		if (a.kind === 'select') {
			(el as HTMLSelectElement).value = a.value ?? '';
			el.dispatchEvent(new Event('input', { bubbles: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
			return;
		}
		const input = el as HTMLInputElement | HTMLTextAreaElement;
		for (const ch of a.value ?? '') {
			key(el, 'keydown', ch);
			input.value += ch;
			el.dispatchEvent(
				new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' })
			);
			key(el, 'keyup', ch);
		}
	};
}
