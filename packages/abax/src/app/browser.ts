import { page_clock } from './clock.ts';
import { deserialize_snapshot, empty_snapshot, snapshot_delta } from './snapshot.ts';
import type { PageCounts } from './snapshot.ts';
import type { Snapshot } from '../runtime/index.ts';
import type { ModuleMeta } from '../meta.ts';
import type { AppRequest } from './server.ts';

/*
 * A counted browser session (spec 8): a page of the counted client build loaded in Chromium under
 * virtual time, then scripted interactions, each phase's counts read out of the page.
 *
 * Time: the page's clock is Chromium's virtual time, paused except while the harness grants it
 * 16 ms at a time (`pauseIfNetworkFetchesPending`, so a slow response never costs virtual time).
 * After each 16 ms the harness runs one frame in the page (clock.ts). A phase of N virtual ms is
 * therefore N/16 frames and the same timers in the same order on every run, however fast the
 * machine is.
 *
 * Phases: `page load` (navigation plus `load_ms`), then one per step. The counts in the page are
 * cumulative; a phase is the difference of two readings (snapshot.ts). A step that loads a new
 * document (a full navigation) starts a new runtime; its counts are read from zero again.
 */

/**
 * What a step does. Elements are a CSS selector, narrowed by `text` (the element's text starts
 * with it) and `nth` (the nth match, default the first).
 */
export type PageAction =
	| { click: string; text?: string; nth?: number }
	| { hover: string; text?: string; nth?: number }
	/** Click the field, then type one character every `char_ms` virtual ms (default 80). */
	| { type: string; value: string; text?: string; nth?: number; char_ms?: number }
	| { select: string; value: string; nth?: number }
	| { scroll: string; text?: string; nth?: number }
	/** Run `expr` in the page (a reset the scenario needs, e.g. clearing a field). */
	| { script: string }
	| { wait_ms: number }
	/** Run frames until the page expression is truthy (at most `max_ms` virtual ms, else fail). */
	| { until: string; max_ms?: number };

export interface BrowserStep {
	name: string;
	actions: PageAction[];
	/** Virtual ms of frames after the actions (default 500). */
	settle_ms?: number;
}

export interface BrowserSession {
	/** First page, e.g. `/`. */
	path: string;
	/** Virtual ms of frames after navigation (default 3000). */
	load_ms?: number;
	steps: BrowserStep[];
	cookies?: Array<{ name: string; value: string }>;
	viewport?: { width: number; height: number };
}

export interface Phase {
	name: string;
	unit: 'page load' | 'interaction';
	/** Index into `metas` of the runtime the phase counted in (a new document starts a new one). */
	runtime: number;
	snap: Snapshot;
}

export interface SessionResult {
	/** Module metas of each document's runtime, in registration order. */
	runtimes: ModuleMeta[][];
	phases: Phase[];
	errors: string[];
	/**
	 * Requests the page made to the app itself while it ran (fetch / XHR, not static files): the
	 * server's share of a page view, for the server to count (`server_follow` in run.ts).
	 */
	requests: AppRequest[];
}

interface PwRequest {
	url(): string;
	method(): string;
	resourceType(): string;
	postData(): string | null;
	headers(): Record<string, string>;
}

/** Virtual ms per frame. */
export const FRAME_MS = 16;
/** 2024-01-01T00:00:00Z: the virtual clock starts here on every run. */
export const VIRTUAL_EPOCH_S = 1_704_067_200;
export const PAGE_SEED = 0xabac;

interface CdpSession {
	send(method: string, params?: Record<string, unknown>): Promise<unknown>;
	once(event: string, cb: (e: unknown) => void): unknown;
}

interface PwPage {
	evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
	evaluate<R>(expression: string): Promise<R>;
	on(event: 'pageerror', cb: (e: Error) => void): unknown;
	on(event: 'request', cb: (r: PwRequest) => void): unknown;
	route(url: string, handler: (route: PwRoute) => unknown): Promise<void>;
}

interface PwRoute {
	fetch(): Promise<unknown>;
	fulfill(o: { response: unknown }): Promise<void>;
	abort(): Promise<void>;
}

/** Round trips through the page per settle. */
const SETTLE_TRIPS = 3;

/**
 * Lets the page run what a response or an action started. Outside a grant of virtual time the page
 * runs only network tasks, microtasks and the harness's own evaluations; its timers, message
 * channels and `scheduler` tasks wait for the next grant. So round trips through the page let a
 * response's handlers run (and make the requests they make), and nothing else moves.
 */
async function settle(page: PwPage): Promise<void> {
	for (let i = 0; i < SETTLE_TRIPS; i++) await page.evaluate('0').catch(() => 0);
}

