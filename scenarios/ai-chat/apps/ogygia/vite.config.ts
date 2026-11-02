import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

// The chat as ogygia builds it: the page rendered on the server per request (adapter-node) as
// csr = false HTML, the history static, the composer and live replies one island; replies stream
// from a +server.ts endpoint. A single page, so the SPA router is off.
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
