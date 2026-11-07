import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiffResult, Report, SearchCase } from '@bench/heisenbench';
import { HEISENBENCH_DIR } from '../src/run.ts';
import {
	cases_with_inputs,
	flagged,
	pick_cases,
	run_full_search,
	run_searches
} from '../src/search.ts';
import type { SearchResult, SearchRun } from '../src/search.ts';
import { full_search_lines, search_lines } from '../src/section.ts';

test('the cases that declare an input are found in the bench file', () => {
	const src = `import { bench as b } from '@bench/heisenbench/bench';
import { opts } from './o.ts';
b('with setup', ({ xs }) => f(xs), { setup: () => ({ xs: [1] }) });
b(\`template\`, (c) => f(c), { teardown() {}, setup() { return 1; } });
b('only teardown', () => f(), { teardown: () => {} });
b('no options', () => f());
b('options from elsewhere', (c) => f(c), opts);
b('spread', (c) => f(c), { ...opts });
for (const n of [1, 2]) b(\`computed \${n}\`, () => f(), { setup: () => n });
other('not a bench', () => f(), { setup: () => 1 });
`;
	assert.deepEqual([...cases_with_inputs('x.bench.ts', src)].sort(), [
		'options from elsewhere',
		'spread',
		'template',
		'with setup'
	]);
});

function change(name: string, steps: number, findings = 1) {
	return {
		case: name,
		module: 'm.ts',
		function: 'f',
		delta: { self_steps: steps },
		findings: Array.from({ length: findings }, () => ({}))
	};
}

test('the cases picked: changed, with an input, biggest change first, capped', () => {
	const diff = {
		changes: [
			change('a', 10),
			change('b', -500),
			change('c', 40),
			change('d', 99, 0),
			change('e', 7)
		]
	} as unknown as DiffResult;
	const head = {
		cases: ['a', 'b', 'c', 'd', 'e'].map((name) => ({
			name,
			file: name === 'e' ? 'other.bench.ts' : 'x.bench.ts',
			error: null
		}))
	} as unknown as Report;
	const inputs = (file: string) => new Set(file === 'x.bench.ts' ? ['a', 'b', 'd'] : []);
	const pick = pick_cases(diff, head, inputs, 1);
	// b first (|Δ| 500); a is past the cap; c and e have no input; d did not change
	assert.deepEqual(pick.picks, [{ name: 'b', file: 'x.bench.ts' }]);
	assert.equal(pick.over, 1);
	assert.equal(pick.no_input, 2);
});

const found = (ratio: number, error: string | null = null): SearchCase => ({
	name: 'c',
	file: 'x.bench.ts',
	typical: 100,
	worst: 100 * ratio,
	ratio,
	evals: 300,
	stopped: 'evals',
	input: '{"xs":[3,2,1]}',
	mutations: [],
	error
});

const searched = (head: SearchCase | null, base: SearchCase | null): SearchResult => ({
	name: 'c | d',
	file: 'x.bench.ts',
	head,
	base,
	error: null
});

test('flagged by Heisenbench’s rule: 4x typical and twice the base’s ratio', () => {
	assert.equal(flagged(searched(found(5), found(1))), true);
	assert.equal(flagged(searched(found(5), null)), true);
	assert.equal(flagged(searched(found(5), found(3))), false);
	assert.equal(flagged(searched(found(3.9), null)), false);
	assert.equal(flagged(searched(found(9, 'boom'), null)), false);
	assert.equal(flagged(searched(null, null)), false);
	// or a pattern that grows superlinearly where the base's does not
	assert.equal(flagged(searched(steep(1.5), found(1))), true);
	assert.equal(flagged(searched(steep(1.5), null)), true);
	assert.equal(flagged(searched(steep(1.5), steep(1.5))), false);
});

const steep = (ratio: number): SearchCase => ({
	...found(ratio),
	finding: { reasons: ['superlinear'], text: 'grows quadratic (exponent 2) when nested deeper' }
});

const run_of = (cases: SearchResult[], over: Partial<SearchRun> = {}): SearchRun => ({
	budget_ms: 240_000,
	spent_ms: 75_000,
	cases,
	no_input: 0,
	skipped: 0,
	...over
});

test('the search is one line, plus one per flagged case', () => {
	const quiet = search_lines(run_of([searched(found(1), found(1))]));
	assert.deepEqual(quiet, [
		'**Worst-case search** (1 changed case with an input, 1 min 15 s of a 4 min budget): no input of the same size costs 4x the typical steps or more, or grows superlinearly.'
	]);
	const grows = search_lines(run_of([searched(steep(1.5), found(1))]));
	assert.equal(grows[2], '- ⚠️ `c \\| d`: grows quadratic (exponent 2) when nested deeper');
	const hit = search_lines(run_of([searched(found(10.5), found(1))], { skipped: 2 }));
	assert.match(hit[0], /2 not searched \(time or the case cap\)/);
	assert.equal(
		hit[2],
		'- ⚠️ `c \\| d`: an input costs 10.5x the typical steps (1,050 vs 100; 1x on the base): `{"xs":[3,2,1]}`'
	);
	assert.match(
		search_lines(run_of([], { no_input: 3 }))[0],
		/nothing to search \(3 changed cases with no input\)/
	);
	// no changed case at all: no line
	assert.deepEqual(search_lines(run_of([])), []);
});

