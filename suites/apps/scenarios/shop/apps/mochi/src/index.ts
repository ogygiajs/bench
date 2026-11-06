import { Mochi, error } from 'mochi-framework';
import products from './shared/data/products.json';
import { productPage } from './shared/catalog.ts';
import { handleCart } from './shared/visitor.ts';

// The shop as Mochi serves it: every page rendered per request (Mochi has no prerendering) with
// no visitor data in it, the greeting and the cart count as server islands (mochi:defer), Add to
// cart a hydrated island, full page loads.
await Mochi.serve({
	port: Number(process.env.PORT) || 3339,
	development: process.env.MODE === 'development',
	htmlShell: './src/shell.html',
	trailingSlash: 'never',
	// Production behind no proxy: the public origin, for Mochi's CSRF check on POST /api/cart.
	proxy: { origin: process.env.ORIGIN },
	routes: {
		'/': Mochi.page('./src/Home.svelte', { serverProps: () => ({ products }) }),
		'/product/:id': Mochi.page('./src/Product.svelte', {
			serverProps: (_req, params) => productPage(products, params.id) ?? error(404)
		}),
		'/api/cart': Mochi.api(({ request }) => handleCart(request))
	}
});
