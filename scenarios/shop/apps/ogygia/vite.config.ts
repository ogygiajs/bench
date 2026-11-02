import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

// The shop as ogygia builds it: every page prerendered once (the same HTML for everyone), the
// greeting and the cart count as server islands (render: 'deferred') each visitor's browser
// fetches, Add to cart an island, ogygia's SPA router between pages. adapter-node serves the
// prerendered pages and answers the server islands.
// `rateLimit: false`: the per-IP budget on the server-island endpoint would throttle the load
// test, which sends every request from one address; real visitors come from many.
export default defineConfig({
	plugins: [
		ogygia({ rateLimit: false }),
		sveltekit({
			adapter: adapter(),
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			}
		})
	]
});
