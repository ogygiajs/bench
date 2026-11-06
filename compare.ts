#!/usr/bin/env node
// Turn one A/B run into the body of the benchmark comment on the ogygia PR.
//
//   node compare.ts --run run.json [--run-url <url>] [--out comment.md]
//
// The run is benchmark.ts --ab JSON: the PR's ogygia (`ogygia`) and its base build
// (`ogygia-base`), built and measured in the same job on the same runner, interleaved, with every
// pass kept (`samples`). Comparing with a result from another run would compare two machines:
// GitHub-hosted runners differ by up to 2× in server throughput for the same code. A run without
// a base build is not an error: the comment then shows the PR's numbers alone. The verdict lives
// in the text, so the exit code is 0 either way; CI never fails on a slower run.
//
// The comment is grouped by scenario: one short summary table (a row per scenario, a few headline
// metrics), then every metric of each scenario in its own <details>.
import { readFileSync, writeFileSync } from 'node:fs';
import { METRICS, kb, kindOf, labelOf } from './harness/metrics.ts';
import { BASE_ID, PR_ID } from './harness/ab.ts';

// The workflow finds the existing comment by this line and edits it in place.
const MARKER = '<!-- ogygia-benchmarks -->';
const OGYGIA_REPO = 'ogygiajs/ogygia';

// A metric with at least this many repeats of each build is judged against its own noise.
const MIN_REPEATS = 3;

// Metrics measured once per build: sizes, counts and lines of code come out the same every time
// (exact); build time is one timing. These are judged against their floor alone.
const ONCE = new Set(['jsBr', 'jsRaw', 'htmlBr', 'cacheable', 'buildMs', 'outBytes', 'loc', 'locCode', 'locConfig']);

// The smallest change that counts, in the metric's own unit (`abs`) and in percent of the base
// (`pct`); a change has to exceed both. For a timing this is only the size below which a change
// does not matter; whether it is noise is decided by the repeats (see judge). For a metric
// measured once it is the whole rule. A scenario key `<metric>:<detail>` uses its metric's floor.
const FLOOR = {
	score: { abs: 1 },
	lcp: { abs: 10 },
	tbt: { abs: 10 },
	cls: { abs: 0.005 },
	evalMs: { abs: 5 },
	dom: { pct: 2, abs: 5 },
	jsBr: { pct: 1, abs: 256 },
	jsRaw: { pct: 1, abs: 512 },
	htmlBr: { pct: 2, abs: 256 },
	// Event Timing reports durations in 8 ms steps: a change has to be more than one step.
	inp: { abs: 8 },
	resp: { abs: 5 },
	navMs: { abs: 5 },
	visitBr: { pct: 2, abs: 1024 },
	heapMb: { abs: 0.1 },
	ttfb: { abs: 0.5 },
	htmlMs: { abs: 0.5 },
	// autocannon reports latency in whole milliseconds.
	p50: { abs: 1 },
	p99: { abs: 2 },
	vps: { pct: 1 },
	reqsPerView: { abs: 0 },
	ttft: { abs: 5 },
	streamMs: { abs: 10 },
	ttfc: { abs: 0.5 },
	streamTotal: { abs: 10 },
	updateMs: { abs: 0.2 },
	personalMs: { abs: 5 },
	cacheable: { abs: 0 },
	// One build each, one after the other: only a large change is more than install and disk noise.
	buildMs: { pct: 25, abs: 3000 },
	outBytes: { pct: 1, abs: 1024 },
	loc: { abs: 0 },
	locCode: { abs: 0 },
	locConfig: { abs: 0 }
};

// The summary table's columns: the first key a scenario has from each list.
const SUMMARY = [
	{ head: 'Load', keys: ['lcp'] },
	{ head: 'JS', keys: ['jsBr'] },
	{ head: 'INP', keys: ['inp'] },
	{ head: 'Nav / token / tick', keys: ['navMs', 'ttft', 'updateMs'] },
	{ head: 'Server views / s', keys: ['vps'] },
	{ head: 'Lines of code', keys: ['loc'] }
];

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const spreadOf = (xs) => Math.max(...xs) - Math.min(...xs);

