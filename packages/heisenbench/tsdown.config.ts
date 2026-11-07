import { defineConfig } from 'tsdown';

/*
 * The npm build: built JavaScript and .d.ts, because Node does not strip types from files inside
 * node_modules. dist/ mirrors src/ file for file (unbundled), so every path src/own.ts resolves
 * (child scripts, the counting runtime, loaders) exists in both layouts. @bench/compare is a
 * private workspace package: what Heisenbench uses of it is built in.
 */
export default defineConfig({
	entry: ['src/**/*.ts'],
	outDir: 'dist',
	format: 'esm',
	platform: 'node',
	target: 'node26',
	unbundle: true,
	root: 'src',
	fixedExtension: false,
	sourcemap: true,
	dts: { resolve: ['@bench/compare'], tsc: { eager: true } },
	clean: true,
	// rolldown is a dev dependency `heisenbench verify` imports when it runs (bench repo only).
	deps: { alwaysBundle: ['@bench/compare'], neverBundle: ['rolldown'] }
});
