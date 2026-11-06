import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// The baseline: one client-rendered bundle, no SSR; the history comes from a JSON endpoint and
// replies stream from the harness's copy of the shared chat endpoint.
export default defineConfig({
	plugins: [svelte({ compilerOptions: { runes: true } })]
});
