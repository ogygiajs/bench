#!/usr/bin/env node
// Turn one PR run and the `main` baseline into the body of the benchmark comment on the ogygia PR.
//
//   node compare.ts --pr pr.json [--base main.json] [--run-url <url>] [--out comment.md]
//
// Both files are benchmark.ts JSON. A missing or unreadable --base is not an error: the comment
// then says there is no baseline yet and shows the PR's numbers alone. The verdict lives in the
// text, so the exit code is 0 either way; CI never fails on a slower run.
//
// The comment is grouped by scenario: one short summary table (a row per scenario, a few headline
// metrics), then every metric of each scenario in its own <details>.
import { readFileSync, writeFileSync } from 'node:fs';
import { METRICS, kb, kindOf, labelOf } from './harness/metrics.ts';

// The workflow finds the existing comment by this line and edits it in place.
const MARKER = '<!-- ogygia-benchmarks -->';
const OGYGIA_REPO = 'ogygiajs/ogygia';

// Noise, defined in this one place. A change counts as a regression only when it is worse than
// the baseline by more than BOTH `pct` percent of the baseline AND `abs` (in the metric's own
// unit). Lighthouse timings on a shared runner wobble by a few percent even with medians, so they
// get wide floors; sizes come out the same on every run, so their floors only skip rounding-level
// changes. A scenario key `<metric>:<detail>` uses its metric's floor.
const NOISE = {
	score: { pct: 0, abs: 3 },
	lcp: { pct: 5, abs: 100 },
	tbt: { pct: 10, abs: 50 },
	cls: { pct: 0, abs: 0.02 },
	evalMs: { pct: 10, abs: 25 },
	dom: { pct: 2, abs: 5 },
	jsBr: { pct: 1, abs: 256 },
	jsRaw: { pct: 1, abs: 512 },
	htmlBr: { pct: 2, abs: 256 },
	// Scenario metrics (harness/metrics.ts defines each one). Browser-session timings run with real
	// CPU throttling on a shared runner, so they get wide floors; Event Timing rounds to 8 ms.
	inp: { pct: 15, abs: 16 },
	resp: { pct: 15, abs: 30 },
	navMs: { pct: 10, abs: 60 },
	visitBr: { pct: 2, abs: 1024 },
	heapMb: { pct: 10, abs: 0.5 },
	ttfb: { pct: 25, abs: 2 },
	htmlMs: { pct: 25, abs: 3 },
	p50: { pct: 25, abs: 3 },
	p99: { pct: 30, abs: 10 },
	vps: { pct: 20, abs: 50 },
	reqsPerView: { pct: 0, abs: 0 },
	ttft: { pct: 15, abs: 40 },
	streamMs: { pct: 10, abs: 100 },
	ttfc: { pct: 30, abs: 5 },
	streamTotal: { pct: 10, abs: 100 },
	updateMs: { pct: 20, abs: 1 },
	personalMs: { pct: 15, abs: 60 },
	cacheable: { pct: 0, abs: 0 },
	buildMs: { pct: 25, abs: 3000 },
	outBytes: { pct: 1, abs: 1024 },
	// Lines of code only change when an app's source does; any change is shown, none is noise.
	loc: { pct: 0, abs: 0 },
	locCode: { pct: 0, abs: 0 },
	locConfig: { pct: 0, abs: 0 }
};

// The summary table's columns: the first key a scenario has from each list.
const SUMMARY = [
	{ head: 'Load', keys: ['lcp'] },
	{ head: 'JS', keys: ['jsBr'] },
	{ head: 'INP', keys: ['inp'] },
	{ head: 'Nav / token / tick', keys: ['navMs', 'ttft', 'updateMs'] },
	{ head: 'Server p99', keys: ['p99'] },
	{ head: 'Lines of code', keys: ['loc'] }
];

/** How a PR value sits against the baseline: the change, and whether it is a regression. */
function judge(key, pr, base) {
	const kind = kindOf(key);
	const diff = pr - base;
	const worse = METRICS[kind].better === 'lower' ? diff : -diff;
	const { pct, abs } = NOISE[kind] ?? { pct: 0, abs: 0 };
	const floor = Math.max(abs, (Math.abs(base) * pct) / 100);
	return { diff, regressed: worse > floor };
}

const fmt = (key, n) => METRICS[kindOf(key)].fmt(n);

