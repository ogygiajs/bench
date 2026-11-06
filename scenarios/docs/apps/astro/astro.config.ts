import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';

// Docs as Astro builds them: a static site, Svelte islands for the search box, the code tabs and
// the table of contents, full page loads between pages (Astro's default).
export default defineConfig({
	integrations: [svelte()],
	trailingSlash: 'never'
});