/**
 * How the PR sits against the base. With repeats of both builds, a metric regressed only when
 *   1. every PR repeat is worse than every base repeat (the two sets of repeats do not overlap:
 *      with 5 and 5 that happens by chance once in 252 for two builds that perform the same),
 *   2. the medians differ by more than the larger spread (max − min) of the two builds' repeats,
 *      the noise the runner showed for the same build within this job,
 *   3. and the difference is above the metric's floor.
 * A metric measured once is judged by its floor; a timing without enough repeats is not judged.
 */
function judge(key, pr, base, prS, baseS) {
	const kind = kindOf(key);
	const sign = METRICS[kind].better === 'lower' ? 1 : -1;
	const { pct = 0, abs = 0 } = FLOOR[kind] ?? {};
	const floorOf = (b) => Math.max(abs, (Math.abs(b) * pct) / 100);
	if (prS?.length >= MIN_REPEATS && baseS?.length >= MIN_REPEATS) {
		const p = median(prS);
		const b = median(baseS);
		const worse = sign * (p - b);
		const spread = [spreadOf(prS), spreadOf(baseS)];
		const apart = sign > 0 ? Math.min(...prS) > Math.max(...baseS) : Math.max(...prS) < Math.min(...baseS);
		return { pr: p, base: b, diff: p - b, spread, regressed: apart && worse > Math.max(...spread) && worse > floorOf(b) };
	}
	if (ONCE.has(kind)) return { pr, base, diff: pr - base, once: true, regressed: sign * (pr - base) > floorOf(base) };
	return { pr, base, diff: pr - base, unjudged: true, regressed: false };
}

const fmt = (key, n) => METRICS[kindOf(key)].fmt(n);
// A magnitude in the metric's unit; byte amounts under a kilobyte read better in bytes.
const mag = (key, n) => (METRICS[kindOf(key)].fmt === kb && Math.abs(n) < 1024 ? `${Math.round(Math.abs(n))} B` : fmt(key, Math.abs(n)));

function signed(key, diff, base) {
	const sign = diff > 0 ? '+' : diff < 0 ? '−' : '±';
	const rel = base ? ` (${sign}${((Math.abs(diff) / Math.abs(base)) * 100).toFixed(1)}%)` : '';
	return `${sign}${mag(key, diff)}${rel}`;
}

function spreadCell(key, j) {
	if (j.spread) return `${mag(key, j.spread[0])} / ${mag(key, j.spread[1])}`;
	if (j.once) return kindOf(key) === 'buildMs' ? 'one build' : 'exact';
	return 'too few repeats';
}

const readJson = (file) => {
	if (!file) return null;
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
};

const short = (sha) => (sha ? sha.slice(0, 7) : null);
const commitLink = (sha) =>
	sha ? `[\`${short(sha)}\`](https://github.com/${OGYGIA_REPO}/commit/${sha})` : null;

function describe(build) {
	const parts = [build?.ogygia ? `\`${build.ogygia}\`` : '`unknown version`'];
	if (build?.sha) parts.push(commitLink(build.sha));
	return parts.join(' @ ');
}

/**
 * One build's metrics and repeats per group: `{ blog: { metrics, samples }, docs: {...}, ... }`.
 * The blog merges the top-level Lighthouse result (averages and per-post sizes) with its
 * scenario's browser-session metrics; the top level wins where both have a key.
 */