function signed(key, diff, base) {
	const def = METRICS[kindOf(key)];
	const sign = diff > 0 ? '+' : diff < 0 ? '−' : '±';
	// Byte changes under a kilobyte read better in bytes than as "+0.0 KB".
	const small = def.fmt === kb && Math.abs(diff) < 1024;
	const mag = small ? `${Math.round(Math.abs(diff))} B` : def.fmt(Math.abs(diff));
	const rel = base ? ` (${sign}${((Math.abs(diff) / Math.abs(base)) * 100).toFixed(1)}%)` : '';
	return `${sign}${mag}${rel}`;
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

function describe(run) {
	const m = run.meta ?? {};
	const parts = [m.ogygia ? `\`${m.ogygia}\`` : '`unknown version`'];
	if (m.sha) parts.push(commitLink(m.sha));
	return parts.join(' @ ');
}

/**
 * Every group's metrics for one framework: `{ blog: {key: n}, docs: {...}, ... }`. The blog
 * merges the top-level Lighthouse result (averages and per-post sizes) with its scenario's
 * browser-session metrics; the top level wins where both have a key.
 */
function groups(run, id) {
	const out = {};
	const fw = run?.frameworks?.find((f) => f.id === id);
	if (fw) {
		const blog = {};
		for (const k of ['score', 'lcp', 'tbt', 'cls', 'evalMs', 'dom']) if (fw.avg?.[k] != null) blog[k] = fw.avg[k];
		for (const r of fw.rows ?? [])
			for (const k of ['jsBr', 'jsRaw', 'htmlBr']) if (r[k] != null) blog[`${k}:${r.post}`] = r[k];
		out.blog = blog;
	}
	for (const [name, s] of Object.entries(run?.scenarios ?? {})) {
		const m = s.frameworks?.find((f) => f.id === id)?.metrics;
		if (!m) continue;
		out[name] = name === 'blog' ? { ...m, ...(out.blog ?? {}) } : { ...m };
	}
	// The blog's per-post JS replaces the per-route average for the blog's summary cell.
	if (out.blog && out.blog.jsBr == null) {
		const posts = Object.keys(out.blog).filter((k) => k.startsWith('jsBr:'));
		if (posts.length) out.blog.jsBr = posts.reduce((s, k) => s + out.blog[k], 0) / posts.length;
	}
	return out;
}

const ORDER = Object.keys(METRICS);
const byMetric = (a, b) =>
	ORDER.indexOf(kindOf(a)) - ORDER.indexOf(kindOf(b)) ||
	(a.includes(':') ? 1 : 0) - (b.includes(':') ? 1 : 0) ||
	a.localeCompare(b);

function compare(pr, base, runUrl) {
	const prG = groups(pr, 'ogygia');
	if (!Object.keys(prG).length) throw new Error('the PR result has no ogygia numbers');
	const baseG = base ? groups(base, 'ogygia') : null;
	const passes = pr.meta?.passes;
	const scenarioPasses = pr.meta?.scenarioPasses ?? passes;

	const regressions = [];
	const summary = [];
	const details = [];
	for (const [name, metrics] of Object.entries(prG)) {
		const b = baseG?.[name] ?? null;
		const keys = Object.keys(metrics).filter((k) => METRICS[kindOf(k)]).sort(byMetric);
		const worse = [];
		const rows = [];
		for (const key of keys) {
			const p = metrics[key];
			const bv = b?.[key];
			if (b && bv != null) {
				const { diff, regressed } = judge(key, p, bv);
				if (regressed) worse.push(labelOf(key));
				rows.push(`| ${labelOf(key)} | ${fmt(key, p)} | ${fmt(key, bv)} | ${signed(key, diff, bv)} | ${regressed ? '⚠️' : '✅'} |`);
			} else rows.push(b ? `| ${labelOf(key)} | ${fmt(key, p)} | n/a | | |` : `| ${labelOf(key)} | ${fmt(key, p)} |`);
		}
		regressions.push(...worse.map((w) => `${name}: ${w}`));

		const cells = SUMMARY.map(({ keys: ks }) => {
			const key = ks.find((k) => metrics[k] != null);
			if (!key) return '–';
			const bv = b?.[key];
			if (bv == null) return fmt(key, metrics[key]);
			const { diff, regressed } = judge(key, metrics[key], bv);
			const pct = bv ? Math.round((Math.abs(diff) / Math.abs(bv)) * 100) : 0;
			const rel = pct ? ` (${diff > 0 ? '+' : '−'}${pct}%)` : '';
			return `${fmt(key, metrics[key])}${rel}${regressed ? ' ⚠️' : ''}`;
		});
		const status = !b ? '' : worse.length ? `⚠️ ${worse.length}` : '✅';
		summary.push(`| ${name} | ${cells.join(' | ')} | ${status} |`);

		const head = b
			? ['| Metric | This PR | main | Change | |', '|---|---:|---:|---:|:-:|']
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
	if (baseG) {
		lines.push(
			regressions.length
				? `⚠️ **${regressions.length} metric${regressions.length === 1 ? '' : 's'} got worse beyond noise:** ${regressions.join(', ')}.`
				: '✅ **No regressions beyond noise.**',
			'',
			`This PR: ogygia ${describe(pr)}. Baseline: \`main\`, ogygia ${describe(base)}.`
		);
	} else {
		lines.push(
			'No `main` baseline yet, so there is nothing to compare against. These are the absolute numbers.',
			'',
			`This PR: ogygia ${describe(pr)}.`
		);
	}
	lines.push(
		'',
		`| Scenario | ${SUMMARY.map((c) => c.head).join(' | ')} | |`,
		`|---|${SUMMARY.map(() => '---:').join('|')}|:-:|`,
		...summary,
		'',
		'<sub>ogygia only. Load = Lighthouse LCP; JS = brotli JS per route; INP = worst scripted step; Nav / token / tick = client navigation (blog, docs, shop), send to first token on screen (ai-chat), one live update (dashboard). Every metric of a scenario is in its row below.</sub>',
		'',
		...details
	);

	// The plain-SvelteKit apps never change between the two runs, so a big move there means the
	// runner itself was faster or slower, and the ogygia timings above moved with it.
	if (base) {
		const prKit = groups(pr, 'sveltekit');
		const baseKit = groups(base, 'sveltekit');
		const drift = [];
		for (const [name, m] of Object.entries(prKit)) {
			const bm = baseKit[name];
			if (!bm) continue;
			const parts = ['lcp', 'inp', 'navMs', 'p99']
				.filter((k) => m[k] != null && bm[k] != null)
				.map((k) => `${METRICS[k].label.replace(/ \(.*\)$/, '')} ${signed(k, m[k] - bm[k], bm[k])}`);
			if (parts.length) drift.push(`${name}: ${parts.join(', ')}`);
		}
		if (drift.length)
			lines.push(
				`Runner check: the plain SvelteKit apps (same code in both runs) moved by ${drift.join('; ')}. If that is large, the timing rows above are runner noise.`,
				''
			);
	}

	const noise = Object.entries(NOISE)
		.filter(([key]) => Object.values(prG).some((m) => Object.keys(m).some((k) => kindOf(k) === key)))
		.map(([key, { pct, abs }]) => {
			if (!pct && !abs) return `\`${key}\` any change`;
			const parts = [];
			if (pct) parts.push(`${pct}%`);
			parts.push(METRICS[key].fmt === kb ? `${abs} B` : METRICS[key].fmt(abs));
			return `\`${key}\` ${parts.join(' and ')}`;
		})
		.join(', ');
	lines.push(
		'<details><summary>How to read this</summary>',
		'',
		`Lighthouse (mobile, simulated throttling${passes ? `, median of ${passes} pass${passes === 1 ? '' : 'es'}` : ''}) on the blog's three posts and on one page per scenario; browser sessions in Chrome with 4× CPU throttling and a 40 ms / 10 Mbps network${scenarioPasses ? `, median of ${scenarioPasses} pass${scenarioPasses === 1 ? '' : 'es'}` : ''}; server apps loaded by 10 connections replaying one page view. All on a GitHub-hosted runner. Sizes and lines of code are exact; timings are not. The README defines every metric.`,
		'',
		`⚠️ marks a metric that got worse by more than its noise floor (both the percentage and the absolute amount): ${noise}.`,
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
		if (a === '--pr') args.pr = argv[++i];
		else if (a === '--base') args.base = argv[++i];
		else if (a === '--run-url') args.runUrl = argv[++i];
		else if (a === '--out') args.out = argv[++i];
	}
	if (!args.pr) throw new Error('usage: node compare.ts --pr pr.json [--base main.json]');
	return args;
}

const args = parseArgs(process.argv.slice(2));
const pr = readJson(args.pr);
if (!pr) throw new Error(`cannot read ${args.pr}`);
const { body, regressions } = compare(pr, readJson(args.base), args.runUrl);
if (args.out) writeFileSync(args.out, body);
else process.stdout.write(body);
console.error(
	regressions.length ? `regressions: ${regressions.join(', ')}` : 'no regressions beyond noise'
);
