import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// The baseline: one client-rendered bundle, no SSR. Page bodies are fetched as JSON on navigation.
export default defineConfig({
	plugins: [svelte({ compilerOptions: { runes: true } })]
});