function groups(run, id) {
	const out = {};
	const fw = run?.frameworks?.find((f) => f.id === id);
	if (fw) {
		const metrics = {};
		for (const k of ['score', 'lcp', 'tbt', 'cls', 'evalMs', 'dom']) if (fw.avg?.[k] != null) metrics[k] = fw.avg[k];
		for (const r of fw.rows ?? [])
			for (const k of ['jsBr', 'jsRaw', 'htmlBr']) if (r[k] != null) metrics[`${k}:${r.post}`] = r[k];
		out.blog = { metrics, samples: { ...(fw.samples ?? {}) } };
	}
	for (const [name, s] of Object.entries(run?.scenarios ?? {})) {
		const f = s.frameworks?.find((x) => x.id === id);
		if (!f?.metrics) continue;
		const top = name === 'blog' ? out.blog : null;
		out[name] = {
			metrics: { ...f.metrics, ...(top?.metrics ?? {}) },
			samples: { ...(f.samples ?? {}), ...(top?.samples ?? {}) }
		};
	}
	// The blog's per-post JS replaces the per-route average for the blog's summary cell.
	const blog = out.blog?.metrics;
	if (blog && blog.jsBr == null) {
		const posts = Object.keys(blog).filter((k) => k.startsWith('jsBr:'));
		if (posts.length) blog.jsBr = posts.reduce((s, k) => s + blog[k], 0) / posts.length;
	}
	return out;
}

const ORDER = Object.keys(METRICS);
const byMetric = (a, b) =>
	ORDER.indexOf(kindOf(a)) - ORDER.indexOf(kindOf(b)) ||
	(a.includes(':') ? 1 : 0) - (b.includes(':') ? 1 : 0) ||
	a.localeCompare(b);

