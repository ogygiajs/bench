/**
 * Planted changes for the training data (training.ts): pairs of code whose difference is known by
 * construction, a slowdown, a speedup or a harmless edit, each at a few input sizes. The step
 * change each one makes is counted and the time change measured; together they are labeled
 * examples of "this step change shows (or does not show) on the clock".
 *
 * Templates, most taken from Heisenbench's own answer keys (packages/heisenbench/test):
 *
 *   spin        time-key: one loop made 0.5x to 4x as long, in small steps near 1x; comments
 *   answer      answer-key: extra loop, extra allocation, quadratic helper (and each undone, a
 *               speedup); rename, comments, reorder, formatting
 *   engine      engine-key: shape order, int to double, delete, megamorphic reads (and each undone);
 *               their same-line twins; rename, comments
 *   growth      growth-key: linear to quadratic (and back); a constant factor
 *   kind        one helper per kind of work (arithmetic, allocation, strings, array built-ins,
 *               sort, Map, JSON, closures, calls), each called more (1, 4, 16 times), not at all,
 *               or renamed; comments, reorder, identical code
 *
 * Every pair is one bench file with one case, named after the pair (so a time comparison, which
 * keys cases by name, finds it). The code is the same on every run: no randomness, no dates.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HEISENBENCH_DIR } from './run.ts';

/** The direction of the change, by construction. */
export type Planted = 'slower' | 'faster' | 'same';

export type Template = 'spin' | 'answer' | 'engine' | 'growth' | 'kind';

/**
 * What `planted` is about, per template: the work counted (`steps`), or what V8 does (`engine`:
 * an engine twin changes the same line without changing a shape, so it is `same` there, though
 * it may add steps).
 */
export const PLANTED_FOR: Record<Template, 'steps' | 'engine'> = {
	spin: 'steps',
	answer: 'steps',
	engine: 'engine',
	growth: 'steps',
	kind: 'steps'
};

export interface PlantedPair {
	/** Unique, and a valid directory name: `spin-x1.05-n2000`. */
	id: string;
	template: Template;
	variant: string;
	planted: Planted;
	/** The template's size knob (rows, loop length, items). */
	size: number;
	/** `lib.ts` of each side. */
	base: string;
	pr: string;
	/** `lib.bench.ts`, the same on both sides (`BENCH_API` stands for the bench API's path). */
	bench: string;
}

export const BENCH_API_TOKEN = 'BENCH_API';

const KEYS = join(HEISENBENCH_DIR, 'test');

function key_lib(key: string, variant: string): string {
	return readFileSync(join(KEYS, key, variant, 'lib.ts.txt'), 'utf8');
}

function bench_file(imports: string, body: string): string {
	return `import { bench } from '${BENCH_API_TOKEN}';\nimport { ${imports} } from './lib.ts';\n\n${body}\n`;
}

// ---- spin (time-key)

const SPIN_FACTORS = [0.5, 0.8, 0.9, 0.95, 0.98, 0.99, 1.01, 1.02, 1.05, 1.1, 1.2, 1.5, 2, 4];
const SPIN_SIZES = [200, 2000, 20000];

function spin_lib(text: string, n: number): string {
	if (!text.includes('spin(20000)')) throw new Error('planted: time-key work() changed shape');
	return text.replace('spin(20000)', `spin(${n})`);
}

function spin_pairs(): PlantedPair[] {
	const base = key_lib('time-key', 'base');
	const comments = key_lib('time-key', 'comments');
	const out: PlantedPair[] = [];
	for (const n of SPIN_SIZES) {
		const add = (variant: string, planted: Planted, pr: string) => {
			const id = `spin-${variant}-n${n}`;
			out.push({
				id,
				template: 'spin',
				variant,
				planted,
				size: n,
				base: spin_lib(base, n),
				pr,
				bench: bench_file('work', `bench('${id}', () => work());`)
			});
		};
		for (const f of SPIN_FACTORS) {
			add(`x${f}`, f > 1 ? 'slower' : 'faster', spin_lib(base, Math.round(n * f)));
		}
		add('comments', 'same', spin_lib(comments, n));
		add('identical', 'same', spin_lib(base, n));
	}
	return out;
}

// ---- answer (answer-key)

