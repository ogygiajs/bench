import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import svelte from '@astrojs/svelte';

// The dashboard as Astro builds it: rendered on the server per request (the Node adapter), the
// live panel and the table as Svelte islands, the bar chart as static HTML.
export default defineConfig({
	output: 'server',
	adapter: node({ mode: 'standalone' }),
	integrations: [svelte()]
});
