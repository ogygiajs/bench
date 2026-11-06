// Shop: a product grid and 48 product pages whose HTML is the same for everyone except two
// personal bits in the header (greeting, cart count) and an Add to cart button. Measures load,
// navigation, the time until the personal bits show, server cost per page view, and whether one
// copy of the page could be cached for everyone.
import { readFileSync } from 'node:fs';
import { productPage } from './shared/catalog.ts';

const products = JSON.parse(readFileSync(new URL('./shared/data/products.json', import.meta.url), 'utf8'));
const FIRST = products[4];
const SECOND = productPage(products, FIRST.id).related[0];
const THIRD = products[20];

const h1Is = (t) => `document.querySelector('main h1')?.textContent?.trim() === ${JSON.stringify(t)}`;
// After Add to cart only the greeting is checked: a client router that keeps the layout (Kit's,
// Vike's) shows the count it rendered until something invalidates it.
const personal = (name, cart = null) =>
	`document.querySelector('.greeting')?.textContent?.trim() === 'Hello, ${name}'` +
	(cart == null ? '' : ` && document.querySelector('.cart')?.textContent?.trim() === 'Cart (${cart})'`);

export default {
	title: 'Shop: product grid and pages, cacheable HTML with a personal greeting and cart count',
	routes: { home: '/', product: `/product/${FIRST.id}` },
	ready: '/',
	lighthouse: ['product'],
	stepNames: ['add'],
	composition: ['components/ShopHeader.svelte', 'components/ProductPage.svelte'],
	cookies: [
		{ name: 'bench_user', value: 'ada' },
		{ name: 'bench_cart', value: '3' }
	],
	server: { route: 'product' },
	cacheability: {
		route: 'product',
		visitors: [
			{ cookies: [{ name: 'bench_user', value: 'ada' }, { name: 'bench_cart', value: '3' }], markers: ['Hello, Ada'] },
			{ cookies: [{ name: 'bench_user', value: 'linus' }, { name: 'bench_cart', value: '7' }], markers: ['Hello, Linus'] }
		]
	},
	fidelity: {
		paths: ['/', `/product/${FIRST.id}`],
		print: () =>
			[
				document.querySelector('main h1')?.textContent?.trim(),
				document.querySelectorAll('.card').length,
				document.querySelector('.greeting')?.textContent?.trim(),
				document.querySelector('.cart')?.textContent?.trim(),
				document.querySelectorAll('.add-to-cart').length,
				document.querySelectorAll('.specs tr').length
			].join('|')
	},
	async session(s) {
		await s.goto('/');
		// From navigation start to the greeting and cart count on screen.
		const at = await s.until(personal('Ada', 3));
		s.mark('personalMs', at - (await s.page.evaluate(() => performance.timeOrigin)));

		await s.nav('product', (p) => p.click(`.card[href="/product/${FIRST.id}"]`), h1Is(FIRST.name));
		await s.until(personal('Ada', 3));
		await s.interact(
			'add',
			(p) => p.click('.add-to-cart'),
			() => document.querySelector('.buy-status')?.textContent?.includes('4 in cart')
		);
		await s.nav('related', (p) => p.click(`.related .card[href="/product/${SECOND.id}"]`), h1Is(SECOND.name));
		await s.until(personal('Ada'));
		await s.nav('home', (p) => p.click('.brand'), h1Is('All products'));
		await s.nav('product', (p) => p.click(`.card[href="/product/${THIRD.id}"]`), h1Is(THIRD.name));
		await s.until(personal('Ada'));
	},
	// A long visit: fifteen more product pages through "You may also like", then the heap.
	async long(s) {
		let at = THIRD.id;
		for (let k = 0; k < 15; k++) {
			const next = productPage(products, at).related[0];
			await s.page.click(`.related .card[href="/product/${next.id}"]`);
			await s.until(h1Is(next.name));
			at = next.id;
		}
		await s.ready();
	}
};
