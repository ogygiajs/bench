import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

// The dashboard as ogygia builds it: rendered on the server per request (adapter-node) as
// csr = false HTML; the live panel and the table are islands, the bar chart ships no JS. A single
// page, so the SPA router is off.
export default defineConfig({
	plugins: [
		ogygia({ router: false }),
		sveltekit({
			adapter: adapter(),
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			}
		})
	]
});
