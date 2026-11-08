import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CaseReport, Report } from '../src/report.ts';
import { engine_health } from '../src/engine/health.ts';
import { run_child } from '../src/measure/spawn.ts';
import type { CaseResult } from '../src/measure/child.ts';
import type { TimeStats } from '../src/measure/time.ts';
import { DEFAULT_ENV, define_env, env_for } from '../src/transform/env.ts';
import { BENCH_API, KEYS, cli } from '../src/verify/fixture.ts';
import { temp_dir, write_files } from './helpers.ts';

const LIB = `export function flags(): string {
	if (import.meta.env.DEV) throw new Error('DEV code ran in a production build');
	const { MODE, SSR } = import.meta.env;
	return [MODE, SSR, import.meta.env.BASE_URL, import.meta.env.PROD, String(import.meta.env.NOPE)].join(':');
}

export function read_env(): boolean {
	return import.meta.env.SSR;
}

export function read_constant(): boolean {
	return false;
}
`;

/** A dependency that reads it too: a production build defines every module it bundles. */
const DEP = `export function dep_mode() {
	return import.meta.env.MODE;
}
`;

function bench_file(want: string, order: 'forward' | 'reverse' = 'forward'): string {
	const cases = [
		`bench('flags', () => {
	const seen = flags() + '|' + dep_mode() + '|' + BENCH_MODE;
	if (seen !== ${JSON.stringify(want)}) throw new Error('import.meta.env read ' + seen);
	return seen;
});`,
		`bench('env read', () => read_env());`,
		`bench('constant', () => read_constant());`
	];
	if (order === 'reverse') cases.reverse();
	return [
		`import { bench } from ${JSON.stringify(BENCH_API)};`,
		`import { flags, read_env, read_constant } from './src/lib.ts';`,
		`import { dep_mode } from 'envdep';`,
		`const BENCH_MODE = import.meta.env.MODE;`,
		...cases,
		''
	].join('\n');
}

function project(dir: string, want: string, env?: object, order?: 'forward' | 'reverse'): void {
	write_files(dir, {
		'package.json': JSON.stringify({
			name: 'env-project',
			private: true,
			type: 'module',
			...(env ? { heisenbench: { importMetaEnv: env } } : {})
		}),
		'node_modules/envdep/package.json': JSON.stringify({
			name: 'envdep',
			version: '1.0.0',
			type: 'module',
			exports: './index.js'
		}),
		'node_modules/envdep/index.js': DEP,
		'src/lib.ts': LIB,
		'lib.bench.ts': bench_file(want, order)
	});
}

const PRODUCTION = 'production:false:/:true:undefined|production|production';

function case_of(r: Report, name: string): CaseReport {
	const c = r.cases.find((x) => x.name === name);
	assert.ok(c, `case ${name}`);
	assert.equal(c.error, null, `${name}: ${c.error}`);
	return c;
}

function steps_of(c: CaseReport, path: string): number {
	const f = c.functions.find((x) => x.path === path);
	assert.ok(f, `${path} in ${c.name}`);
	return f.self_steps;
}

test('define: a read becomes its literal in place, padded so no column moves', () => {
	const code =
		'if (import.meta.env.DEV) f(import.meta.env.MODE, import.meta.env?.SSR, import.meta.env["BASE_URL"]);\n' +
		'export const n = import.meta.env.N.toFixed(), x = import.meta.env.NOPE;\n';
	const out = define_env(code, '/x/a.js', null, { ...DEFAULT_ENV, N: -1 });
	assert.equal(out.code.length, code.length);
	assert.equal(out.map, null);
	const lines = out.code.split('\n');
	assert.equal(
		lines[0],
		`if (false${' '.repeat(14)}) f("production"${' '.repeat(8)}, false${' '.repeat(15)}, "/"${' '.repeat(24)});`
	);
	assert.equal(
		lines[1],
		`export const n = (-1)${' '.repeat(13)}.toFixed(), x = undefined${' '.repeat(11)};`
	);
});

test('define: the bare object, a computed key and a write target get the whole env, with a map', () => {
	const code =
		'const { DEV } = import.meta.env;\nconst k = import.meta.env[key];\nimport.meta.env.X = 1;\nconst u = import.meta.url;\n';
	const out = define_env(code, '/x/a.js', null, DEFAULT_ENV);
	const env = '({"BASE_URL":"/","DEV":false,"MODE":"production","PROD":true,"SSR":false})';
	assert.deepEqual(out.code.split('\n'), [
		`const { DEV } = ${env};`,
		`const k = ${env}[key];`,
		`${env}.X = 1;`,
		'const u = import.meta.url;',
		''
	]);
	assert.ok(out.map !== null, 'a longer replacement maps back');
});

