// Docs: a 300-page documentation site with a full sidebar, search, code tabs and a table of
// contents. Measures load, client navigation over a reading session, and the search INP.
import { readFileSync } from 'node:fs';

const data = (file) => JSON.parse(readFileSync(new URL(`./shared/data/${file}`, import.meta.url), 'utf8'));
const nav = data('nav.json');
const search = data('public/search.json');
const flat = nav.flatMap((s) => s.pages);
const at = (slug) => flat.findIndex((p) => p.slug === slug);

const START = nav[5].pages[12];
const QUERY = 'prefetching';
const FIRST_HIT = search.find((e) => e.title.toLowerCase().includes(QUERY) || e.text.includes(QUERY));

const h1Is = (title) => `document.querySelector('main.article h1')?.textContent?.trim() === ${JSON.stringify(title)}`;

export default {
	title: 'Docs: 300 generated pages with sidebar, search, code tabs and a table of contents',
	routes: { first: `/docs/${flat[0].slug}`, mid: `/docs/${START.slug}` },
	ready: `/docs/${flat[0].slug}`,
	lighthouse: ['mid'],
	stepNames: ['tabs', 'search'],
	composition: 'components/DocPage.svelte',
	fidelity: {
		paths: [`/docs/${START.slug}`],
		print: () => {
			// Visible text only: islands frameworks put their props and loader scripts in the page.
			const main = document.querySelector('main.article')?.cloneNode(true);
			main?.querySelectorAll('script, style, template').forEach((el) => el.remove());
			return [
				main?.querySelector('h1')?.textContent?.trim(),
				document.querySelectorAll('.sidebar a').length,
				document.querySelectorAll('.toc a').length,
				document.querySelectorAll('.code-tabs [role=tab]').length,
				[...document.querySelectorAll('.pager a')].map((a) => a.getAttribute('href')).join(','),
				main?.textContent?.replace(/\s+/g, '').length
			].join('|');
		}
	},
	async session(s) {
		await s.goto(`/docs/${START.slug}`);

		// Code tabs: bring them into view (where a lazy island would wake), then switch tab.
		await s.page.locator('.code-tabs').first().scrollIntoViewIfNeeded();
		await s.ready();
		await s.interact(
			'tabs',
			(p) => p.locator('.code-tabs [role=tab]').nth(1).click(),
			() => document.querySelectorAll('.code-tabs .tab-panel')[1]?.hidden === false
		);

		// Search: click the box and type; done when results are listed (the index loads on first use).
		await s.page.evaluate(() => window.scrollTo(0, 0));
		await s.interact(
			'search',
			async (p) => {
				await p.click('.search input');
				await p.keyboard.type(QUERY, { delay: 60 });
			},
			() => document.querySelectorAll('.search-results a').length > 0
		);

		// Reading: four times "Next", one sidebar link, one search result.
		let i = at(START.slug);
		for (let k = 0; k < 4; k++) {
			const to = flat[++i];
			await s.nav('next', (p) => p.click('.pager a.next'), h1Is(to.title));
		}
		const side = flat[i + 3];
		await s.nav('sidebar', (p) => p.click(`.sidebar a[href="/docs/${side.slug}"]`), h1Is(side.title));
		// A router that keeps the header mounted keeps the earlier query in the box: clear it first.
		await s.page.fill('.search input', '');
		await s.page.click('.search input');
		await s.page.keyboard.type(QUERY, { delay: 30 });
		await s.until(() => document.querySelectorAll('.search-results a').length > 0);
		await s.nav('search-result', (p) => p.click('.search-results a >> nth=0'), h1Is(FIRST_HIT.title));
	},
	// A long reading session: 25 more pages through "Next", then the heap.
	async long(s) {
		let i = at(FIRST_HIT.slug);
		for (let k = 0; k < 25 && flat[i + 1]; k++) {
			const to = flat[++i];
			await s.page.click('.pager a.next');
			await s.until(h1Is(to.title));
		}
		await s.ready();
	}
};
