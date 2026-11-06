// One Lighthouse page load (mobile, simulated throttling, performance only), for the scenarios,
// and the JS eval time both the blog (benchmark.ts) and the scenarios read from its trace.
import lighthouse from 'lighthouse';
import { TraceProcessor } from 'lighthouse/core/lib/tracehouse/trace-processor.js';
import { MainThreadTasks } from 'lighthouse/core/lib/tracehouse/main-thread-tasks.js';
import { launch } from 'chrome-launcher';
import { chromePath } from './browser.ts';

// Time the main thread spends on JS (evaluation + parse/compile) for the measured page load,
// scaled by the CPU slowdown like Lighthouse's own numbers. Unlike TBT this isn't windowed
// between FCP and TTI, so it stays meaningful when the two coincide.
//
// This reads the trace rather than the `bootup-time` audit, which gets it wrong twice:
//   - it sums every main-thread task in the trace, including ones from before the navigation.
//     Chrome sometimes hands back the renderer's events from before tracing started, and then
//     Lighthouse's own ~1 s CPU benchmark on about:blank lands in the trace and is charged to
//     the page's document (x4 for throttling, ~3.9 s). It happens on the second Lighthouse run
//     in a Chrome session, whichever page that is.
//   - it drops every URL whose total is under 50 ms, so the scripts of a light page don't count.
// Here only top-level tasks that start at or after navigationStart count, and every one does,
// except Lighthouse's own page evaluations (tagged `_lighthouse-eval.js`).
const LIGHTHOUSE_EVAL = /(^|\/)_lighthouse-eval\.js$/;
export function scriptTime(trace, settings) {
	const { mainThreadEvents, frames, timestamps } = TraceProcessor.processTrace(trace);
	const tasks = MainThreadTasks.getMainThreadTasks(
		mainThreadEvents,
		frames,
		timestamps.traceEnd,
		timestamps.timeOrigin
	);
	const sum = (task) =>
		task.attributableURLs.some((url) => LIGHTHOUSE_EVAL.test(url))
			? 0
			: (task.group.id === 'scriptEvaluation' || task.group.id === 'scriptParseCompile'
					? task.selfTime
					: 0) + task.children.reduce((s, c) => s + sum(c), 0);
	const ms = tasks
		.filter((task) => !task.parent && task.startTime >= 0)
		.reduce((s, task) => s + sum(task), 0);
	const slowdown =
		settings.throttlingMethod === 'simulate' ? settings.throttling.cpuSlowdownMultiplier : 1;
	return ms * slowdown;
}

export async function startChrome() {
	return launch({
		chromePath: await chromePath(),
		chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
	});
}

export async function runLighthouse(url, chromePort, acceptEncoding) {
	const runner = await lighthouse(url, {
		port: chromePort,
		output: 'json',
		logLevel: 'error',
		onlyCategories: ['performance'],
		extraHeaders: { 'Accept-Encoding': acceptEncoding }
	});
	const a = runner.lhr.audits;
	const num = (k) => (a[k] && a[k].numericValue != null ? a[k].numericValue : null);
	return {
		score: Math.round((runner.lhr.categories.performance.score ?? 0) * 100),
		lcp: num('largest-contentful-paint'),
		cls: num('cumulative-layout-shift'),
		tbt: num('total-blocking-time'),
		evalMs: scriptTime(runner.artifacts.Trace, runner.lhr.configSettings)
	};
}
