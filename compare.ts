#!/usr/bin/env node
// Turn one PR run and the `main` baseline into the body of the benchmark comment on the ogygia PR.
//
//   node compare.ts --pr pr.json [--base main.json] [--run-url <url>] [--out comment.md]
//
// Both files are benchmark.ts JSON. A missing or unreadable --base is not an error: the comment
// then says there is no baseline yet and shows the PR's numbers alone. The verdict lives in the
// text, so the exit code is 0 either way; CI never fails on a slower run.
import { readFileSync, writeFileSync } from 'node:fs';

// The workflow finds the existing comment by this line and edits it in place.
const MARKER = '<!-- ogygia-benchmarks -->';
const OGYGIA_REPO = 'ogygiajs/ogygia';

// Noise, defined in this one place. A change counts as a regression only when it is worse than
// the baseline by more than BOTH `pct` percent of the baseline AND `abs` (in the metric's own
// unit). Lighthouse timings on a shared runner wobble by a few percent even with medians, so they
// get wide floors; sizes come out the same on every run, so their floors only skip rounding-level
// changes.
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
	cacheable: { pct: 0, abs: 0 },
	buildMs: { pct: 25, abs: 3000 },
	outBytes: { pct: 1, abs: 1024 },
	// Lines of code only change when an app's source does; any change is shown, none is noise.
	loc: { pct: 0, abs: 0 },
	locCode: { pct: 0, abs: 0 },
	locConfig: { pct: 0, abs: 0 }
};

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const ms = (n) => `${Math.round(n).toLocaleString('en-US')} ms`;
const UNITS = {
	score: { fmt: (n) => String(Math.round(n)), better: 'higher' },
	lcp: { fmt: ms, better: 'lower' },
	tbt: { fmt: ms, better: 'lower' },
	cls: { fmt: (n) => n.toFixed(3), better: 'lower' },
	evalMs: { fmt: ms, better: 'lower' },
	dom: { fmt: (n) => String(Math.round(n)), better: 'lower' },
	jsBr: { fmt: kb, better: 'lower' },
	jsRaw: { fmt: kb, better: 'lower' },
	htmlBr: { fmt: kb, better: 'lower' }
};

/** The rows of the comment's table: a label, the metric's key, and how to read it from a framework. */
function metrics(posts) {
	const avg = (key) => (fw) => fw?.avg?.[key];
	const row = (post, key) => (fw) => fw?.rows?.find((r) => r.post === post)?.[key];
	return [
		{ label: 'Lighthouse score (avg)', key: 'score', get: avg('score') },
		{ label: 'LCP (avg)', key: 'lcp', get: avg('lcp') },
		{ label: 'TBT (avg)', key: 'tbt', get: avg('tbt') },
		{ label: 'CLS (avg)', key: 'cls', get: avg('cls') },
		{ label: 'JS eval (avg)', key: 'evalMs', get: avg('evalMs') },
		{ label: 'DOM elements (avg)', key: 'dom', get: avg('dom') },
		...posts.map((p) => ({ label: `JS brotli (${p})`, key: 'jsBr', get: row(p, 'jsBr') })),
		...posts.map((p) => ({ label: `JS raw (${p})`, key: 'jsRaw', get: row(p, 'jsRaw') })),
		...posts.map((p) => ({ label: `HTML brotli (${p})`, key: 'htmlBr', get: row(p, 'htmlBr') }))
	];
}

/** How a PR value sits against the baseline: the change, and whether it is a regression. */
function judge(key, pr, base) {
	const diff = pr - base;
	const worse = UNITS[key].better === 'lower' ? diff : -diff;
	const { pct, abs } = NOISE[key];
	const floor = Math.max(abs, (Math.abs(base) * pct) / 100);
	return { diff, regressed: worse > floor };
}

