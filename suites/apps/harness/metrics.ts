// Every scenario metric, defined once: what it is called, its unit, and which way is better. A
// result key is `<metric>` or `<metric>:<detail>` (a route or a step), e.g. `inp:sort`,
// `jsBr:intro`; the detail shares the metric's definition. The floor of each metric (the smallest
// change that counts) lives in compare.ts's FLOOR table.

export const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
export const ms = (n) => `${Math.round(n).toLocaleString('en-US')} ms`;
const mb = (n) => `${n.toFixed(1)} MB`;
const int = (n) => String(Math.round(n));

export const METRICS = {
	// Lighthouse (mobile, simulated throttling), median over passes, averaged over the scenario's
	// Lighthouse routes.
	score: { label: 'Lighthouse score', fmt: int, better: 'higher' },
	lcp: { label: 'LCP', fmt: ms, better: 'lower' },
	tbt: { label: 'TBT', fmt: ms, better: 'lower' },
	cls: { label: 'CLS', fmt: (n) => n.toFixed(3), better: 'lower' },
	evalMs: { label: 'JS eval', fmt: ms, better: 'lower' },
	dom: { label: 'DOM elements', fmt: int, better: 'lower' },
	// The blog's sizes per post (benchmark.ts top level): every script the page loads, raw.
	jsRaw: { label: 'JS raw', fmt: kb, better: 'lower' },
	// Bytes a route loads cold, before any interaction or scroll (brotli). Bare = average of routes.
	jsBr: { label: 'JS per route (brotli)', fmt: kb, better: 'lower' },
	htmlBr: { label: 'HTML per route (brotli)', fmt: kb, better: 'lower' },
	// Interactions under the CPU throttle. `inp:<step>` = the worst Event Timing duration of the
	// interactions that step caused (floored at 16 ms); `resp:<step>` = from the input to the
	// result on screen, which also counts work Event Timing cannot see (a fetch, a lazy hydration).
	inp: { label: 'INP (worst step)', fmt: ms, better: 'lower' },
	resp: { label: 'Input to result (worst step)', fmt: ms, better: 'lower' },
	// A scripted multi-page visit: median click-to-new-page time, and every byte of the visit.
	navMs: { label: 'Client navigation', fmt: ms, better: 'lower' },
	visitBr: { label: 'Bytes over the visit (brotli)', fmt: kb, better: 'lower' },
	// JS heap after the scenario's long session and a forced GC.
	heapMb: { label: 'JS heap after long session', fmt: mb, better: 'lower' },
	// Server apps only: sequential render, then load (10 connections replaying one page view).
	ttfb: { label: 'TTFB (no load)', fmt: (n) => `${n.toFixed(1)} ms`, better: 'lower' },
	htmlMs: { label: 'Document time (no load)', fmt: (n) => `${n.toFixed(1)} ms`, better: 'lower' },
	p50: { label: 'Latency p50 under load', fmt: (n) => `${n.toFixed(1)} ms`, better: 'lower' },
	p99: { label: 'Latency p99 under load', fmt: ms, better: 'lower' },
	vps: { label: 'Page views / s under load', fmt: int, better: 'higher' },
	reqsPerView: { label: 'Server requests per view', fmt: int, better: 'lower' },
	// Streaming (ai-chat): on screen, in the browser, and the raw stream from the server.
	ttft: { label: 'Send to first token on screen', fmt: ms, better: 'lower' },
	streamMs: { label: 'Send to last token on screen', fmt: ms, better: 'lower' },
	ttfc: {
		label: 'Stream: first chunk (server)',
		fmt: (n) => `${n.toFixed(1)} ms`,
		better: 'lower'
	},
	streamTotal: { label: 'Stream: whole reply (server)', fmt: ms, better: 'lower' },
	// Dashboard: the DOM update work of one live tick (median), measured inside the page.
	updateMs: { label: 'Live update cost', fmt: (n) => `${n.toFixed(1)} ms`, better: 'lower' },
	// Shop: from navigation start to the visitor's greeting and cart count on screen.
	personalMs: { label: 'Personal header on screen', fmt: ms, better: 'lower' },
	// Shop: 1 when one copy of the page can be served to every visitor by a shared cache.
	cacheable: {
		label: 'HTML cacheable for everyone',
		fmt: (n) => (n ? 'yes' : 'no'),
		better: 'higher'
	},
	// From build-all.ts: the app's `build` command, and every file in its client output.
	buildMs: { label: 'Build time', fmt: (n) => `${(n / 1000).toFixed(1)} s`, better: 'lower' },
	outBytes: { label: 'Client output size', fmt: kb, better: 'lower' },
	// harness/loc.ts: non-blank, non-comment lines the app's author wrote (its own tracked source
	// and config; shared scenario code and generated content left out).
	loc: { label: 'Lines of code (total)', fmt: int, better: 'lower' },
	locCode: { label: 'Lines of code: source', fmt: int, better: 'lower' },
	locConfig: { label: 'Lines of code: config', fmt: int, better: 'lower' }
};

/** The metric definition of a result key (`inp:sort` → `inp`). */
export const metricOf = (key) => METRICS[key.split(':')[0]];
export const kindOf = (key) => key.split(':')[0];

/** A key's label: the metric's, plus its route or step. */
export function labelOf(key) {
	const [kind, detail] = key.split(':');
	const def = METRICS[kind];
	if (!def) return key;
	if (!detail) return def.label;
	const base = def.label.replace(/ \((worst step|brotli)\)$/, '').replace(/ per route/, '');
	return `${base} (${detail})`;
}

/** The headline keys of each scenario, in the order the summary tables show them. */
export const HEADLINE = [
	'score',
	'lcp',
	'inp',
	'resp',
	'navMs',
	'jsBr',
	'heapMb',
	'ttft',
	'updateMs',
	'personalMs',
	'ttfb',
	'p99',
	'vps',
	'cacheable',
	'loc'
];
