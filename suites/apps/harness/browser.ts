// Scripted browser sessions (Playwright + the DevTools protocol) under the throttling profile:
// interaction latency (INP), client navigation, bytes, JS per route and memory.
import { existsSync } from 'node:fs';
import { brotliCompressSync } from 'node:zlib';
import { BROWSER, INP_FLOOR } from './profile.ts';

/** Chrome: CHROME_PATH, else Playwright's Chromium, else whatever chrome-launcher finds. */
export async function chromePath() {
	if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
	try {
		const { chromium } = await import('playwright');
		const p = chromium.executablePath();
		if (p && existsSync(p)) return p;
	} catch {
		/* playwright absent */
	}
	return undefined;
}

export async function launchBrowser() {
	const { chromium } = await import('playwright');
	return chromium.launch({
		executablePath: await chromePath(),
		headless: true,
		args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
	});
}

const br = (buf) => brotliCompressSync(buf).length;

// Collects every Event Timing entry that belongs to an interaction. Installed before any page
// script, so it sees the first interaction too.
const OBSERVER = () => {
	window.__bench_events = [];
	try {
		new PerformanceObserver((list) => {
			for (const e of list.getEntries())
				if (e.interactionId) window.__bench_events.push({ t: e.startTime, d: e.duration });
		}).observe({ type: 'event', durationThreshold: 16, buffered: true });
	} catch {
		/* no Event Timing */
	}
};

const DESTROYED =
	/context was destroyed|Execution context|navigation|Target closed|frame was detached/i;

/**
 * One session: a fresh browser context (cold cache, no cookies but the scenario's), throttled.
 * Scenario scripts drive it through goto / interact / nav / mark / heap.
 */
