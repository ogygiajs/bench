// The app scenarios as Heisenbench counts them (spec 8): which server routes each ogygia app answers,
// and a browser session made of steps that run the same in every run (virtual time, events
// dispatched in the page). The sessions follow the scenarios' own sessions (scenarios/*/scenario.ts)
// as closely as a fixed script can: same pages, same clicks, same typing.
import { readFileSync } from 'node:fs';
import type { CountedScenario } from '@bench/heisenbench/app';
import { APP_ENV } from '../harness/serve.ts';
import { productPage } from '../scenarios/shop/shared/catalog.ts';

const data = (scenario: string, file: string): unknown =>
	JSON.parse(
		readFileSync(new URL(`../scenarios/${scenario}/shared/data/${file}`, import.meta.url), 'utf8')
	);

const h1_is = (selector: string, text: string): string =>
	`document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() === ${JSON.stringify(text)}`;

interface Product {
	id: string;
	name: string;
}
interface NavSection {
	pages: Array<{ slug: string; title: string }>;
}
interface SearchEntry {
	title: string;
	text: string;
}

/** Where each scenario's ogygia app lives (relative to suites/apps). */
export const APP_DIRS: Record<string, string> = {
	blog: 'frameworks/ogygia',
	docs: 'scenarios/docs/apps/ogygia',
	dashboard: 'scenarios/dashboard/apps/ogygia',
	'ai-chat': 'scenarios/ai-chat/apps/ogygia',
	shop: 'scenarios/shop/apps/ogygia'
};

/** The base twin's directory of an app (build-all.ts --base-spec, harness/ab.ts). */
export const base_dir = (dir: string): string =>
	dir.replace(/(^|\/)ogygia(\/|$)/, '$1ogygia-base$2');

function blog(): CountedScenario {
	const posts = ['small', 'medium', 'large'];
	return {
		name: 'blog',
		env: APP_ENV,
		server: posts.map((p) => ({
			label: `GET /posts/${p}`,
			unit: 'prerender',
			requests: [{ path: `/posts/${p}` }]
		})),
		repeat: 2,
		browser: {
			path: '/posts/large',
			steps: [0, 1, 2, 3, 4].map((i) => ({
				name: `counter ${i + 1}`,
				actions: [
					{ scroll: '.bench-counter', nth: i },
					{ wait_ms: 160 },
					{ click: '.bench-counter', nth: i },
					{
						until: `document.querySelectorAll('.bench-counter')[${i}]?.textContent?.trim() === 'count: ${i * 3 + 1}'`
					}
				]
			}))
		}
	};
}

function docs(): CountedScenario {
	const nav = data('docs', 'nav.json') as NavSection[];
	const search = data('docs', 'public/search.json') as SearchEntry[];
	const flat = nav.flatMap((s) => s.pages);
	const start = nav[5].pages[12];
	const query = 'prefetching';
	const at = flat.findIndex((p) => p.slug === start.slug);
	const hit = search.find((e) => e.title.toLowerCase().includes(query) || e.text.includes(query))!;
	const next = [1, 2, 3, 4].map((k) => flat[at + k]);
	const side = flat[at + 7];
	const h1 = (title: string) => h1_is('main.article h1', title);
	return {
		name: 'docs',
		env: APP_ENV,
		server: [
			{
				label: `GET /docs/${flat[0].slug}`,
				unit: 'prerender',
				requests: [{ path: `/docs/${flat[0].slug}` }]
			},
			{
				label: `GET /docs/${start.slug}`,
				unit: 'prerender',
				requests: [{ path: `/docs/${start.slug}` }]
			}
		],
		repeat: 2,
		browser: {
			path: `/docs/${start.slug}`,
			steps: [
				{
					name: 'tabs',
					actions: [
						{ scroll: '.code-tabs' },
						{ wait_ms: 160 },
						{ click: '.code-tabs [role=tab]', nth: 1 },
						{ until: `document.querySelectorAll('.code-tabs .tab-panel')[1]?.hidden === false` }
					]
				},
				{
					name: 'search',
					actions: [
						{ script: 'window.scrollTo(0, 0)' },
						{ type: '.search input', value: query, char_ms: 60 },
						{ until: `document.querySelectorAll('.search-results a').length > 0` }
					]
				},
				...next.map((p) => ({
					name: 'next',
					actions: [{ click: '.pager a.next' }, { until: h1(p.title) }]
				})),
				{
					name: 'sidebar',
					actions: [{ click: `.sidebar a[href="/docs/${side.slug}"]` }, { until: h1(side.title) }]
				},
				{
					name: 'search-result',
					actions: [
						{
							script:
								"(() => { const i = document.querySelector('.search input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()"
						},
						{ type: '.search input', value: query, char_ms: 30 },
						{ until: `document.querySelectorAll('.search-results a').length > 0` },
						{ click: '.search-results a' },
						{ until: h1(hit.title) }
					]
				}
			]
		}
	};
}