function compare(run, runUrl) {
	const prG = groups(run, PR_ID);
	if (!Object.keys(prG).length) throw new Error('the run has no ogygia numbers');
	const baseG = groups(run, BASE_ID);
	const hasBase = Object.keys(baseG).length > 0;
	const meta = run.meta ?? {};
	const passes = meta.passes;
	const scenarioPasses = meta.scenarioPasses ?? passes;

	const regressions = [];
	const summary = [];
	const details = [];
	for (const [name, { metrics, samples }] of Object.entries(prG)) {
		const b = baseG[name] ?? null;
		const keys = Object.keys(metrics).filter((k) => METRICS[kindOf(k)]).sort(byMetric);
		const worse = [];
		const rows = [];
		const judged = {};
		for (const key of keys) {
			const bv = b?.metrics[key];
			if (b && bv != null) {
				const j = judge(key, metrics[key], bv, samples[key], b.samples[key]);
				judged[key] = j;
				if (j.regressed) worse.push(labelOf(key));
				const mark = j.regressed ? '⚠️' : j.unjudged ? '·' : '✅';
				rows.push(`| ${labelOf(key)} | ${fmt(key, j.pr)} | ${fmt(key, j.base)} | ${signed(key, j.diff, j.base)} | ${spreadCell(key, j)} | ${mark} |`);
			} else rows.push(b ? `| ${labelOf(key)} | ${fmt(key, metrics[key])} | n/a | | | |` : `| ${labelOf(key)} | ${fmt(key, metrics[key])} |`);
		}
		regressions.push(...worse.map((w) => `${name}: ${w}`));

		const cells = SUMMARY.map(({ keys: ks }) => {
			const key = ks.find((k) => metrics[k] != null);
			if (!key) return '–';
			const j = judged[key];
			if (!j) return fmt(key, metrics[key]);
			const pct = j.base ? Math.round((Math.abs(j.diff) / Math.abs(j.base)) * 100) : 0;
			const rel = pct ? ` (${j.diff > 0 ? '+' : '−'}${pct}%)` : '';
			return `${fmt(key, j.pr)}${rel}${j.regressed ? ' ⚠️' : ''}`;
		});
		const status = !b ? '' : worse.length ? `⚠️ ${worse.length}` : '✅';
		summary.push(`| ${name} | ${cells.join(' | ')} | ${status} |`);

		const head = b
			? ['| Metric | This PR | Base | Change | Spread (PR / base) | |', '|---|---:|---:|---:|---:|:-:|']
			: ['| Metric | This PR |', '|---|---:|'];
		details.push(
			`<details><summary><b>${name}</b>${worse.length ? `: ⚠️ ${worse.join(', ')}` : ''}</summary>`,
			'',
			...head,
			...rows,
			'',
			'</details>',
			''
		);
	}

	const lines = [MARKER, '### ogygia benchmarks', ''];
	const repeats = scenarioPasses === passes ? `${passes}` : `${scenarioPasses} (the blog's Lighthouse: ${passes})`;
	if (hasBase) {
		lines.push(
			regressions.length
				? `⚠️ **${regressions.length} metric${regressions.length === 1 ? '' : 's'} got worse beyond noise:** ${regressions.join(', ')}.`
				: '✅ **No regressions beyond noise.**',
			'',
			`This PR: ogygia ${describe(meta)}. Base: ogygia ${describe(meta.base)}. Both built and measured in this run, on one runner${meta.runner?.cpu ? ` (${meta.runner.cpu}, ${meta.runner.cores} cores)` : ''}, taking turns: ${repeats} repeats of each.`
		);
	} else {
		lines.push(
			'No base build was measured in this run, so there is nothing to compare against. These are the absolute numbers.',
			'',
			`This PR: ogygia ${describe(meta)}.`
		);
	}
	lines.push(
		'',
		`| Scenario | ${SUMMARY.map((c) => c.head).join(' | ')} | |`,
		`|---|${SUMMARY.map(() => '---:').join('|')}|:-:|`,
		...summary,
		'',
		'<sub>ogygia only. Load = Lighthouse LCP; JS = brotli JS per route; INP = worst scripted step; Nav / token / tick = client navigation (blog, docs, shop), send to first token on screen (ai-chat), one live update (dashboard); Server views / s = page views per second under load. Every metric of a scenario is in its row below.</sub>',
		'',
		...details
	);

	const floors = Object.entries(FLOOR)
		.filter(([key]) => Object.values(prG).some(({ metrics }) => Object.keys(metrics).some((k) => kindOf(k) === key)))
		.map(([key, { pct = 0, abs = 0 }]) => {
			if (!pct && !abs) return `\`${key}\` any change`;
			const parts = [];
			if (pct) parts.push(`${pct}%`);
			if (abs) parts.push(METRICS[key].fmt === kb ? `${abs} B` : METRICS[key].fmt(abs));
			return `\`${key}\` ${parts.join(' and ')}`;
		})
		.join(', ');
	lines.push(
		'<details><summary>How to read this</summary>',
		'',
		`The PR's ogygia and its base commit's ogygia are built from the same app sources and measured in this one job, on one GitHub-hosted runner, taking turns: every pass measures both, in the order PR then base, then base then PR, and so on. Each timing is the median of its repeats; Spread is max − min of each build's repeats, the noise this runner showed for one build. Lighthouse runs mobile with simulated throttling on the blog's three posts and on one page per scenario; browser sessions run in Chrome with 4× CPU throttling and a 40 ms / 10 Mbps network; server apps are loaded by 10 connections replaying one page view. The README defines every metric.`,
		'',
		`A timing gets ⚠️ only when every one of the PR's repeats is worse than every one of the base's, the medians differ by more than the larger Spread, and the change is above its floor. Sizes and lines of code are exact (measured once): ⚠️ when worse by more than the floor. A metric with fewer than ${MIN_REPEATS} repeats is not judged (·). Floors (the change has to exceed both parts): ${floors}.`,
		'',
		'</details>',
		''
	);
	if (runUrl) lines.push(`[Benchmark run](${runUrl})`);
	return { body: lines.join('\n') + '\n', regressions };
}

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--run') args.run = argv[++i];
		else if (a === '--run-url') args.runUrl = argv[++i];
		else if (a === '--out') args.out = argv[++i];
	}
	if (!args.run) throw new Error('usage: node compare.ts --run run.json [--run-url <url>] [--out comment.md]');
	return args;
}

const args = parseArgs(process.argv.slice(2));
const run = readJson(args.run);
if (!run) throw new Error(`cannot read ${args.run}`);
const { body, regressions } = compare(run, args.runUrl);
if (args.out) writeFileSync(args.out, body);
else process.stdout.write(body);
console.error(
	regressions.length ? `regressions: ${regressions.join(', ')}` : 'no regressions beyond noise'
);
