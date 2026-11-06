import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

// Docs as ogygia builds them: every page prerendered as server HTML (csr = false), islands for
// the search box, the code tabs and the table of contents, and ogygia's SPA router (on by
// default) for navigation between pages.
export default defineConfig({
	plugins: [
		ogygia(),
		sveltekit({
			adapter: adapter({ strict: true }),
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			}
		})
	]
});
