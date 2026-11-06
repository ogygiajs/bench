import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The shop as SvelteKit builds it: every page rendered on the server per request with the
// visitor's cookies read in a layout load (adapter-node), then hydrated, Kit's client router.
export default defineConfig({
	plugins: [
		sveltekit({
			adapter: adapter(),
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			}
		})
	]
});
