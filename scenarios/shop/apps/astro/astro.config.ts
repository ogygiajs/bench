import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import svelte from '@astrojs/svelte';

// The shop as Astro builds it: every page prerendered (static output, the same HTML for
// everyone), the greeting and the cart count as server islands (server:defer), Add to cart a
// Svelte island, full page loads. The Node adapter answers the server islands and the cart API.
export default defineConfig({
	output: 'static',
	adapter: node({ mode: 'standalone' }),
	integrations: [svelte()],
	trailingSlash: 'never'
});