export async function openSession(browser, base, { cookies = [], throttle = true } = {}) {
	const context = await browser.newContext({
		viewport: BROWSER.viewport,
		extraHTTPHeaders: { 'accept-encoding': BROWSER.acceptEncoding }
	});
	if (cookies.length) await context.addCookies(cookies.map((c) => ({ ...c, url: base })));
	await context.addInitScript(OBSERVER);
	const page = await context.newPage();
	const cdp = await context.newCDPSession(page);
	if (throttle) {
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: BROWSER.cpuSlowdown });
		await cdp.send('Network.enable');
		await cdp.send('Network.emulateNetworkConditions', { offline: false, ...BROWSER.network });
	}

	let inflight = 0;
	let lastActivity = Date.now();
	const pending = [];
	let bytes = 0;
	const requests = [];
	page.on('request', (req) => {
		inflight++;
		lastActivity = Date.now();
		requests.push(req);
	});
	const settle = () => {
		inflight = Math.max(0, inflight - 1);
		lastActivity = Date.now();
	};
	page.on('requestfailed', settle);
	page.on('requestfinished', (req) => {
		settle();
		pending.push(
			req
				.response()
				.then((res) => (res ? res.body() : null))
				.then((body) => {
					if (body) bytes += br(body);
				})
				.catch(() => {})
		);
	});

	const metrics = {};
	const failures = [];
	const steps = [];

	async function quiet(maxMs = 8000) {
		// The quiet window starts now: whatever the last action set off (a scroll that wakes a
		// lazy island) gets the time to start its requests.
		lastActivity = Math.max(lastActivity, Date.now());
		const until = Date.now() + maxMs;
		while (Date.now() < until) {
			if (inflight === 0 && Date.now() - lastActivity >= BROWSER.quietMs) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		await page
			.evaluate(
				() =>
					new Promise((r) =>
						'requestIdleCallback' in window
							? requestIdleCallback(() => r(), { timeout: 2000 })
							: setTimeout(r, 50)
					)
			)
			.catch(() => {});
	}

	/**
	 * Wait until `done` is truthy in the page: a self-contained function, or an expression string
	 * (for checks that need a value from the script). Resolves to the epoch ms it became so.
	 */
	async function until(done, timeout = BROWSER.stepTimeoutMs) {
		const check = typeof done === 'string' ? `(${done})` : `(${done.toString()})()`;
		const expr = `${check} && (performance.timeOrigin + performance.now())`;
		const deadline = Date.now() + timeout;
		for (;;) {
			try {
				const h = await page.waitForFunction(expr, null, {
					polling: 'raf',
					timeout: Math.max(1, deadline - Date.now())
				});
				return await h.jsonValue();
			} catch (e) {
				if (Date.now() < deadline && DESTROYED.test(String(e?.message))) continue;
				const url = page.url().replace(base, '');
				throw new Error(
					`timed out on ${url} waiting for ${check.replace(/\s+/g, ' ').slice(0, 140)} (${String(e?.message).split('\n')[0]})`
				);
			}
		}
	}

	const now = () => page.evaluate(() => performance.timeOrigin + performance.now());

	const s = {
		page,
		base,
		metrics,
		steps,
		/** Load a path cold and wait until the page is ready (load + network quiet + idle). */
		async goto(path) {
			await page.goto(base + path, { waitUntil: 'load', timeout: 60000 });
			await quiet();
		},
		ready: quiet,
		until,
		/**
		 * One interaction: `action` drives the page, `done` (runs in the page) says the result is on
		 * screen. Records `inp:<name>` (worst Event Timing duration of the interactions it caused)
		 * and `resp:<name>` (last input of the action to result on screen, ms).
		 */
		async interact(name, action, done) {
			await page.evaluate(() => (window.__bench_events = [])).catch(() => {});
			const start = await now();
			await action(page);
			// `resp` counts from the last input the action dispatched (the click, the final key).
			const t0 = await now();
			const t1 = await until(done).catch((e) => {
				throw new Error(`step ${name}: ${e.message}`);
			});
			// Event Timing entries are queued after the next paint; give them two frames to arrive.
			await page
				.evaluate(
					() =>
						new Promise((r) =>
							requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60)))
						)
				)
				.catch(() => {});
			const events = await page.evaluate(() => window.__bench_events ?? []).catch(() => []);
			const origin = await page.evaluate(() => performance.timeOrigin);
			const inWindow = events.filter((e) => origin + e.t >= start - 1);
			const worst = inWindow.reduce((m, e) => Math.max(m, e.d), 0);
			const inp = Math.max(INP_FLOOR, worst);
			metrics[`inp:${name}`] = Math.max(metrics[`inp:${name}`] ?? 0, inp);
			metrics[`resp:${name}`] = Math.max(metrics[`resp:${name}`] ?? 0, t1 - t0);
			steps.push({ kind: 'interact', name, inp, resp: t1 - t0 });
		},
		/** One client navigation: `action` clicks, `done` (runs in the new page) says it arrived. */
		async nav(name, action, done) {
			const t0 = await now();
			await action(page);
			const t1 = await until(done).catch((e) => {
				throw new Error(`nav ${name}: ${e.message}`);
			});
			steps.push({ kind: 'nav', name, ms: t1 - t0 });
			await quiet();
		},
		/** A metric the scenario measures itself (e.g. time to first token). */
		mark(key, value) {
			metrics[key] = value;
		},
		/** Brotli bytes of every response so far in this session. */
		async bytes() {
			await quiet(3000);
			await Promise.all(pending.splice(0));
			return bytes;
		},
		/** JS heap after a forced garbage collection, in MB. */
		async heap() {
			await cdp.send('HeapProfiler.enable').catch(() => {});
			await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
			await cdp.send('Performance.enable');
			const { metrics: m } = await cdp.send('Performance.getMetrics');
			const used = m.find((x) => x.name === 'JSHeapUsedSize')?.value ?? 0;
			return used / (1024 * 1024);
		},
		/**
		 * The same-origin requests that hit the app rather than a static file (the document, data
		 * and fragment fetches, a batched POST of server islands), for the load test to replay:
		 * `{ method, path, body?, contentType? }`.
		 */
		serverRequests() {
			const origin = new URL(base).origin;
			const seen = new Set();
			const out = [];
			for (const r of requests) {
				const u = new URL(r.url());
				if (u.origin !== origin || !['GET', 'POST'].includes(r.method())) continue;
				const type = r.resourceType();
				// A fetch an inline script starts while the page parses can be typed `other`.
				const dynamic =
					['document', 'fetch', 'xhr', 'eventsource'].includes(type) ||
					(type === 'other' && !/\.[a-z0-9]+$/i.test(u.pathname));
				if (!dynamic) continue;
				const path = u.pathname + u.search;
				const body = r.method() === 'POST' ? (r.postData() ?? '') : undefined;
				const key = `${r.method()} ${path} ${body ?? ''}`;
				if (seen.has(key)) continue;
				seen.add(key);
				out.push({ method: r.method(), path, body, contentType: r.headers()['content-type'] });
			}
			return out;
		},
		fail(msg) {
			failures.push(msg);
		},
		failures,
		async close() {
			await context.close().catch(() => {});
		}
	};
	return s;
}

/**
 * JS and HTML a route loads cold, before any interaction or scroll: brotli bytes of every script
 * response and of the document. Unthrottled, since only bytes are counted.
 */
export async function routeWeight(browser, base, path, { cookies = [] } = {}) {
	const context = await browser.newContext({
		viewport: BROWSER.viewport,
		extraHTTPHeaders: { 'accept-encoding': BROWSER.acceptEncoding }
	});
	if (cookies.length) await context.addCookies(cookies.map((c) => ({ ...c, url: base })));
	const page = await context.newPage();
	const jobs = [];
	let js = 0;
	let jsRaw = 0;
	let html = 0;
	let scripts = 0;
	page.on('requestfinished', (req) => {
		const type = req.resourceType();
		if (type !== 'script' && !(type === 'document' && req.frame() === page.mainFrame())) return;
		jobs.push(
			req
				.response()
				.then((res) => res?.body())
				.then((body) => {
					if (!body) return;
					if (type === 'script') {
						js += br(body);
						jsRaw += body.length;
						scripts++;
					} else html += br(body);
				})
				.catch(() => {})
		);
	});
	try {
		await page.goto(base + path, { waitUntil: 'load', timeout: 60000 });
		await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
		await page.waitForTimeout(300);
		await Promise.all(jobs);
		return { jsBr: js, jsRaw, htmlBr: html, scripts };
	} finally {
		await context.close();
	}
}