/**
 * The page's network, in order: every request is answered one at a time, in the order the page
 * made them, and the harness waits for the queue to drain before it acts or reads. While a
 * response is out, virtual time stands still (`pauseIfNetworkFetchesPending`); answering in order
 * also fixes which of two concurrent responses the page sees first (a prefetch against the click
 * that wants the same page), which the real network would decide.
 *
 * Each response is followed by a settle (the page handles it and makes the requests that leads to)
 * before the next is answered, and the harness acts or grants time only once a settle made no new
 * request (Driver.quiet). Without that, the real clock decided whether the page finished reading a
 * response before the next grant: a navigation's server-island request then went out before or
 * after the grant that ran the navigation's swap, and the islands morphed before or after the
 * focused link left the page (ogygia's `clear_aria_hidden_over_focus` counted 104 or 92 steps on
 * two runs of one build).
 */
class OrderedNetwork {
	#chain: Promise<void> = Promise.resolve();
	#pending = 0;
	#seen = 0;
	#settle: () => Promise<void>;

	constructor(settle: () => Promise<void>) {
		this.#settle = settle;
	}

	/** Requests answered or queued so far: a change means the page asked for more. */
	get seen(): number {
		return this.#seen;
	}

	answer(route: PwRoute): void {
		this.#pending++;
		this.#seen++;
		this.#chain = this.#chain.then(async () => {
			try {
				try {
					const response = await route.fetch();
					await route.fulfill({ response });
				} catch {
					await route.abort().catch(() => {});
				}
				await this.#settle();
			} finally {
				this.#pending--;
			}
		});
	}

	/** Resolves once every request made so far has been answered. */
	async drained(): Promise<void> {
		while (this.#pending > 0) await this.#chain;
	}
}

interface PwContext {
	addInitScript(fn: (arg: number) => void, arg: number): Promise<void>;
	addCookies(c: Array<{ name: string; value: string; url: string }>): Promise<void>;
	newPage(): Promise<PwPage>;
	newCDPSession(page: PwPage): Promise<CdpSession>;
	close(): Promise<void>;
}

export interface PwBrowser {
	newContext(o: { viewport: { width: number; height: number } }): Promise<PwContext>;
	close(): Promise<void>;
}

/** Chromium from Playwright (an optional dependency: only app runs need it). */
export async function launch_browser(): Promise<PwBrowser> {
	const { chromium } = (await import('playwright')) as unknown as {
		chromium: {
			launch(o: Record<string, unknown>): Promise<PwBrowser>;
			executablePath(): string;
		};
	};
	const { existsSync } = await import('node:fs');
	let executable: string | undefined;
	try {
		const p = chromium.executablePath();
		if (p && existsSync(p)) executable = p;
	} catch {
		executable = undefined;
	}
	const args = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
	if (process.env.CHROME_PATH) {
		return chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true, args });
	}
	// No Playwright browser installed (CI images that ship Google Chrome): use that one.
	return executable
		? chromium.launch({ headless: true, args })
		: chromium.launch({ channel: 'chrome', headless: true, args });
}

class Driver {
	page: PwPage;
	cdp: CdpSession;
	errors: string[];
	net: OrderedNetwork;

	constructor(page: PwPage, cdp: CdpSession, errors: string[], net: OrderedNetwork) {
		this.page = page;
		this.cdp = cdp;
		this.errors = errors;
		this.net = net;
	}

	/**
	 * Every response out, and the page done with what they started (no virtual time passes): drain,
	 * let the page run, and again while that made new requests.
	 */
	async quiet(): Promise<void> {
		for (;;) {
			const seen = this.net.seen;
			await this.net.drained();
			await settle(this.page);
			if (this.net.seen === seen) return;
		}
	}

	/** Grant `ms` of virtual time; resolves when it has passed. */
	grant(ms: number): Promise<void> {
		return new Promise((resolve, reject) => {
			this.cdp.once('Emulation.virtualTimeBudgetExpired', () => resolve());
			this.cdp
				.send('Emulation.setVirtualTimePolicy', {
					policy: 'pauseIfNetworkFetchesPending',
					budget: ms
				})
				.catch(reject);
		});
	}

	async tick(): Promise<void> {
		await this.grant(FRAME_MS);
		await this.quiet();
		await this.page
			.evaluate(() => {
				const t = (globalThis as unknown as { __abax_tick?: () => number }).__abax_tick;
				return t ? t() : 0;
			}, null)
			.catch(() => 0);
	}

	async frames(ms: number): Promise<void> {
		for (let t = 0; t < ms; t += FRAME_MS) await this.tick();
	}

	async act(a: Record<string, unknown>): Promise<void> {
		await this.quiet();
		await this.page.evaluate((x) => {
			const act = (globalThis as unknown as { __abax_act: (y: unknown) => void }).__abax_act;
			act(x);
		}, a);
	}

