import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { import_graphs, specifiers_of } from '../src/graph.ts';

test('the specifiers a module loads: static, re-exports, literal dynamic imports; not types', () => {
	const src = `import a from './a.ts';
import type { T } from './types.ts';
import { type U, b } from './b.ts';
import './side.ts';
export * from './c.ts';
export { d } from './d.ts';
export type { E } from './e.ts';
const lazy = () => import('./f.ts');
const tpl = () => import(\`./g.ts\`);
const computed = (x: string) => import('./h' + x);
`;
	assert.deepEqual(specifiers_of('/x/m.ts', src).sort(), [
		'./a.ts',
		'./b.ts',
		'./c.ts',
		'./d.ts',
		'./f.ts',
		'./g.ts',
		'./side.ts'
	]);
});

function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'heisenbench-graph-'));
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return root;
}

test('a bench file reaches what its imports import, package self-names and `#` imports included', () => {
	const root = tree({
		'package.json': '{"name":"root","private":true,"type":"module"}',
		'packages/lib/package.json':
			'{"name":"lib","type":"module","exports":{"./x":"./src/x.ts"},"imports":{"#util":"./src/util.ts"}}',
		'packages/lib/src/x.ts': `import { u } from '#util';\nexport const x = () => u();\n`,
		'packages/lib/src/util.ts': `export const u = () => 1;\n`,
		'packages/lib/src/unused.ts': `export const z = 0;\n`,
		'packages/lib/bench/x.bench.ts': `import { x } from 'lib/x';\nimport { v } from 'virtual:ogygia/sign';\nx(v);\n`
	});
	// `lib` resolves through its own name (self-reference via package exports)
	const g = import_graphs(root, ['packages/lib/bench/x.bench.ts']);
	assert.deepEqual(g.get('packages/lib/bench/x.bench.ts'), [
		'packages/lib/bench/x.bench.ts',
		'packages/lib/src/util.ts',
		'packages/lib/src/x.ts'
	]);
});