function dashboard(): CountedScenario {
	const sort_is = (v: string) => `document.querySelector('.orders')?.dataset.sort === '${v}'`;
	return {
		name: 'dashboard',
		env: APP_ENV,
		server: [{ label: 'GET /', unit: 'request', requests: [{ path: '/' }] }],
		browser: {
			path: '/',
			steps: [
				{ name: 'scroll', actions: [{ scroll: '.orders' }] },
				{
					name: 'sort',
					actions: [
						{ click: '.orders th button', text: 'Amount' },
						{ until: sort_is('amount:desc') }
					]
				},
				{
					name: 'sort-toggle',
					actions: [
						{ click: '.orders th button', text: 'Amount' },
						{ until: sort_is('amount:asc') }
					]
				},
				{ name: 'filter', actions: [{ type: '.orders input', value: 'north' }] },
				{ name: 'status', actions: [{ select: '.orders select', value: 'refunded' }] },
				{
					name: 'live ticks',
					actions: [
						{ until: `Number(document.querySelector('.live')?.dataset.ticks) >= 6`, max_ms: 20000 }
					]
				}
			]
		}
	};
}

function ai_chat(): CountedScenario {
	const history = data('ai-chat', 'history.json') as unknown[];
	const start = history.length / 2;
	const done = (turn: number) => `!!document.querySelector('.msg[data-turn="${turn}"][data-done]')`;
	return {
		name: 'ai-chat',
		env: APP_ENV,
		server: [
			{ label: 'GET /chat', unit: 'request', requests: [{ path: '/chat' }] },
			{
				label: 'POST /api/chat (stream)',
				unit: 'request',
				requests: [
					{
						method: 'POST',
						path: '/api/chat',
						body: JSON.stringify({ turn: 0, prompt: 'hello' }),
						headers: { 'content-type': 'application/json' }
					}
				]
			}
		],
		repeat: 3,
		// The stream is counted above; the session's own POSTs are the same work.
		server_follow: false,
		browser: {
			path: '/chat',
			steps: [
				{
					name: 'send',
					actions: [
						{ type: '.composer textarea', value: 'How do I cache a page?', char_ms: 30 },
						{ click: '.composer button' },
						{ until: done(start), max_ms: 30000 }
					]
				},
				{
					name: 'toggle-tool',
					actions: [
						{ click: '.history .tool summary' },
						{ until: `document.querySelector('.history .tool')?.open === true` }
					]
				}
			]
		}
	};
}

function shop(): CountedScenario {
	const products = data('shop', 'products.json') as Product[];
	const first = products[4];
	const second = (productPage(products, first.id) as { related: Product[] }).related[0];
	const h1 = (t: string) => h1_is('main h1', t);
	const greeting = `document.querySelector('.greeting')?.textContent?.trim() === 'Hello, Ada'`;
	return {
		name: 'shop',
		env: APP_ENV,
		headers: { cookie: 'bench_user=ada; bench_cart=3' },
		server: [
			{ label: 'GET /', unit: 'prerender', requests: [{ path: '/' }] },
			{
				label: `GET /product/${first.id}`,
				unit: 'prerender',
				requests: [{ path: `/product/${first.id}` }]
			}
		],
		browser: {
			path: '/',
			cookies: [
				{ name: 'bench_user', value: 'ada' },
				{ name: 'bench_cart', value: '3' }
			],
			steps: [
				{ name: 'personal', actions: [{ until: greeting }] },
				{
					name: 'product',
					actions: [
						{ click: `.card[href="/product/${first.id}"]` },
						{ until: h1(first.name) },
						{ until: greeting }
					]
				},
				{
					name: 'add',
					actions: [
						{ click: '.add-to-cart' },
						{ until: `document.querySelector('.buy-status')?.textContent?.includes('4 in cart')` }
					]
				},
				{
					name: 'related',
					actions: [
						{ click: `.related .card[href="/product/${second.id}"]` },
						{ until: h1(second.name) },
						{ until: greeting }
					]
				},
				{ name: 'home', actions: [{ click: '.brand' }, { until: h1('All products') }] }
			]
		}
	};
}

export const SCENARIOS: Record<string, () => CountedScenario> = {
	blog,
	docs,
	dashboard,
	'ai-chat': ai_chat,
	shop
};
