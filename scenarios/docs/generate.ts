// Generate the docs scenario's content: 12 sections × 25 pages, each with headings, prose, an
// admonition, links to other pages and one code-tabs block. Deterministic (seeded), written as
// data the apps render, like a headless CMS would hand it over: HTML bodies plus structure. The
// markdown pipeline is not what this scenario measures, so every app gets the same HTML.
//
//   node scenarios/docs/generate.ts   → scenarios/docs/shared/data/
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('./shared/data/', import.meta.url));
const SECTIONS = [
	'Getting started',
	'Concepts',
	'Routing',
	'Data loading',
	'Forms',
	'Styling',
	'Testing',
	'Deployment',
	'Performance',
	'Security',
	'Integrations',
	'Reference'
];
const PAGES_PER_SECTION = 25;
const VERBS = ['Configure', 'Understand', 'Debug', 'Extend', 'Migrate', 'Optimize', 'Test', 'Secure', 'Deploy', 'Compose'];
const NOUNS = ['routing', 'caching', 'layouts', 'streaming', 'islands', 'hydration', 'forms', 'sessions', 'assets', 'adapters', 'headers', 'errors', 'prefetching'];
const WORDS =
	'the router renders each page on the server and the browser receives plain html so the first paint is fast while small components wake when the reader needs them and data loads close to where it is used with caching that keeps repeated visits cheap'.split(
		' '
	);

let seed = 20261103;
const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
const pick = (xs) => xs[next() % xs.length];
const slugify = (s) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function sentence(n) {
	const w = [];
	for (let i = 0; i < n; i++) w.push(pick(WORDS));
	const s = w.join(' ');
	return s[0].toUpperCase() + s.slice(1) + '.';
}

function paragraph(links) {
	const parts = [];
	const count = 3 + (next() % 3);
	for (let i = 0; i < count; i++) parts.push(sentence(10 + (next() % 12)));
	if (next() % 3 === 0) parts.splice(1, 0, `Set <code>${pick(NOUNS)}.${pick(['enabled', 'mode', 'timeout', 'strategy'])}</code> to change it.`);
	if (links.length && next() % 2 === 0) {
		const l = pick(links);
		parts.push(`See <a href="/docs/${l.slug}">${esc(l.title)}</a> for more.`);
	}
	return `<p>${parts.join(' ')}</p>`;
}

function tabs(title) {
	const name = slugify(title).slice(0, 24);
	return [
		{ label: 'pnpm', code: `pnpm add bench-${name}\npnpm bench ${name} --watch` },
		{ label: 'npm', code: `npm install bench-${name}\nnpx bench ${name} --watch` },
		{ label: 'bun', code: `bun add bench-${name}\nbunx bench ${name} --watch` }
	];
}

// The catalog first, so pages can link to each other.
const nav = SECTIONS.map((title) => {
	const sslug = slugify(title);
	const used = new Set();
	const pages = [];
	for (let i = 0; i < PAGES_PER_SECTION; i++) {
		let t = `${pick(VERBS)} ${pick(NOUNS)}`;
		if (i === 0) t = `${title} overview`;
		let slug = slugify(t);
		for (let k = 2; used.has(slug); k++) slug = `${slugify(t)}-${k}`;
		used.add(slug);
		if (slug !== slugify(t)) t = `${t} (${slug.split('-').at(-1)})`;
		pages.push({ slug: `${sslug}/${slug}`, title: t });
	}
	return { slug: sslug, title, pages };
});
const flat = nav.flatMap((s) => s.pages.map((p) => ({ ...p, section: s.title })));

const pages = {};
const search = [];
flat.forEach((entry, i) => {
	const headings = [];
	const ids = new Set();
	const heading = (text, depth) => {
		let id = slugify(text);
		for (let k = 2; ids.has(id); k++) id = `${slugify(text)}-${k}`;
		ids.add(id);
		headings.push({ id, text, depth });
		return `<h${depth} id="${id}">${esc(text)}</h${depth}>`;
	};
	const links = Array.from({ length: 4 }, () => flat[next() % flat.length]);
	const intro = [paragraph(links), paragraph(links)].join('\n');
	const blocks = [{ type: 'html', html: intro }];
	const sections = ['Overview', `How ${entry.title.toLowerCase()} works`, 'Options', 'Common problems'];
	sections.forEach((h, si) => {
		let html = heading(h, 2) + '\n' + paragraph(links) + '\n' + paragraph(links);
		if (si === 1) html += '\n' + heading('Step by step', 3) + '\n' + paragraph(links);
		if (si === 2)
			html += `\n<div class="callout"><strong>Note</strong> ${sentence(16)}</div>\n` + paragraph(links);
		blocks.push({ type: 'html', html });
		if (si === 0) blocks.push({ type: 'tabs', tabs: tabs(entry.title) });
	});
	const prev = flat[i - 1];
	const nxt = flat[i + 1];
	pages[entry.slug] = {
		slug: entry.slug,
		title: entry.title,
		section: entry.section,
		headings,
		blocks,
		prev: prev ? { slug: prev.slug, title: prev.title } : null,
		next: nxt ? { slug: nxt.slug, title: nxt.title } : null
	};
	const text = blocks
		.filter((b) => b.type === 'html')
		.map((b) => b.html.replace(/<[^>]+>/g, ' '))
		.join(' ')
		.replace(/\s+/g, ' ')
		.slice(0, 160);
	search.push({ slug: entry.slug, title: entry.title, section: entry.section, text });
});

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'public', 'data', 'pages'), { recursive: true });
writeFileSync(join(OUT, 'nav.json'), JSON.stringify(nav));
writeFileSync(join(OUT, 'pages.json'), JSON.stringify(pages));
// Static files every app serves: the search index (fetched by the search box on first use) and
// one JSON per page (what the client-rendered SPA fetches on navigation).
writeFileSync(join(OUT, 'public', 'search.json'), JSON.stringify(search));
for (const [slug, page] of Object.entries(pages))
	writeFileSync(join(OUT, 'public', 'data', 'pages', `${slug.replace('/', '--')}.json`), JSON.stringify(page));
const bytes = JSON.stringify(pages).length;
console.log(`  docs: ${flat.length} pages, ${(bytes / 1024).toFixed(0)} KB of page data`);