test('a real search on a small tree, both sides, within its budget', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'heisenbench-search-'));
	mkdirSync(join(dir, 'node_modules', '@bench'), { recursive: true });
	symlinkSync(HEISENBENCH_DIR, join(dir, 'node_modules', '@bench', 'heisenbench'), 'dir');
	mkdirSync(join(dir, 'packages', 'p', 'bench'), { recursive: true });
	writeFileSync(join(dir, 'package.json'), '{"name":"t","private":true,"type":"module"}');
	const file = 'packages/p/bench/sum.bench.ts';
	writeFileSync(
		join(dir, file),
		`import { bench } from '@bench/heisenbench/bench';
const total = (xs: number[]) => { let s = 0; for (const x of xs) s += x; return s; };
bench('total', ({ xs }) => total(xs), { setup: () => ({ xs: [1, 2, 3, 4] }) });
bench('total twice', ({ xs }) => total(xs) + total(xs), { setup: () => ({ xs: [1, 2] }) });
`
	);
	const tree = { dir, sha: 'a'.repeat(40), preload: null, benches: [file] };
	const run = await run_searches(
		tree,
		tree,
		{ picks: [{ name: 'total', file }], no_input: 0, over: 0 },
		join(dir, '.out'),
		() => {},
		60_000,
		new Set(['total'])
	);
	assert.equal(run.cases.length, 1);
	const [c] = run.cases;
	assert.equal(c.error, null);
	// the filter matched both cases; the exact one was taken
	assert.equal(c.head?.name, 'total');
	assert.equal(c.base?.name, 'total');
	assert.equal(c.head?.ratio, 1);
	assert.ok(run.spent_ms < 60_000);
	// no budget left: nothing runs, the case is counted as skipped
	const none = await run_searches(
		tree,
		null,
		{ picks: [{ name: 'total', file }], no_input: 0, over: 0 },
		join(dir, '.out2'),
		() => {},
		1000
	);
	assert.deepEqual([none.cases.length, none.skipped], [0, 1]);
});

test('a full run searches every case that declares an input, and lists only its findings', async () => {
	// the real path: under a symlinked temp dir the bench file is outside the counted root
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'heisenbench-full-search-')));
	mkdirSync(join(dir, 'node_modules', '@bench'), { recursive: true });
	symlinkSync(HEISENBENCH_DIR, join(dir, 'node_modules', '@bench', 'heisenbench'), 'dir');
	mkdirSync(join(dir, 'packages', 'p', 'bench'), { recursive: true });
	writeFileSync(join(dir, 'package.json'), '{"name":"t","private":true,"type":"module"}');
	const sum = 'packages/p/bench/sum.bench.ts';
	const nest = 'packages/p/bench/nest.bench.ts';
	const bare = 'packages/p/bench/bare.bench.ts';
	// the counted code lives in the package's source, as in ogygia
	mkdirSync(join(dir, 'packages', 'p', 'src'), { recursive: true });
	writeFileSync(
		join(dir, 'packages', 'p', 'src', 'lib.ts'),
		`export function total(xs: number[]): number {
	let s = 0;
	for (const x of xs) s += x;
	return s;
}

export function spans(s: string): number {
	let t = 0;
	for (let i = 0; i < s.length; i++) {
		if (s[i] !== '(') continue;
		let d = 0;
		for (let j = i; j < s.length; j++) {
			if (s[j] === '(') d++;
			else if (s[j] === ')' && --d === 0) {
				t += j - i;
				break;
			}
		}
	}
	return t;
}
`
	);
	writeFileSync(
		join(dir, sum),
		`import { bench } from '@bench/heisenbench/bench';
import { total } from '../src/lib.ts';
bench('total', ({ xs }) => total(xs), { setup: () => ({ xs: [1, 2, 3, 4] }) });
`
	);
	writeFileSync(
		join(dir, nest),
		`import { bench } from '@bench/heisenbench/bench';
import { spans } from '../src/lib.ts';
bench('spans', ({ src }) => spans(src), { setup: () => ({ src: '(a b) (c d) (e f) (g h)' }), grammar: 'js' });
`
	);
	writeFileSync(
		join(dir, bare),
		`import { bench } from '@bench/heisenbench/bench';
bench('no input', () => 1);
`
	);
	const tree = { dir, sha: 'b'.repeat(40), preload: null, benches: [sum, nest, bare] };
	const run = await run_full_search(tree, [sum, nest, bare], join(dir, '.out'), () => {}, 120_000);
	assert.deepEqual([run.files, run.searched_files, run.errors], [2, 2, []]);
	assert.deepEqual(run.cases.map((c) => [c.file, c.name, !!c.finding]).sort(), [
		[nest, 'spans', true],
		[sum, 'total', false]
	]);
	const lines = full_search_lines(run);
	assert.match(lines[0], /^\*\*Worst-case search\*\* \(2 cases in 2 bench files, .*\):$/);
	assert.equal(lines.filter((l) => l.startsWith('- ')).length, 1);
	assert.match(lines[2], /^- `spans` \(`packages\/p\/bench\/nest\.bench\.ts`\): .*grows quadratic/);
});
