import { context_path, package_label, unversioned_module } from '../identity.ts';
import { format_steps } from '../weight/rank.ts';
import type { Receipt, ReceiptCase } from './index.ts';

/*
 * The registry page: one static HTML file made from receipts (`heisenbench registry`), kept on
 * the results branch under `heisenbench/registry/`. It compares
 *
 *   - each package across its versions: every case's steps, the change from the version before,
 *     and its growth class; then, for the newest version, the functions the steps are in, matched
 *     across versions by place (a dependency's module without its version, a function's path
 *     without its shape hash), so a function keeps its row through an upgrade;
 *   - packages with each other: cases with the same name in receipts of different packages are
 *     one row (two markdown parsers each with a case `parse: a README` compare there);
 *   - the receipts themselves: tarball integrity, engine, Node, hash, and where the file is.
 *
 * Every number on it is a receipt's, and every receipt can be checked with `verify-receipt`.
 */

const TOP_FUNCTIONS = 6;

function esc(s: string): string {
	return s
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

/** Versions in release order: numeric parts compared as numbers, a prerelease before its release. */
export function compare_versions(a: string, b: string): number {
	const split = (v: string) => {
		const [main, pre] = v.split(/-(.*)/s, 2);
		return { main: main.split('.').map((x) => Number(x) || 0), pre: pre ?? null };
	};
	const x = split(a);
	const y = split(b);
	for (let i = 0; i < Math.max(x.main.length, y.main.length); i++) {
		const d = (x.main[i] ?? 0) - (y.main[i] ?? 0);
		if (d !== 0) return d;
	}
	if (x.pre === y.pre) return 0;
	if (x.pre === null) return 1;
	if (y.pre === null) return -1;
	return x.pre < y.pre ? -1 : 1;
}

/** Where a function is, the same across versions of its package. */
export function function_place(id: string): string {
	const at = id.indexOf(' > ');
	if (at === -1) return unversioned_module(id);
	return `${unversioned_module(id.slice(0, at))} > ${context_path(id.slice(at + 3))}`;
}

function pct(now: number, before: number): { text: string; kind: 'up' | 'down' | 'same' } {
	if (before === now) return { text: 'same', kind: 'same' };
	if (before === 0) return { text: 'new', kind: 'up' };
	const p = ((now - before) / before) * 100;
	const digits = Math.abs(p) < 0.1 ? 2 : 1;
	return {
		text: `${p > 0 ? '+' : '−'}${Math.abs(p).toFixed(digits)}%`,
		kind: p > 0 ? 'up' : 'down'
	};
}

function growth_of(r: Receipt, c: ReceiptCase): string | null {
	const g = r.growth.find((x) => x.name === c.name && x.file === c.file);
	return g ? (g.class ?? 'no class') : null;
}

const case_key = (c: { file: string; name: string }) => `${c.file}\0${c.name}`;

function package_section(name: string, versions: Receipt[]): string {
	const ids = new Map<string, { name: string; file: string }>();
	for (const r of versions) for (const c of r.cases) ids.set(case_key(c), c);
	const head = versions
		.map((r) => `<th scope="col" class="num">${esc(r.package.version)}</th>`)
		.join('');
	const rows = [...ids.values()]
		.map((c) => {
			let before: number | null = null;
			const cells = versions.map((r) => {
				const x = r.cases.find((y) => case_key(y) === case_key(c));
				if (!x) {
					before = null;
					return '<td class="num muted">—</td>';
				}
				const d = before === null ? null : pct(x.totals.steps, before);
				before = x.totals.steps;
				const g = growth_of(r, x);
				return `<td class="num"><span class="steps" title="${x.totals.steps} steps, ${x.totals.allocations} allocations, ${x.totals.calls} calls">${format_steps(x.totals.steps)}</span>${d ? ` <span class="delta ${d.kind}">${d.text}</span>` : ''}${g ? `<span class="class">${esc(g)}</span>` : ''}</td>`;
			});
			return `<tr><th scope="row"><span class="case">${esc(c.name)}</span><span class="file">${esc(c.file)}</span></th>${cells.join('')}</tr>`;
		})
		.join('\n');

	const newest = versions[versions.length - 1];
	const where = newest.cases
		.map((c) => {
			const top = [...c.functions]
				.sort((a, b) => b.self_steps - a.self_steps)
				.slice(0, TOP_FUNCTIONS);
			const lines = top.map((f) => {
				const place = function_place(f.id);
				const cells = versions.map((r) => {
					const rc = r.cases.find((y) => case_key(y) === case_key(c));
					const rf = rc?.functions.find((g) => function_place(g.id) === place);
					return rf
						? `<td class="num">${format_steps(rf.self_steps)}</td>`
						: '<td class="num muted">—</td>';
				});
				const pkg = package_label(f.id.split(' > ')[0]);
				const share = c.totals.steps > 0 ? Math.round((f.self_steps / c.totals.steps) * 100) : 0;
				return `<tr><th scope="row"><code>${esc(place)}</code>${pkg ? `<span class="file">${esc(pkg)}</span>` : ''}</th><td class="num">${share}%</td>${cells.join('')}</tr>`;
			});
			return `<details${newest.cases.length === 1 ? ' open' : ''}><summary>${esc(c.name)} <span class="muted">· top ${top.length} of ${c.functions.length} functions by self steps</span></summary><div class="scroll"><table><thead><tr><th scope="col">Function</th><th scope="col" class="num">Share at ${esc(newest.package.version)}</th>${head}</tr></thead><tbody>${lines.join('')}</tbody></table></div></details>`;
		})
		.join('\n');

	return `<section class="package" id="${esc(anchor(name))}">
<header class="package-head"><h2>${esc(name)}</h2><p class="muted">${versions.length} version${versions.length === 1 ? '' : 's'} with a receipt · newest ${esc(newest.package.version)}</p></header>
<div class="scroll"><table class="cases"><thead><tr><th scope="col">Case</th>${head}</tr></thead><tbody>
${rows}
</tbody></table></div>
<h3>Where the steps go</h3>
${where}
</section>`;
}

function anchor(name: string): string {
	return 'pkg-' + name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function across_section(newest: Receipt[]): string {
	const by = new Map<string, Array<{ r: Receipt; c: ReceiptCase }>>();
	for (const r of newest)
		for (const c of r.cases) {
			const list = by.get(c.name) ?? [];
			list.push({ r, c });
			by.set(c.name, list);
		}
	const shared = [...by].filter(([, xs]) => new Set(xs.map((x) => x.r.package.name)).size > 1);
	if (shared.length === 0)
		return `<p class="muted">No case name is in receipts of two packages yet. Give the same task the same case name in each package's bench files (<code>parse: a README</code>) and the packages line up here, newest versions side by side.</p>`;
	const rows = shared
		.map(([name, xs]) => {
			const least = Math.min(...xs.map((x) => x.c.totals.steps));
			const cells = xs
				.sort((a, b) => a.c.totals.steps - b.c.totals.steps)
				.map(
					(x) =>
						`<li><span class="who">${esc(x.r.package.name)}@${esc(x.r.package.version)}</span> <span class="num">${format_steps(x.c.totals.steps)}</span>${x.c.totals.steps === least ? ' <span class="delta down">least</span>' : ` <span class="delta up">${(x.c.totals.steps / least).toFixed(2)}×</span>`}${growth_of(x.r, x.c) ? ` <span class="class">${esc(growth_of(x.r, x.c)!)}</span>` : ''}</li>`
				)
				.join('');
			return `<tr><th scope="row">${esc(name)}</th><td><ul class="versus">${cells}</ul></td></tr>`;
		})
		.join('\n');
	return `<div class="scroll"><table><thead><tr><th scope="col">Case</th><th scope="col">Packages, fewest steps first</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function receipts_section(all: Receipt[], links: ReadonlyMap<Receipt, string>): string {
	const rows = all
		.map((r) => {
			const link = links.get(r);
			const name = `${esc(r.package.name)}@${esc(r.package.version)}`;
			return `<tr><th scope="row">${link ? `<a href="${esc(link)}">${name}</a>` : name}</th><td><code title="${esc(r.package.integrity)}">${esc(r.package.integrity.slice(0, 22))}…</code><span class="file">npm: ${esc(r.package.npm)}</span></td><td>${esc(r.engine.name)} ${esc(r.engine.version)}<span class="file">${esc(r.engine.source ?? '')}</span><span class="file"><code>${esc(r.engine.hash.slice(0, 12))}</code> · prices <code>${esc(r.engine.prices.hash.slice(0, 8))}</code></span></td><td>${esc(r.node.version)}<span class="file">${esc(r.node.platform)}-${esc(r.node.arch)}</span></td><td class="num">${r.cases.length}</td><td><code title="${esc(r.hash)}">${esc(r.hash.slice(0, 19))}…</code><span class="file">${esc(r.created.slice(0, 10))}</span></td></tr>`;
		})
		.join('\n');
	return `<div class="scroll"><table><thead><tr><th scope="col">Release</th><th scope="col">Tarball</th><th scope="col">Engine</th><th scope="col">Node</th><th scope="col" class="num">Cases</th><th scope="col">Receipt</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

const STYLE = `
:root {
	/* Layout: one reading column; wide tables scroll inside their own box. */
	--paper: #f6f7f4; --ink: #1d2320; --muted: #5d6862; --rule: #d5dad5; --panel: #ffffff;
	--accent: #1f6f5c; --up: #a1401f; --down: #23704a;
	--face: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
	--mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
	--paper: #141816; --ink: #e3e8e4; --muted: #98a39c; --rule: #2d3531; --panel: #1b201d;
	--accent: #6fc4ab; --up: #f0936f; --down: #7fd3a3; color-scheme: dark; } }
:root[data-theme="dark"] {
	--paper: #141816; --ink: #e3e8e4; --muted: #98a39c; --rule: #2d3531; --panel: #1b201d;
	--accent: #6fc4ab; --up: #f0936f; --down: #7fd3a3; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.5 var(--face);
	padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 32px 64px; }
main { max-width: 72rem; margin: 0 auto; display: grid; gap: 40px; }
h1 { font-size: 1.9rem; margin: 0; letter-spacing: -0.01em; text-wrap: balance; }
h2 { font-size: 1.35rem; margin: 0; font-family: var(--mono); font-weight: 600; }
h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 24px 0 8px; }
p { margin: 0; max-width: 65ch; }
.lede { display: grid; gap: 8px; }
.muted { color: var(--muted); }
code { font-family: var(--mono); font-size: 0.85em; }
a { color: var(--accent); }
a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
nav ul { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 8px 16px; }
.package { display: grid; gap: 12px; }
.package-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; border-bottom: 2px solid var(--ink); padding-bottom: 6px; }
.scroll { overflow-x: auto; min-width: 0; }
table { border-collapse: collapse; width: 100%; background: var(--panel); font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--rule); vertical-align: top; }
thead th { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; white-space: nowrap; }
tbody th { font-weight: 500; }
.num { text-align: right; white-space: nowrap; font-family: var(--mono); font-size: 0.9em; }
.case, .who { display: block; }
.file { display: block; color: var(--muted); font-size: 0.8rem; font-family: var(--mono); }
.steps { font-weight: 600; }
.delta { font-size: 0.8em; }
.delta.up { color: var(--up); }
.delta.down { color: var(--down); }
.delta.same { color: var(--muted); }
.class { display: block; font-family: var(--face); font-size: 0.75rem; color: var(--accent); }
details { background: var(--panel); border: 1px solid var(--rule); border-radius: 4px; }
details + details { margin-top: 8px; }
summary { cursor: pointer; padding: 10px 12px; }
details table { background: transparent; }
ul.versus { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
ul.versus li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
ul.versus .class { display: inline; }
footer { color: var(--muted); font-size: 0.85rem; }
`;

/** The registry page from receipts; `links`: where each receipt's file is, relative to the page. */
export function render_registry(
	receipts: readonly Receipt[],
	links: ReadonlyMap<Receipt, string> = new Map()
): string {
	const by = new Map<string, Receipt[]>();
	for (const r of receipts) {
		const list = by.get(r.package.name) ?? [];
		list.push(r);
		by.set(r.package.name, list);
	}
	const names = [...by.keys()].sort();
	for (const n of names)
		by.get(n)!.sort((a, b) => compare_versions(a.package.version, b.package.version));
	const newest = names.map((n) => by.get(n)!.at(-1)!);
	const all = names.flatMap((n) => by.get(n)!);
	const nav = names
		.map(
			(n) =>
				`<li><a href="#${esc(anchor(n))}">${esc(n)}</a> <span class="muted">${by.get(n)!.length}</span></li>`
		)
		.join('');
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Heisenbench Registry</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header class="lede">
<h1>Heisenbench registry</h1>
<p>What each released version's code costs, counted in steps: the same number on every machine. ${all.length} receipt${all.length === 1 ? '' : 's'} for ${names.length} package${names.length === 1 ? '' : 's'}. Check any of them by counting again: <code>heisenbench verify-receipt &lt;receipt&gt; &lt;tarball&gt;</code>.</p>
<nav aria-label="Packages"><ul>${nav}</ul></nav>
</header>
${names.map((n) => package_section(n, by.get(n)!)).join('\n')}
<section class="package"><header class="package-head"><h2>Across packages</h2><p class="muted">the same case name, newest version of each</p></header>
${across_section(newest)}
</section>
<section class="package"><header class="package-head"><h2>Receipts</h2></header>
${receipts_section(all, links)}
</section>
<footer><p>Steps are counted work (calls, property reads, comparisons, allocations, built-ins priced by input size), not time. Growth is the class of steps over inputs 1×, 10× and 100× as large.</p></footer>
</main>
</body>
</html>
`;
}