const ANSWER_SIZES = [20, 200, 2000];
const ANSWER_SLOWER = ['extra-loop', 'extra-allocation', 'quadratic-helper'];
const ANSWER_SAME = ['rename', 'comments', 'reorder', 'formatting'];

function rows_bench(id: string, n: number): string {
	return bench_file(
		'rank',
		`bench('${id}', ({ rows }) => rank(rows), {\n\tsetup: () => ({\n\t\trows: Array.from({ length: ${n} }, (_, i) => ({ id: i, tags: ['a' + i, 'bb', 'c' + i] }))\n\t})\n});`
	);
}

function answer_pairs(): PlantedPair[] {
	const base = key_lib('answer-key', 'base');
	const out: PlantedPair[] = [];
	for (const n of ANSWER_SIZES) {
		const add = (variant: string, planted: Planted, b: string, p: string) => {
			const id = `answer-${variant}-n${n}`;
			out.push({
				id,
				template: 'answer',
				variant,
				planted,
				size: n,
				base: b,
				pr: p,
				bench: rows_bench(id, n)
			});
		};
		for (const v of ANSWER_SLOWER) {
			add(v, 'slower', base, key_lib('answer-key', v));
			add(`undo-${v}`, 'faster', key_lib('answer-key', v), base);
		}
		for (const v of ANSWER_SAME) add(v, 'same', base, key_lib('answer-key', v));
	}
	return out;
}

// ---- engine (engine-key)

const ENGINE_SIZES = [50, 200];
const ENGINE_SLOWER = ['shape-order', 'int-double', 'delete', 'megamorphic'];
const ENGINE_SAME = [
	'shape-order-twin',
	'int-double-twin',
	'delete-twin',
	'megamorphic-twin',
	'rename',
	'comments'
];

function engine_pairs(): PlantedPair[] {
	const base = key_lib('engine-key', 'base');
	const out: PlantedPair[] = [];
	for (const n of ENGINE_SIZES) {
		const add = (variant: string, planted: Planted, b: string, p: string) => {
			const id = `engine-${variant}-n${n}`;
			out.push({
				id,
				template: 'engine',
				variant,
				planted,
				size: n,
				base: b,
				pr: p,
				bench: bench_file(
					'run',
					`bench('${id}', ({ n }) => run(n), { setup: () => ({ n: ${n} }) });`
				)
			});
		};
		for (const v of ENGINE_SLOWER) {
			add(v, 'slower', base, key_lib('engine-key', v));
			add(`undo-${v}`, 'faster', key_lib('engine-key', v), base);
		}
		for (const v of ENGINE_SAME) add(v, 'same', base, key_lib('engine-key', v));
	}
	return out;
}

// ---- growth (growth-key)

const GROWTH_SIZES = [20, 200, 1000];

function growth_pairs(): PlantedPair[] {
	const base = key_lib('growth-key', 'base');
	const quadratic = key_lib('growth-key', 'quadratic');
	const constant = key_lib('growth-key', 'constant-factor');
	const out: PlantedPair[] = [];
	for (const n of GROWTH_SIZES) {
		const add = (variant: string, planted: Planted, b: string, p: string) => {
			const id = `growth-${variant}-n${n}`;
			out.push({
				id,
				template: 'growth',
				variant,
				planted,
				size: n,
				base: b,
				pr: p,
				bench: rows_bench(id, n)
			});
		};
		add('quadratic', 'slower', base, quadratic);
		add('undo-quadratic', 'faster', quadratic, base);
		add('constant-factor', 'slower', base, constant);
	}
	return out;
}

// ---- kind: one helper per kind of work

