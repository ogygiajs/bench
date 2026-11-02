import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import svelte from '@astrojs/svelte';

// The chat as Astro builds it: rendered on the server per request (the Node adapter), the
// history as static HTML, the composer and live replies a Svelte island, replies streamed from
// an API route.
export default defineConfig({
	output: 'server',
	adapter: node({ mode: 'standalone' }),
	integrations: [svelte()]
});
