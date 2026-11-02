import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// The baseline: one client-rendered bundle, no SSR; the catalog and the visitor come from JSON
// endpoints, and the shell is the same static file for everyone.
export default defineConfig({
	plugins: [svelte({ compilerOptions: { runes: true } })]
});
