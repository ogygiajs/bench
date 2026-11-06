import { page_clock } from './clock.ts';
import { deserialize_snapshot, empty_snapshot, snapshot_delta } from './snapshot.ts';
import type { PageCounts } from './snapshot.ts';
import type { Snapshot } from '../runtime/index.ts';
import type { ModuleMeta } from '../meta.ts';

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

export type PageAction =
	| { click: string; text?: string }
	| { hover: string; text?: string }
	| { type: string; value: string; text?: string; char_ms?: number }
	| { select: string; value: string }
	| { scroll: string; text?: string }
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
	on(event: 'pageerror', cb: (e: Error) => void): unknown;
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

	constructor(page: PwPage, cdp: CdpSession, errors: string[]) {
		this.page = page;
		this.cdp = cdp;
		this.errors = errors;
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
		await this.page.evaluate((x) => {
			const act = (globalThis as unknown as { __abax_act: (y: unknown) => void }).__abax_act;
			act(x);
		}, a);
	}

	async run(action: PageAction): Promise<void> {
		if ('click' in action) {
			await this.act({ kind: 'click', selector: action.click, text: action.text });
		} else if ('hover' in action) {
			await this.act({ kind: 'hover', selector: action.hover, text: action.text });
		} else if ('scroll' in action) {
			await this.act({ kind: 'scroll', selector: action.scroll, text: action.text });
		} else if ('select' in action) {
			await this.act({ kind: 'select', selector: action.select, value: action.value });
		} else if ('type' in action) {
			await this.act({ kind: 'click', selector: action.type, text: action.text });
			for (const ch of action.value) {
				await this.act({ kind: 'type', selector: action.type, text: action.text, value: ch });
				await this.frames(action.char_ms ?? 80);
			}
		} else if ('wait_ms' in action) {
			await this.frames(action.wait_ms);
		} else {
			const max = action.max_ms ?? 10_000;
			for (let t = 0; ; t += FRAME_MS) {
				const ok = await this.page
					.evaluate((expr) => Boolean((0, eval)(expr)), action.until)
					.catch(() => false);
				if (ok) return;
				if (t >= max) throw new Error(`abax: timed out (${max} virtual ms) on ${action.until}`);
				await this.tick();
			}
		}
	}

	/** The page's counts; null when the document has no counted runtime (yet). */
	async read(metas_from: number): Promise<{ counts: PageCounts; origin: number } | null> {
		return this.page
			.evaluate((from) => {
				const api = (
					globalThis as unknown as { __abax?: { read(n: number): PageCounts } }
				).__abax;
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
		const cdp = await context.newCDPSession(page);
		await cdp.send('Emulation.setVirtualTimePolicy', {
			policy: 'pause',
			initialVirtualTime: VIRTUAL_EPOCH_S
		});
		const d = new Driver(page, cdp, errors);

		const runtimes: ModuleMeta[][] = [];
		const phases: Phase[] = [];
		let origin = -1;
		let before = empty_snapshot();
		const take = async (name: string, unit: Phase['unit']): Promise<void> => {
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
		return { runtimes, phases, errors };
	} finally {
		await context.close();
	}
}