test('define: code without import.meta.env comes back byte for byte', () => {
	for (const code of [
		'export const a = import.meta.url + "import.meta.env";\n',
		'// import.meta.env.DEV in a comment\nexport const b = 1;\n',
		'export const env = { DEV: true };\n'
	]) {
		const out = define_env(code, '/x/a.js', null, DEFAULT_ENV);
		assert.equal(out.code, code);
		assert.equal(out.map, null);
	}
	// every answer key's code, the code `heisenbench verify` and the fuzzer count
	let files = 0;
	for (const key of readdirSync(KEYS).filter((d) => d.endsWith('-key'))) {
		const texts = readdirSync(join(KEYS, key), { recursive: true, encoding: 'utf8' });
		for (const f of texts.filter((x) => x.endsWith('.txt'))) {
			const code = readFileSync(join(KEYS, key, f), 'utf8');
			const file = join('/x', f.replace(/\.txt$/, ''));
			assert.equal(define_env(code, file, null, DEFAULT_ENV).code, code, `${key}/${f}`);
			files++;
		}
	}
	assert.ok(files > 20, `${files} answer-key files`);
});

test('env: the nearest package.json that sets heisenbench.importMetaEnv, merged over the default', () => {
	const dir = temp_dir('heisenbench-env-config-');
	write_files(dir, {
		'package.json': JSON.stringify({
			heisenbench: { importMetaEnv: { SSR: true, VITE_API: '/api' } }
		}),
		'packages/a/package.json': JSON.stringify({ name: 'a' }),
		'packages/b/package.json': JSON.stringify({
			heisenbench: { importMetaEnv: { MODE: 'staging' } }
		}),
		'bad/package.json': JSON.stringify({ heisenbench: { importMetaEnv: { DEV: [1] } } })
	});
	assert.deepEqual(env_for(join(dir, 'packages/a/src/x.ts')), {
		...DEFAULT_ENV,
		SSR: true,
		VITE_API: '/api'
	});
	assert.deepEqual(env_for(join(dir, 'packages/b/x.ts')), { ...DEFAULT_ENV, MODE: 'staging' });
	assert.throws(() => env_for(join(dir, 'bad/x.ts')), /importMetaEnv\.DEV must be a string/);
});

test('counted build: import.meta.env reads the production env, and a read costs what a constant costs', async () => {
	const dir = temp_dir('heisenbench-env-counted-');
	project(dir, PRODUCTION);
	for (const deps of ['all', 'none']) {
		const r = await cli(dir, ['run', '--deps', deps]);
		case_of(r, 'flags');
		const read = steps_of(case_of(r, 'env read'), 'read_env');
		assert.equal(read, steps_of(case_of(r, 'constant'), 'read_constant'), `--deps ${deps}`);
		if (deps === 'all')
			assert.ok(case_of(r, 'flags').functions.some((f) => f.module.startsWith('envdep@1.0.0')));
	}
});

test('plain build: the time layer reads the same env, dependencies included', async () => {
	const dir = temp_dir('heisenbench-env-plain-');
	project(dir, PRODUCTION);
	const r = await run_child<Array<CaseResult<TimeStats>>>({
		kind: 'time',
		roots: [dir],
		files: [['lib.bench.ts']],
		options: { time_ms: 20, warmup_ms: 5 }
	});
	assert.deepEqual(
		r.map((c) => [c.name, c.error]),
		[
			['flags', null],
			['env read', null],
			['constant', null]
		]
	);
	// the engine-health child runs the plain code too
	const health = await engine_health({ files: [join(dir, 'lib.bench.ts')], root: dir });
	assert.deepEqual(
		health.cases.map((c) => [c.name, c.error]),
		[
			['flags', null],
			['env read', null],
			['constant', null]
		]
	);
});

test('a project sets its own env in package.json: both builds read it', async () => {
	const dir = temp_dir('heisenbench-env-override-');
	const want = 'staging:true:/app/:true:undefined|staging|staging';
	project(dir, want, { MODE: 'staging', SSR: true, BASE_URL: '/app/' });
	const r = await cli(dir, ['run']);
	case_of(r, 'flags');
	assert.equal(
		steps_of(case_of(r, 'env read'), 'read_env'),
		steps_of(case_of(r, 'constant'), 'read_constant')
	);
	const t = await run_child<Array<CaseResult<TimeStats>>>({
		kind: 'time',
		roots: [dir],
		files: [['lib.bench.ts']],
		options: { time_ms: 20, warmup_ms: 5 }
	});
	assert.equal(t.find((c) => c.name === 'flags')?.error, null);
});

test('import.meta.env counts the same at another root and in another case order', async () => {
	const work = (r: Report): unknown =>
		Object.fromEntries(r.cases.map((c) => [c.name, { ...c, error: c.error }]));
	const a = temp_dir('hb-env-');
	const b = join(temp_dir(`a-much-longer-checkout-${'x'.repeat(40)}-`), 'ünï cødé', 'deeper');
	const c = temp_dir('hb-env-order-');
	project(a, PRODUCTION);
	project(b, PRODUCTION);
	project(c, PRODUCTION, undefined, 'reverse');
	const [ra, rb, rc] = [await cli(a, ['run']), await cli(b, ['run']), await cli(c, ['run'])];
	case_of(ra, 'flags');
	assert.deepEqual(work(rb), work(ra), 'a long root with unicode and spaces counts the same');
	const strip = (r: Report): unknown =>
		Object.fromEntries(
			r.cases.map((x) => [x.name, x.functions.map((f) => [f.id, f.self_steps, f.calls])])
		);
	assert.deepEqual(strip(rc), strip(ra), 'cases in another order count the same');
});
