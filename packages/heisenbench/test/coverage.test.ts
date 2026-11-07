import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installed_packages, package_inventory } from '../src/coverage/inventory.ts';
import { build_coverage, render_coverage } from '../src/coverage/report.ts';
import type { AppReport } from '../src/app/types.ts';
import type { FunctionReport } from '../src/report.ts';
import { temp_dir, write_files } from './helpers.ts';

function app_dir(): string {
	const dir = temp_dir('heisenbench-cov-');
	write_files(dir, {
		'package.json': '{"name":"app","private":true}',
		'node_modules/@x/core/package.json': '{"name":"@x/core","version":"1.0.0"}',
		'node_modules/@x/core/dist/used.js': [
			'export function hot(a) { return helper(a) + 1; }',
			'function helper(a) { const twice = (b) => b * 2; return twice(a); }',
			'export function idle() { return 0; }',
			'export class Box { open() { return 1; } }'
		].join('\n'),
		'node_modules/@x/core/dist/build-time.js':
			'export function plugin() { return { name: "x", transform(code) { return code; } }; }',
		'node_modules/@x/core/dist/types.d.ts': 'export declare function hot(a: number): number;',
		'node_modules/@x/core/node_modules/dep/index.js': 'export function nested() {}',
		'node_modules/other/index.js': 'export function elsewhere() {}'
	});
	return dir;
}

function fn(module: string, path: string, calls: number): FunctionReport {
	return {
		id: `${module} > ${path}`,
		module,
		path,
		kind: 'function',
		line: 1,
		end_line: 1,
		calls,
		self_steps: calls * 3,
		inclusive_steps: calls * 3,
		allocations: 0,
		bytes: 0,
		shape: [],
		blocks: [],
		sites: [],
		builtins: [],
		lines: []
	};
}

test('the inventory is the union of every scenario app: a package one app installs is listed', () => {
	const a = app_dir();
	const b = temp_dir('heisenbench-cov-b-');
	write_files(b, {
		'package.json': '{"name":"blog","private":true}',
		'node_modules/@x/content/package.json': '{"name":"@x/content","version":"1.0.0"}',
		'node_modules/@x/content/index.js': 'export function render(md) { return md; }'
	});
	assert.deepEqual(installed_packages([a, b], ['@x/*', 'other']), [
		'@x/content',
		'@x/core',
		'other'
	]);
	const inv = package_inventory([a, b], installed_packages([a, b], ['@x/*']));
	assert.deepEqual(Object.keys(inv).sort(), [
		'@x/content/index.js',
		'@x/core/dist/build-time.js',
		'@x/core/dist/used.js'
	]);
	// No report reached @x/content: it is listed, not loaded
	const cov = build_coverage([], ['@x/*'], inv);
	assert.equal(cov.packages['@x/content']?.not_loaded, 1);
});

test('the inventory lists every function of a package, nested ones too, and nothing else', () => {
	const inv = package_inventory(app_dir(), ['@x/core']);
	assert.deepEqual(Object.keys(inv).sort(), ['@x/core/dist/build-time.js', '@x/core/dist/used.js']);
	assert.deepEqual(
		inv['@x/core/dist/used.js'].filter((f) => f.kind !== 'top').map((f) => f.path),
		['hot', 'helper', 'helper > twice', 'idle', 'Box > open']
	);
	assert.deepEqual(
		inv['@x/core/dist/build-time.js'].filter((f) => f.kind !== 'top').map((f) => f.path),
		['plugin', 'plugin > transform']
	);
});

test('coverage: reached with calls per unit, loaded but not run, not loaded', () => {
	const dir = app_dir();
	const used = '@x/core/dist/used.js';
	const report: AppReport = {
		schema: 'heisenbench-report/1',
		prices: { version: 1, hash: 'h' },
		node: 'v26',
		git: { sha: null, prefix: '' },
		cases: [
			{
				name: 'shop › server › GET /',
				file: '',
				stable: true,
				timers: 0,
				runaway_timers: false,
				error: null,
				totals: { steps: 100, allocations: 0, bytes: 0, calls: 0 },
				functions: [fn(used, 'hot', 10), fn(used, 'helper', 10), fn(used, 'helper > twice', 10)],
				edges: [],
				app: {
					scenario: 'shop',
					side: 'server',
					unit: 'request',
					units: 5,
					label: 'GET /',
					unstable_functions: []
				}
			}
		],
		app: {
			packages: ['@x/*'],
			ogygia: { '@x/core': '1.0.0' },
			scenarios: ['shop'],
			loaded: {
				[used]: [
					['<top>', 1, 4, 'top'],
					['hot', 1, 1, 'function'],
					['helper', 2, 2, 'function'],
					['helper > twice', 2, 2, 'function'],
					['idle', 3, 3, 'function'],
					['Box > open', 4, 4, 'function']
				]
			}
		}
	};
	const cov = build_coverage([report], ['@x/*'], package_inventory(dir, ['@x/core']));
	const status = Object.fromEntries(cov.functions.map((f) => [f.id, f.status]));
	assert.deepEqual(status, {
		'@x/core/dist/build-time.js > plugin': 'not loaded',
		'@x/core/dist/build-time.js > plugin > transform': 'not loaded',
		'@x/core/dist/used.js > hot': 'reached',
		'@x/core/dist/used.js > helper': 'reached',
		'@x/core/dist/used.js > helper > twice': 'reached',
		'@x/core/dist/used.js > idle': 'loaded',
		'@x/core/dist/used.js > Box > open': 'loaded'
	});
	assert.deepEqual(cov.functions.find((f) => f.path === 'hot')?.calls, {
		'shop server request': 2
	});
	assert.deepEqual(cov.packages['@x/core'], {
		functions: 7,
		reached: 3,
		loaded: 2,
		not_loaded: 2,
		percent: 42.9,
		percent_loaded: 60
	});
	const md = render_coverage(cov);
	assert.match(md, /\| `@x\/core` \| 7 \| 3 \| \*\*42\.9%\*\* \| 60% \| 2 \| 2 \|/);
	assert.match(md, /`@x\/core\/dist\/used\.js:3 > idle`/);
	assert.match(md, /`@x\/core\/dist\/build-time\.js`: 2 functions/);
	// a package outside the list is not counted
	assert.equal(build_coverage([report], ['other']).functions.length, 0);
});