	async run(action: PageAction): Promise<void> {
		if ('click' in action) {
			await this.act({ kind: 'click', selector: action.click, text: action.text, nth: action.nth });
		} else if ('hover' in action) {
			await this.act({ kind: 'hover', selector: action.hover, text: action.text, nth: action.nth });
		} else if ('scroll' in action) {
			await this.act({
				kind: 'scroll',
				selector: action.scroll,
				text: action.text,
				nth: action.nth
			});
		} else if ('select' in action) {
			await this.act({
				kind: 'select',
				selector: action.select,
				value: action.value,
				nth: action.nth
			});
		} else if ('type' in action) {
			const at = { selector: action.type, text: action.text, nth: action.nth };
			await this.act({ kind: 'click', ...at });
			for (const ch of action.value) {
				await this.act({ kind: 'type', ...at, value: ch });
				await this.frames(action.char_ms ?? 80);
			}
		} else if ('script' in action) {
			// Playwright evaluates a string as an expression in the page.
			await this.page.evaluate(`void (${action.script})`);
		} else if ('wait_ms' in action) {
			await this.frames(action.wait_ms);
		} else {
			const max = action.max_ms ?? 10_000;
			for (let t = 0; ; t += FRAME_MS) {
				await this.quiet();
				const ok = await this.page.evaluate<boolean>(`Boolean(${action.until})`).catch(() => false);
				if (ok) return;
				if (t >= max) throw new Error(`abax: timed out (${max} virtual ms) on ${action.until}`);
				await this.tick();
			}
		}
	}

	/** The page's counts; null when the document has no counted runtime (yet). */
	async read(metas_from: number): Promise<{ counts: PageCounts; origin: number } | null> {
		await this.quiet();
		return this.page
			.evaluate((from) => {
				const api = (globalThis as unknown as { __abax?: { read(n: number): PageCounts } }).__abax;
				return api ? { counts: api.read(from), origin: performance.timeOrigin } : null;
			}, metas_from)
			.catch(() => null);
	}
}

/** Run one session in a fresh browser context. */
export async function run_session(
	browser: PwBrowser,
	base: string,
	session: BrowserSession
): Promise<SessionResult> {
	const context = await browser.newContext({
		viewport: session.viewport ?? { width: 1280, height: 900 }
	});
	const errors: string[] = [];
	try {
		if (session.cookies?.length) {
			await context.addCookies(session.cookies.map((c) => ({ ...c, url: base })));
		}
		await context.addInitScript(page_clock, PAGE_SEED);
		const page = await context.newPage();
		page.on('pageerror', (e) => errors.push(e.message));
		const net = new OrderedNetwork(() => settle(page));
		await page.route('**/*', (route) => net.answer(route));
		const requests: AppRequest[] = [];
		page.on('request', (r) => {
			const u = new URL(r.url());
			if (u.origin !== new URL(base).origin) return;
			if (r.resourceType() !== 'fetch' && r.resourceType() !== 'xhr') return;
			const h = r.headers();
			const headers: Record<string, string> = {};
			for (const k of ['accept', 'content-type']) if (h[k]) headers[k] = h[k];
			requests.push({
				method: r.method(),
				path: u.pathname + u.search,
				body: r.postData() ?? undefined,
				headers
			});
		});
		const cdp = await context.newCDPSession(page);
		await cdp.send('Emulation.setVirtualTimePolicy', {
			policy: 'pause',
			initialVirtualTime: VIRTUAL_EPOCH_S
		});
		const d = new Driver(page, cdp, errors, net);

		const runtimes: ModuleMeta[][] = [];
		const phases: Phase[] = [];
		let origin = -1;
		let before = empty_snapshot();
		const seen_names = new Map<string, number>();
		const take = async (label: string, unit: Phase['unit']): Promise<void> => {
			// phases are matched by name across runs and builds: a repeated step gets `#2`, `#3`
			const n = (seen_names.get(label) ?? 0) + 1;
			seen_names.set(label, n);
			const name = n === 1 ? label : `${label} #${n}`;
			let r = await d.read(origin === -1 ? 0 : runtimes[runtimes.length - 1].length);
			if (r && r.origin !== origin) {
				// A new document: a new runtime, read from its first module.
				if (r.counts.metas_from !== 0) r = await d.read(0);
				if (!r) return;
				origin = r.origin;
				runtimes.push([]);
				before = empty_snapshot();
			}
			if (!r) {
				phases.push({ name, unit, runtime: -1, snap: empty_snapshot() });
				return;
			}
			const metas = runtimes[runtimes.length - 1];
			metas.push(...r.counts.metas);
			const now = deserialize_snapshot(r.counts);
			phases.push({ name, unit, runtime: runtimes.length - 1, snap: snapshot_delta(now, before) });
			before = now;
		};

		await cdp.send('Page.navigate', { url: base + session.path });
		await d.frames(session.load_ms ?? 3000);
		await take(`load ${session.path}`, 'page load');
		for (const step of session.steps) {
			try {
				for (const a of step.actions) await d.run(a);
				await d.frames(step.settle_ms ?? 500);
			} catch (e) {
				errors.push(`${step.name}: ${(e as Error).message}`);
			}
			await take(step.name, 'interaction');
		}
		return { runtimes, phases, errors, requests };
	} finally {
		await context.close();
	}
}
