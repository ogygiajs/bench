import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';
import { heisenbench_plugin } from '../src/plugin.ts';
import { RUNTIME_URL } from '../src/transform/index.ts';
import { LoaderCore } from '../src/loader/core.ts';
import { OWN_DIR } from '../src/own.ts';
import { fn_of, measure, temp_dir, write_files } from './helpers.ts';

const LIB = `interface Point {
	x: number;
	y: number;
}

function dist(a: Point, b: Point): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return Math.sqrt(dx * dx + dy * dy);
}

export function longest(points: Point[]): number {
	let best = 0;
	for (let i = 1; i < points.length; i++) {
		const d = dist(points[i - 1], points[i]);
		if (d > best) best = d;
	}
	return best;
}
`;

test('Rolldown plugin: a bundled module counts blocks on its original lines', async () => {
	const dir = temp_dir('heisenbench-plugin-');
	write_files(dir, { 'lib.ts': LIB, 'entry.ts': `export { longest } from './lib.ts';\n` });
	const bundle = await rolldown({
		input: join(dir, 'entry.ts'),
		platform: 'node',
		plugins: [heisenbench_plugin({ root: dir })]
	});
	await bundle.write({ dir: join(dir, 'out'), format: 'esm', entryFileNames: 'entry.js' });
	await bundle.close();
	const mod = (await import(pathToFileURL(join(dir, 'out', 'entry.js')).href)) as {
		longest(p: Array<{ x: number; y: number }>): number;
	};
	const points = [
		{ x: 0, y: 0 },
		{ x: 3, y: 4 },
		{ x: 3, y: 5 },
		{ x: 9, y: 13 }
	];
	let best = 0;
	const r = await measure(() => {
		best = mod.longest(points);
	});
	assert.equal(best, 10);
	const dist = fn_of(r, 'dist');
	assert.equal(dist.module, 'lib.ts');
	assert.equal(dist.calls, 3);
	assert.equal(dist.line, 6);
	const longest = fn_of(r, 'longest');
	assert.deepEqual(
		longest.blocks.map((b) => [b.line, b.count]),
		[
			[12, 1],
			[14, 4],
			[14, 3],
			[14, 3],
			[16, 2],
			[18, 1]
		]
	);
});

test('module.register hooks: plain-node runs are instrumented too', () => {
	const dir = temp_dir('heisenbench-hooks-');
	const hooks = new URL('../src/loader/hooks.ts', import.meta.url).href;
	write_files(dir, {
		'lib.ts': LIB,
		'register.ts': `import { register } from 'node:module';
register(${JSON.stringify(hooks)}, import.meta.url, { data: { root: ${JSON.stringify(dir)} } });
`,
		'main.ts': `import { get_runtime } from ${JSON.stringify(RUNTIME_URL)};
const { longest } = await import('./lib.ts');
const rt = get_runtime();
rt.reset();
longest([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 6, y: 8 }]);
const snap = rt.snapshot();
const m = rt.modules.findIndex((x) => x.meta.id === 'lib.ts');
const fns = rt.modules[m].meta.functions.map((f, i) => [f.path, snap.calls[rt.modules[m].f + i]]);
console.log(JSON.stringify(fns));
`
	});
	const out = execFileSync(
		process.execPath,
		[
			'--no-warnings',
			'--import',
			pathToFileURL(join(dir, 'register.ts')).href,
			join(dir, 'main.ts')
		],
		{ encoding: 'utf8' }
	);
	assert.deepEqual(JSON.parse(out), [
		['<top>', 0],
		['dist', 2],
		['longest', 1]
	]);
});

test('what Heisenbench itself requires (a peer compiler) is never counted, nor what that loads', () => {
	const core = new LoaderCore({ root: '/project' });
	const own = pathToFileURL(join(OWN_DIR, 'peer.ts')).href;
	const compiler = 'file:///project/node_modules/svelte/compiler/index.js';
	const inner = 'file:///project/node_modules/acorn/dist/acorn.js';
	const bench = 'file:///project/lib.bench.ts?heisenbench_gen=1';
	const lib = 'file:///project/lib.js';
	core.note_resolved(compiler, own, ['require', 'node']);
	core.note_resolved(inner, compiler, ['require', 'node']);
	// its own `import` of a bench file is the code under test
	core.note_resolved(bench, own, ['import', 'node']);
	core.note_resolved(lib, bench, ['import', 'node']);
	assert.equal(core.should_instrument(compiler), false);
	assert.equal(core.should_instrument(inner), false);
	assert.equal(core.should_instrument(lib), true);
	assert.equal(core.should_instrument('file:///project/node_modules/acorn/dist/acorn.mjs'), true);
});
