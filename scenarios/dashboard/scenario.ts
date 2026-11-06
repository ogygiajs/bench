// Dashboard: live KPI cards and a live line chart, a static bar chart, and a 1,000-row orders
// table you can sort and filter. Measures INP for sort and filter, the cost of one live update,
// JS weight, and (for server apps) the cost of rendering the page per request.
import { readFileSync } from 'node:fs';
import { filterOrders } from './shared/format.ts';

const data = JSON.parse(readFileSync(new URL('./shared/data/dashboard.json', import.meta.url), 'utf8'));
const QUERY = 'north';
const FILTERED = filterOrders(data.orders, QUERY, 'all').length;
const REFUNDED = filterOrders(data.orders, QUERY, 'refunded').length;

const sortIs = (v) => `document.querySelector('.orders')?.dataset.sort === ${JSON.stringify(v)}`;
const countIs = (n) => `document.querySelector('.orders')?.dataset.count === '${n}'`;
const header = (label) => `.orders th button:text-matches("^${label}")`;

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[s.length >> 1] : null;
};

export default {
	title: 'Dashboard: live cards and chart, a static chart, a sortable and filterable 1,000-row table',
	routes: { home: '/' },
	ready: '/',
	lighthouse: ['home'],
	stepNames: ['sort', 'sort-toggle', 'filter', 'status'],
	composition: 'components/Dashboard.svelte',
	server: { route: 'home' },
	fidelity: {
		paths: ['/'],
		print: () =>
			[
				document.querySelector('h1')?.textContent?.trim(),
				[...document.querySelectorAll('.kpi h2')].map((e) => e.textContent.trim()).join(','),
				document.querySelectorAll('.bars rect').length,
				[...document.querySelectorAll('.orders th')].map((e) => e.textContent.trim()).join(','),
				document.querySelectorAll('.orders tbody tr').length,
				document.querySelector('.orders tbody tr')?.textContent?.replace(/\s+/g, '')
			].join('|')
	},
	async session(s) {
		await s.goto('/');
		await s.page.locator('.orders').scrollIntoViewIfNeeded();
		await s.ready();
		await s.interact('sort', (p) => p.click(header('Amount')), sortIs('amount:desc'));
		await s.interact('sort-toggle', (p) => p.click(header('Amount')), sortIs('amount:asc'));
		await s.interact(
			'filter',
			async (p) => {
				await p.click('.orders input');
				await p.keyboard.type(QUERY, { delay: 80 });
			},
			`document.querySelector('.orders input')?.value === '${QUERY}' && ${countIs(FILTERED)}`
		);
		await s.interact('status', (p) => p.selectOption('.orders select', 'refunded'), countIs(REFUNDED));

		// Live updates: let six ticks land, then take the median DOM-update time of the last five.
		await s.until(() => Number(document.querySelector('.live')?.dataset.ticks) >= 6, 20000);
		const updates = await s.page.evaluate(() => window.__bench_updates ?? []);
		s.mark('updateMs', median(updates.slice(-5)));
	},
	// A long session: twenty more sorts over different columns while the panel keeps ticking.
	async long(s) {
		const cols = ['Customer', 'Region', 'Product', 'Status', 'Date'];
		for (let i = 0; i < 20; i++) await s.page.click(header(cols[i % cols.length]));
		await s.ready();
	}
};