function signed(key, diff, base) {
	const sign = diff > 0 ? '+' : diff < 0 ? '−' : '±';
	// Byte changes under a kilobyte read better in bytes than as "+0.0 KB".
	const small = UNITS[key].fmt === kb && Math.abs(diff) < 1024;
	const mag = small ? `${Math.abs(diff)} B` : UNITS[key].fmt(Math.abs(diff));
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

function compare(pr, base, runUrl) {
	const prOgygia = pr.frameworks.find((f) => f.id === 'ogygia');
	if (!prOgygia) throw new Error('the PR result has no ogygia row');
	const baseOgygia = base?.frameworks?.find((f) => f.id === 'ogygia') ?? null;
	const posts = pr.posts.map((p) => p.id);
	const rows = metrics(posts);
	const passes = pr.meta?.passes;

	const lines = [MARKER, '### ogygia benchmarks', ''];
	const tableRows = [];
	const regressions = [];

	if (baseOgygia) {
		tableRows.push('| Metric | This PR | main | Change | |', '|---|---:|---:|---:|:-:|');
		for (const m of rows) {
			const p = m.get(prOgygia);
			const b = m.get(baseOgygia);
			if (p == null) continue;
			if (b == null) {
				tableRows.push(`| ${m.label} | ${UNITS[m.key].fmt(p)} | n/a | | |`);
				continue;
			}
			const { diff, regressed } = judge(m.key, p, b);
			if (regressed) regressions.push(m.label);
			tableRows.push(
				`| ${m.label} | ${UNITS[m.key].fmt(p)} | ${UNITS[m.key].fmt(b)} | ${signed(m.key, diff, b)} | ${regressed ? '⚠️' : '✅'} |`
			);
		}
		lines.push(
			regressions.length
				? `⚠️ **${regressions.length} metric${regressions.length === 1 ? '' : 's'} got worse beyond noise:** ${regressions.join(', ')}.`
				: '✅ **No regressions beyond noise.**',
			'',
			`This PR: ogygia ${describe(pr)}. Baseline: \`main\`, ogygia ${describe(base)}.`
		);
	} else {
		tableRows.push('| Metric | This PR |', '|---|---:|');
		for (const m of rows) {
			const p = m.get(prOgygia);
			if (p != null) tableRows.push(`| ${m.label} | ${UNITS[m.key].fmt(p)} |`);
		}
		lines.push(
			'No `main` baseline yet, so there is nothing to compare against. These are the absolute numbers.',
			'',
			`This PR: ogygia ${describe(pr)}.`
		);
	}
	lines.push('', ...tableRows, '');

	// The plain-SvelteKit app never changes between the two runs, so a big move there means the
	// runner itself was faster or slower, and the ogygia timings above moved with it.
	const prKit = pr.frameworks.find((f) => f.id === 'sveltekit');
	const baseKit = base?.frameworks?.find((f) => f.id === 'sveltekit');
	if (prKit && baseKit) {
		const drift = ['score', 'lcp', 'evalMs']
			.map((key) => {
				const { diff } = judge(key, prKit.avg[key], baseKit.avg[key]);
				return `${key === 'evalMs' ? 'JS eval' : key === 'lcp' ? 'LCP' : 'score'} ${signed(key, diff, baseKit.avg[key])}`;
			})
			.join(', ');
		lines.push(
			`Runner check: the plain SvelteKit app (same code in both runs) moved by ${drift}. If that is large, the timing rows above are runner noise.`,
			''
		);
	}

	const noise = Object.entries(NOISE)
		.map(([key, { pct, abs }]) => {
			const parts = [];
			if (pct) parts.push(`${pct}%`);
			parts.push(UNITS[key].fmt === kb ? `${abs} B` : UNITS[key].fmt(abs));
			return `\`${key}\` ${parts.join(' and ')}`;
		})
		.join(', ');
	lines.push(
		'<details><summary>How to read this</summary>',
		'',
		`Lighthouse mobile with simulated throttling on a GitHub-hosted runner${passes ? `, median of ${passes} pass${passes === 1 ? '' : 'es'}` : ''}, over three synthetic blog posts (small, medium, large) with five interactive counters each. Sizes are exact and the same on every run; timings are not.`,
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
