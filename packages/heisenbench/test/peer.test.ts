import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { require_typescript } from '../src/peer.ts';
import { temp_dir, write_files } from './helpers.ts';

test('a project on TypeScript 7 is passed over for a copy that has the compiler API', () => {
	const project = temp_dir();
	write_files(project, {
		'package.json': '{"name":"on-ts7","type":"module"}',
		'node_modules/typescript/package.json':
			'{"name":"typescript","version":"7.0.2","main":"index.js"}',
		'node_modules/typescript/index.js': 'module.exports = { version: "7.0.2" };',
		'src/a.ts': 'export const a = 1;\n'
	});
	const ts = require_typescript<{ version: string; transpileModule: unknown }>(
		'heisenbench dts',
		join(project, 'src/a.ts')
	);
	assert.equal(typeof ts.transpileModule, 'function');
	assert.notEqual(ts.version, '7.0.2');
});
