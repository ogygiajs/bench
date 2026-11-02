// Server-side metrics for the apps that run their own server: render time, TTFB under load,
// a stream's time to first chunk, and whether a page can be shared by a cache.
import autocannon from 'autocannon';
import { SERVER } from './profile.ts';

const median = (xs) => {
	const s = xs.filter((x) => x != null).sort((a, b) => a - b);
	if (!s.length) return null;
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const cookieHeader = (cookies) => cookies.map((c) => `${c.name}=${c.value}`).join('; ');

/**
 * Sequential requests, one at a time: `ttfb` = time to the response headers, `htmlMs` = time to
 * the whole body (the render time, for a page that does not stream). Medians.
 */
export async function renderTime(base, path, { cookies = [], samples = SERVER.samples } = {}) {
	const headers = { 'accept-encoding': 'identity', cookie: cookieHeader(cookies) };
	// Warm-up: the first requests of a fresh process pay for module loading and JIT.
	for (let i = 0; i < 5; i++) await (await fetch(base + path, { headers })).arrayBuffer();
	const ttfb = [];
	const full = [];
	for (let i = 0; i < samples; i++) {
		const t0 = performance.now();
		const res = await fetch(base + path, { headers });
		ttfb.push(performance.now() - t0);
		await res.arrayBuffer();
		full.push(performance.now() - t0);
	}
	return { ttfb: median(ttfb), htmlMs: median(full) };
}

/**
 * Load: `connections` clients replay the requests one page view makes to the server (the document
 * plus any data or fragment requests the browser made), round-robin, for `duration` seconds.
 * `p99` is request latency under that load; `vps` is page views per second (requests per second
 * divided by requests per view).
 */
export async function loadTest(base, view, { cookies = [], duration = SERVER.duration.full } = {}) {
	const headers = { 'accept-encoding': 'identity' };
	if (cookies.length) headers.cookie = cookieHeader(cookies);
	// `view` holds paths (GET) or recorded requests ({ method, path, body, contentType }).
	const requests = view.map((r) =>
		typeof r === 'string'
			? { method: 'GET', path: r }
			: {
					method: r.method,
					path: r.path,
					...(r.method === 'POST'
						? { body: r.body, headers: { ...headers, origin: base, 'content-type': r.contentType ?? 'text/plain' } }
						: {})
				}
	);
	const result = await autocannon({
		url: base,
		connections: SERVER.connections,
		duration,
		headers,
		requests,
		timeout: 10
	});
	const ok = result.non2xx === 0 && result.errors === 0 && result.timeouts === 0;
	return {
		p50: result.latency.p50,
		p99: result.latency.p99,
		vps: result.requests.average / view.length,
		reqsPerView: view.length,
		ok,
		non2xx: result.non2xx,
		errors: result.errors + result.timeouts
	};
}

/**
 * A streamed response (the chat reply): time to the first chunk that carries content, and to the
 * end of the stream. Medians over sequential requests.
 */
export async function streamTiming(base, { path, method = 'POST', body, cookies = [] }, samples = SERVER.streamSamples) {
	const firsts = [];
	const totals = [];
	for (let i = 0; i < samples; i++) {
		const t0 = performance.now();
		const res = await fetch(base + path, {
			method,
			headers: {
				'content-type': 'application/json',
				'accept-encoding': 'identity',
				origin: base,
				cookie: cookieHeader(cookies)
			},
			body: body ? JSON.stringify(body) : undefined
		});
		let first = null;
		const reader = res.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (first == null && value?.length) first = performance.now() - t0;
		}
		firsts.push(first);
		totals.push(performance.now() - t0);
	}
	return { ttfc: median(firsts), streamTotal: median(totals) };
}

/**
 * Can a shared cache (a CDN) serve this page's HTML to everyone? Yes when no visitor's document
 * carries that visitor's personal content (`markers`, e.g. "Hello, Ada") and the response does not
 * forbid sharing (private / no-store) or set a cookie. Byte equality would be too strict: a page
 * may carry per-render tokens that are the same for anyone who gets them.
 */
export async function cacheability(base, path, visitors) {
	const reasons = [];
	for (const { cookies, markers } of visitors) {
		const res = await fetch(base + path, {
			headers: { 'accept-encoding': 'identity', cookie: cookieHeader(cookies) }
		});
		const cc = res.headers.get('cache-control') ?? '';
		if (/private|no-store/i.test(cc)) reasons.push(`cache-control: ${cc}`);
		if (res.headers.get('set-cookie')) reasons.push('sets a cookie');
		const html = await res.text();
		for (const m of markers) if (html.includes(m)) reasons.push(`HTML contains "${m}"`);
	}
	return { cacheable: reasons.length ? 0 : 1, reasons: [...new Set(reasons)] };
}