/** Each helper does one small piece of one kind of work for one element. */
const KIND_HELPERS: Record<string, string> = {
	arith: `function k_arith(x: number): number {\n\tlet s = 0;\n\tfor (let i = 0; i < 8; i++) s = (s + x * i) % 1013;\n\treturn s;\n}`,
	alloc: `function k_alloc(x: number): number {\n\tconst o = { a: x, b: x + 1, c: [x, x] };\n\treturn o.c.length + o.a;\n}`,
	string: `function k_string(x: number): number {\n\tlet t = '';\n\tfor (let i = 0; i < 4; i++) t += 'ab' + i;\n\treturn t.length + x;\n}`,
	array: `function k_array(x: number): number {\n\tconst a = [x, x + 1, x + 2, x + 3, x + 4, x + 5, x + 6, x + 7];\n\treturn a.map((v) => v * 2).filter((v) => v % 3 === 0).length;\n}`,
	sort: `function k_sort(x: number): number {\n\tconst a = [x % 7, x % 5, x % 3, x % 11, x % 13, x % 2, x % 17, x % 19];\n\ta.sort((p, q) => p - q);\n\treturn a[0];\n}`,
	map: `const memo = new Map<number, number>();\n\nfunction k_map(x: number): number {\n\tmemo.set(x & 255, x);\n\treturn memo.get((x * 7) & 255) ?? 0;\n}`,
	json: `function k_json(x: number): number {\n\treturn JSON.stringify({ x, y: [x, 1] }).length;\n}`,
	closure: `function k_closure(x: number): number {\n\tconst f = (y: number) => y + x;\n\treturn [1, 2, 3].reduce((s, v) => s + f(v), 0);\n}`,
	call: `function id(v: number): number {\n\treturn v;\n}\n\nfunction k_call(x: number): number {\n\treturn id(id(id(x))) + id(x);\n}`
};
const KINDS = Object.keys(KIND_HELPERS);
const KIND_SIZES = [64, 512];
const KIND_MORE = [1, 4, 16];

interface KindLib {
	/** Helper names in the order they are written. */
	order?: string[];
	/** Kinds the loop calls once per element. */
	calls?: string[];
	/** Extra calls per element: [kind, times]. */
	extra?: [string, number] | null;
	/** A kind whose helper is renamed (the same code). */
	rename?: string | null;
	comments?: boolean;
}

function kind_lib(o: KindLib = {}): string {
	const order = o.order ?? KINDS;
	const calls = o.calls ?? KINDS;
	const name = (k: string) => (k === o.rename ? `k_${k}_renamed` : `k_${k}`);
	const helper = (k: string) => {
		const text = KIND_HELPERS[k].replace(new RegExp(`\\bk_${k}\\b`, 'g'), name(k));
		return o.comments ? `/** One piece of ${k} work. */\n${text}` : text;
	};
	const lines = calls.map((k) => `\t\ts += ${name(k)}(x);${o.comments ? ` // ${k}` : ''}`);
	if (o.extra) {
		const [k, times] = o.extra;
		lines.push(`\t\tfor (let j = 0; j < ${times}; j++) s += ${name(k)}(x + j);`);
	}
	const head = o.comments ? '// Every kind of work, once per element.\n' : '';
	return `${order.map(helper).join('\n\n')}\n\n${head}export function work(xs: number[]): number {\n\tlet s = 0;\n\tfor (const x of xs) {\n${lines.join('\n')}\n\t}\n\treturn s;\n}\n`;
}

function kind_pairs(): PlantedPair[] {
	const base = kind_lib();
	const out: PlantedPair[] = [];
	for (const n of KIND_SIZES) {
		const add = (variant: string, planted: Planted, pr: string) => {
			const id = `kind-${variant}-n${n}`;
			out.push({
				id,
				template: 'kind',
				variant,
				planted,
				size: n,
				base,
				pr,
				bench: bench_file(
					'work',
					`bench('${id}', ({ xs }) => work(xs), {\n\tsetup: () => ({ xs: Array.from({ length: ${n} }, (_, i) => i) })\n});`
				)
			});
		};
		for (const k of KINDS) {
			for (const times of KIND_MORE)
				add(`${k}-more${times}`, 'slower', kind_lib({ extra: [k, times] }));
			add(`${k}-none`, 'faster', kind_lib({ calls: KINDS.filter((x) => x !== k) }));
			add(`${k}-rename`, 'same', kind_lib({ rename: k }));
		}
		add('comments', 'same', kind_lib({ comments: true }));
		add('reorder', 'same', kind_lib({ order: [...KINDS].reverse() }));
		add('identical', 'same', base);
	}
	return out;
}

/** Every planted pair, sorted by id. */
export function planted_pairs(): PlantedPair[] {
	const all = [
		...spin_pairs(),
		...answer_pairs(),
		...engine_pairs(),
		...growth_pairs(),
		...kind_pairs()
	];
	const ids = new Set<string>();
	for (const p of all) {
		if (ids.has(p.id)) throw new Error(`planted: two pairs named ${p.id}`);
		ids.add(p.id);
	}
	return all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
