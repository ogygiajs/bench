import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CONFIG_FILE, define_config, read_config } from '../src/config.ts';
import { defineConfig } from '../src/index.ts';
import { DEFAULT_ENV, env_for } from '../src/transform/env.ts';
import { temp_dir, write_files } from './helpers.ts';

const IMPORT = `import { defineConfig } from 'heisenbench';\n`;

test('config: the file is heisenbench.config.ts, and defineConfig hands back what it is given', () => {
	assert.equal(CONFIG_FILE, 'heisenbench.config.ts');
	const c = { importMetaEnv: { SSR: true } };
	assert.equal(defineConfig(c), c);
	assert.equal(define_config, defineConfig);
});

test('config: the nearest heisenbench.config.ts is found and its env applied over the default', () => {
	const dir = temp_dir('heisenbench-config-found-');
	write_files(dir, {
		'package.json': JSON.stringify({ name: 'root' }),
		[CONFIG_FILE]: `${IMPORT}export default defineConfig({ importMetaEnv: { SSR: true, VITE_API: '/api' } });\n`,
		'packages/a/package.json': JSON.stringify({ name: 'a' }),
		'packages/b/package.json': JSON.stringify({ name: 'b' }),
		[`packages/b/${CONFIG_FILE}`]: `export default { importMetaEnv: { MODE: 'staging', N: -1, X: null } };\n`
	});
	assert.deepEqual(env_for(join(dir, 'packages/a/src/x.ts')), {
		...DEFAULT_ENV,
		SSR: true,
		VITE_API: '/api'
	});
	// the nearest config wins whole: b's does not merge with the root's
	assert.deepEqual(env_for(join(dir, 'packages/b/deep/x.ts')), {
		...DEFAULT_ENV,
		MODE: 'staging',
		N: -1,
		X: null
	});
});

test('config: a key the config sets wins over the default env', () => {
	const dir = temp_dir('heisenbench-config-wins-');
	write_files(dir, {
		'package.json': JSON.stringify({ name: 'p' }),
		[CONFIG_FILE]: `export default {\n\timportMetaEnv: { SSR: true, DEV: true, MODE: "test", BASE_URL: \`/app/\` }\n} satisfies object;\n`
	});
	assert.deepEqual(env_for(join(dir, 'x.ts')), {
		...DEFAULT_ENV,
		SSR: true,
		DEV: true,
		MODE: 'test',
		BASE_URL: '/app/'
	});
});

test('config: no config file anywhere is fine, and the env is the default', () => {
	const dir = temp_dir('heisenbench-config-none-');
	write_files(dir, { 'package.json': JSON.stringify({ name: 'p' }), 'src/x.ts': '' });
	assert.equal(read_config(dir), null);
	assert.deepEqual(env_for(join(dir, 'src/x.ts')), DEFAULT_ENV);
});

test('config: an empty config and one without importMetaEnv read the default env', () => {
	const dir = temp_dir('heisenbench-config-empty-');
	write_files(dir, {
		[`a/${CONFIG_FILE}`]: `${IMPORT}export default defineConfig({});\n`,
		[`b/${CONFIG_FILE}`]: `export default {} as const;\n`
	});
	assert.deepEqual(read_config(join(dir, 'a')), {});
	assert.deepEqual(env_for(join(dir, 'a/x.ts')), DEFAULT_ENV);
	assert.deepEqual(env_for(join(dir, 'b/x.ts')), DEFAULT_ENV);
});

test('config: the default export is read as data, never run, and anything else fails out loud', () => {
	const dir = temp_dir('heisenbench-config-bad-');
	const cases: Array<[string, string, RegExp]> = [
		['no-default', `export const config = {};\n`, /must have a default export/],
		['not-object', `export default 1;\n`, /default export must be an object/],
		['computed', `const env = { SSR: true };\nexport default { importMetaEnv: env };\n`, /literal/],
		['call', `export default defineConfig(make());\n`, /literal/],
		['spread', `export default { ...base };\n`, /literal/],
		['unknown', `export default { importMetaENV: { SSR: true } };\n`, /unknown key importMetaENV/],
		['bad-value', `export default { importMetaEnv: { DEV: [1] } };\n`, /importMetaEnv\.DEV must be a string/],
		['template', 'export default { importMetaEnv: { A: `${x}` } };\n', /literal/],
		['syntax', `export default {\n`, /does not parse/]
	];
	for (const [name, text, error] of cases) {
		write_files(dir, { [`${name}/${CONFIG_FILE}`]: text });
		assert.throws(() => env_for(join(dir, name, 'x.ts')), error, name);
	}
	// it was never run: a side effect at the top level does nothing
	write_files(dir, {
		[`effect/${CONFIG_FILE}`]: `globalThis.__ran = true;\nexport default { importMetaEnv: { SSR: true } };\n`
	});
	assert.equal(env_for(join(dir, 'effect/x.ts')).SSR, true);
	assert.equal((globalThis as { __ran?: boolean }).__ran, undefined);
});

test('config: the old package.json heisenbench.importMetaEnv field is refused, pointing at the config file', () => {
	const dir = temp_dir('heisenbench-config-old-field-');
	write_files(dir, {
		'package.json': JSON.stringify({ heisenbench: { importMetaEnv: { SSR: true } } })
	});
	assert.throws(() => env_for(join(dir, 'x.ts')), /heisenbench\.config\.ts/);
});
