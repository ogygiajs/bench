// The conditions every scenario runs under, in one place. Every framework gets exactly these.

/** Browser sessions (INP, navigation, memory): real throttling through the DevTools protocol. */
export const BROWSER = {
	// The same CPU slowdown Lighthouse's mobile preset uses.
	cpuSlowdown: 4,
	// A CDN-near mobile connection, applied per request. Pages are served uncompressed (the same
	// `identity` encoding the Lighthouse runs use), so the byte metrics are brotli sizes the harness
	// computes, not what this profile puts on the wire.
	network: { latency: 40, downloadThroughput: (10 * 1024 * 1024) / 8, uploadThroughput: (5 * 1024 * 1024) / 8 },
	viewport: { width: 1280, height: 800 },
	acceptEncoding: 'identity',
	// "Ready" = the load event, then this long without a request in flight, then an idle callback.
	quietMs: 500,
	// A step that has not produced its result by then fails the run.
	stepTimeoutMs: 15000
};

/** Server load, for the apps that run their own server. */
export const SERVER = {
	connections: 10,
	// Seconds of load per app and pass; FAST runs use the shorter one. `warmup`: an unrecorded load
	// before an app's first pass.
	duration: { full: 5, fast: 3, warmup: 1 },
	// Sequential requests per pass for TTFB and render time (median).
	samples: 25,
	// Sequential requests per pass for a stream's time to first chunk (median).
	streamSamples: 2
};

/** Event Timing only reports interactions of at least this many ms; shorter ones read as this. */
export const INP_FLOOR = 16;
