import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Report } from '../src/report.ts';
import { temp_dir, write_files } from './helpers.ts';

/*
 * `--svelte client`: .svelte modules compiled as client output, resolved with the `browser`
 * condition (so `svelte` is the client runtime), in a run and its children; `--append` puts a
 * server run and a client run of one commit in one report.
 */

const HEISENBENCH = fileURLToPath(new URL('../', import.meta.url));
const CLI = join(HEISENBENCH, 'src/cli.ts');

function heisenbench(args: string[], cwd: string) {
	const r = spawnSync(process.execPath, [CLI, ...args], {
		cwd,
		encoding: 'utf8',
		timeout: 120_000
	});
	return { code: r.status, out: r.stdout + r.stderr };
}

function project(): string {
	const dir = temp_dir('heisenbench-svelte-client-');
	symlinkSync(join(HEISENBENCH, 'node_modules'), join(dir, 'node_modules'));
	write_files(dir, {
		'package.json': '{ "type": "module" }',
		'counter.svelte.ts': [
			'export class Counter {',
			'	count = $state(0);',
			'	double = $derived(this.count * 2);',
			'	add(n: number): number {',
			'		this.count += n;',
			'		return this.double;',
			'	}',
			'}',
			''
		].join('\n'),
		// `flushSync` from `svelte`: the client runtime's with the browser condition
		'client.bench.ts': [
			`import { bench } from ${JSON.stringify(join(HEISENBENCH, 'src/bench.ts'))};`,
			"import { flushSync } from 'svelte';",
			"import { Counter } from './counter.svelte.ts';",
			"bench('counter · client', () => { const c = new Counter(); for (let i = 0; i < 20; i++) c.add(i); flushSync(); return c.double; });",
			''
		].join('\n'),
		'server.bench.ts': [
			`import { bench } from ${JSON.stringify(join(HEISENBENCH, 'src/bench.ts'))};`,
			"import { Counter } from './counter.svelte.ts';",
			"bench('counter · server', () => { const c = new Counter(); for (let i = 0; i < 20; i++) c.add(i); return c.double; });",
			''
		].join('\n')
	});
	return dir;
}

const read = (dir: string): Report =>
	JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')) as Report;
const client_runtime = (r: Report, name: string) =>
	r.cases
		.find((c) => c.name === name)!
		.functions.some((f) => f.module.includes('/src/internal/client/'));

test('--svelte client counts the client runtime, in the run and its plain-build children', () => {
	const dir = project();
	const server = heisenbench(['run', 'server.bench.ts', '--out', 'r.json'], dir);
	assert.equal(server.code, 0, server.out);
	assert.equal(client_runtime(read(dir), 'counter · server'), false, 'server output by default');

	const client = heisenbench(
		[
			'run',
			'client.bench.ts',
			'--svelte',
			'client',
			'--measure',
			'time',
			'--time-ms',
			'20',
			'--out',
			'r.json'
		],
		dir
	);
	assert.equal(client.code, 0, client.out);
	const r = read(dir);
	const c = r.cases[0];
	assert.equal(c.error, null);
	assert.ok(
		client_runtime(r, 'counter · client'),
		'client output, counted with the runtime it calls'
	);
	assert.ok(
		c.functions.some((f) => f.path.endsWith('flushSync')),
		"`svelte` resolved to the client runtime (the server's flushSync is not the one called)"
	);
	assert.ok(
		(c.measure?.time?.samples ?? 0) > 0,
		'the plain build compiled it the same way: ' + JSON.stringify(c.measure)
	);

	const bad = heisenbench(['run', 'client.bench.ts', '--svelte', 'browser'], dir);
	assert.equal(bad.code, 2, bad.out);
});

test('--append: a server run and a client run of one commit are one report', () => {
	const dir = project();
	assert.equal(heisenbench(['run', 'server.bench.ts', '--out', 'r.json'], dir).code, 0);
	const a = heisenbench(
		['run', 'client.bench.ts', '--svelte', 'client', '--out', 'r.json', '--append'],
		dir
	);
	assert.equal(a.code, 0, a.out);
	assert.match(a.out, /appended to r\.json: 2 cases in all/);
	assert.deepEqual(
		read(dir).cases.map((c) => c.name),
		['counter · server', 'counter · client']
	);
	// again: the client case is replaced, not added twice
	assert.equal(
		heisenbench(
			['run', 'client.bench.ts', '--svelte', 'client', '--out', 'r.json', '--append'],
			dir
		).code,
		0
	);
	assert.equal(read(dir).cases.length, 2);
	// without --append the run starts the report again
	assert.equal(
		heisenbench(['run', 'client.bench.ts', '--svelte', 'client', '--out', 'r.json'], dir).code,
		0
	);
	assert.deepEqual(
		read(dir).cases.map((c) => c.name),
		['counter · client']
	);
});
