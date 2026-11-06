import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Docs as SvelteKit builds them: every page prerendered, hydrated, client-side navigation with
// Kit's default hover preloading.
export default defineConfig({
	plugins: [
		sveltekit({
			adapter: adapter({ strict: true }),
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			}
		})
	]
});
