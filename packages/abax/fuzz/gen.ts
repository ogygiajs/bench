import { Rng } from './rng.ts';

/*
 * Random programs over the JS (and erasable TS) the counting transform handles. Every program is
 * one ES module that exports `main(log)`; `log(label, value)` is the harness's recorder, so the
 * side effects of a run are the logged values in order, plus main's result or thrown error.
 *
 * Programs always end and always do the same thing:
 * - loops are bounded by small constants, and their counters are never assigned by other code;
 * - every function entry spends a unit of a global `fuel`, sync functions keep a `depth` guard,
 *   and async functions and generators only call lower-numbered ones: any call graph ends;
 * - strings and arrays stored in variables are capped (`cap`), so nothing doubles forever.
 *
 * And they rarely throw by accident (they throw on purpose, often): property reads on maybe-nullish
 * values go through `?.`, only known functions are called. Functions are never turned into strings
 * or put where they could be (their source text is exactly what instrumentation changes, so a
 * program printing it would differ for a reason that is not a bug).
 */

export interface Program {
	seed: number;
	lang: 'js' | 'ts';
	source: string;
	/** Recurses until the stack overflows: counts differ from the plain run by design. */
	deep: boolean;
	/** What the generator put in. */
	features: string[];
}

export interface GenOptions {
	/** Force a language (default: TS one time in four). */
	lang?: 'js' | 'ts';
	/** Top-level functions (default 3..7). */
	functions?: number;
}

/** Value types of expressions. Functions and objects with methods are never one of these. */
type Ty = 'num' | 'str' | 'bool' | 'arr' | 'obj' | 'any';

/** `fn`: a function in a variable (only ever called); `inst`: a class instance. */
interface Var {
	name: string;
	ty: Ty | 'fn' | 'inst';
	mutable: boolean;
	cls?: ClassInfo;
}

type FnKind = 'sync' | 'async' | 'gen' | 'agen';

interface FnInfo {
	name: string;
	arity: number;
	kind: FnKind;
	index: number;
}

interface ClassInfo {
	name: string;
	methods: string[];
	getters: string[];
	setters: string[];
	statics: string[];
	arity: number;
}

interface FnCtx {
	/** Can use `await`. */
	is_async: boolean;
	/** Can use `yield`. */
	is_gen: boolean;
	/** `arguments` and `new.target` belong to a function (not the module). */
	own_args: boolean;
	/** Calls go to lower-numbered async functions and generators only (when async or a generator). */
	index: number;
	can_return: boolean;
	top: boolean;
}

interface Jumps {
	/** Enclosing loops (labels, or null) and switches (`switch`). */
	targets: Array<{ kind: 'loop' | 'switch'; label: string | null }>;
	/** Labels of enclosing labeled blocks. */
	blocks: string[];
}

const KEYS = ['a', 'b', 'c', 'k'];
const TS_TYPES: Record<Ty, string> = {
	num: 'number',
	str: 'string',
	bool: 'boolean',
	arr: 'any[]',
	obj: 'Record<string, any>',
	any: 'any'
};
const DATA: Ty[] = ['num', 'str', 'bool', 'arr', 'obj'];

function top_ctx(): FnCtx {
	return {
		is_async: false,
		is_gen: false,
		own_args: false,
		index: 0,
		can_return: false,
		top: true
	};
}

function indent(lines: string[]): string[] {
	return lines.map((l) => '\t' + l);
}

export class Generator {
	rng: Rng;
	lang: 'js' | 'ts';
	features = new Set<string>();
	scopes: Var[][] = [[]];
	fns: FnInfo[] = [];
	classes: ClassInfo[] = [];
	fn: FnCtx = top_ctx();
	jumps: Jumps = { targets: [], blocks: [] };
	n = 0;
	n_log = 0;
	/** Statement nesting left. */
	nest = 3;
	deep = false;

	constructor(seed: number, o: GenOptions = {}) {
		this.rng = new Rng(seed);
		this.lang = o.lang ?? (this.rng.chance(0.25) ? 'ts' : 'js');
	}

	f(name: string): void {
		this.features.add(name);
	}

	get ts(): boolean {
		return this.lang === 'ts';
	}

	t(ann: string): string {
		return this.ts ? ann : '';
	}

	// ------------------------------------------------------------------ scope

	vars(ty?: Var['ty'], mutable = false): Var[] {
		const out: Var[] = [];
		for (const s of this.scopes)
			for (const v of s) if ((!ty || v.ty === ty) && (!mutable || v.mutable)) out.push(v);
		return out;
	}

	add(v: Var): Var {
		this.scopes[this.scopes.length - 1].push(v);
		return v;
	}

	fresh(prefix = 'v'): string {
		return `${prefix}${this.n++}`;
	}

	declare(ty: Var['ty'], mutable: boolean, prefix = 'v'): Var {
		return this.add({ name: this.fresh(prefix), ty, mutable });
	}

	scoped<T>(fn: () => T): T {
		this.scopes.push([]);
		try {
			return fn();
		} finally {
			this.scopes.pop();
		}
	}

	nested<T>(fn: () => T): T {
		this.nest--;
		try {
			return this.scoped(fn);
		} finally {
			this.nest++;
		}
	}

	/** Generate a function body in its own context (jump targets do not cross functions). */
	in_function<T>(ctx: FnCtx, fn: () => T): T {
		const saved = { fn: this.fn, jumps: this.jumps };
		this.fn = ctx;
		this.jumps = { targets: [], blocks: [] };
		try {
			return this.scoped(fn);
		} finally {
			this.fn = saved.fn;
			this.jumps = saved.jumps;
		}
	}

	label(): string {
		return `'${this.n_log++}'`;
	}

	/** Strings and arrays kept in variables stay small. */
	capped(ty: Var['ty'], expr: string): string {
		return ty === 'str' || ty === 'arr' ? `cap(${expr})` : expr;
	}

	// ------------------------------------------------------------------ expressions

	lit(ty: Ty): string {
		const r = this.rng;
		switch (ty) {
			case 'num':
				return r.weighted([
					[8, () => String(r.int(10))],
					[2, () => String(r.int(1000) - 500)],
					[1, () => `${r.int(100)}.${r.int(9) + 1}`],
					[1, () => '-0'],
					[1, () => `0x${r.int(255).toString(16)}`]
				] as const)();
			case 'str':
				return r.pick(["''", "'x'", "'ab'", "'a,b,c'", "'Hello'", "'  pad '", "'é'", "'a-b'"]);
			case 'bool':
				return r.pick(['true', 'false']);
			case 'arr':
				return `[${Array.from({ length: r.int(4) }, () => this.lit(r.pick(['num', 'str'] as const))).join(', ')}]`;
			case 'obj':
				return `{ ${KEYS.slice(0, r.int(4))
					.map((k) => `${k}: ${this.lit(r.pick(['num', 'str'] as const))}`)
					.join(', ')} }`;
			case 'any':
				return r.pick(['null', 'undefined', '0', "''", '1', "'s'", '[]', '{}', 'NaN']);
		}
	}

	/** An expression of type `ty`; `d` is the depth left. */
	e(ty: Ty, d: number): string {
		const r = this.rng;
		if (d <= 0 || r.chance(0.2)) {
			const vs = ty === 'any' ? [...this.vars('any'), ...this.vars('inst')] : this.vars(ty);
			if (vs.length > 0 && r.chance(0.6)) return r.pick(vs).name;
			return this.lit(ty);
		}
		const out = this.e_kind(ty, d - 1);
		if (this.ts && r.chance(0.08)) {
			this.f('ts-expression-wrapper');
			return r.pick([`(${out} as any)`, `(${out})!`, `(${out} satisfies unknown)`]);
		}
		return out;
	}

	bin(a: string, op: string, b: string): string {
		return `((${a}) ${op} (${b}))`;
	}

	e_kind(ty: Ty, d: number): string {
		const r = this.rng;
		const common: Array<readonly [number, () => string]> = [
			[3, () => this.lit(ty)],
			[2, () => this.logical(ty, d)],
			[2, () => this.ternary(ty, d)],
			[1, () => this.comma(ty, d)],
			[2, () => this.call(ty, d)]
		];
		const own: Record<Ty, Array<readonly [number, () => string]>> = {
			num: [
				[
					4,
					() =>
						this.bin(
							this.e('num', d),
							r.pick(['+', '-', '*', '%', '|', '&', '^', '<<', '>>', '>>>', '**']),
							this.e('num', d)
						)
				],
				[2, () => `(${this.e(r.pick(['arr', 'str'] as const), d)}).length`],
				[2, () => this.update_expr()],
				[
					1,
					() =>
						`(${this.e('arr', d)}).reduce((s, x) => s + (typeof x === 'number' ? x : 1), ${this.lit('num')})`
				],
				[1, () => `(${this.e('arr', d)}).indexOf(${this.e('any', 0)})`],
				[1, () => `(${this.e('str', d)}).indexOf(${this.e('str', 0)})`],
				[
					1,
					() =>
						`Math.max(${this.lit('num')}, ...(${this.e('arr', d)}).filter((x) => typeof x === 'number'))`
				],
				[1, () => `((${this.e('obj', d)})?.${r.pick(KEYS)} ?? ${this.lit('num')})`],
				[1, () => `(-(${this.e('num', d)}))`],
				[1, () => `(typeof ${this.e('any', d)} === 'string' ? 1 : 2)`],
				[1, () => `Object.keys(${this.e('obj', d)}).length`],
				[1, () => `((${this.e('str', d)}).charCodeAt(0) | 0)`],
				[2, () => this.use_instance(d)]
			],
			str: [
				[3, () => this.template(d)],
				[2, () => this.bin(this.e('str', d), '+', this.e(r.pick(['num', 'str'] as const), d))],
				[2, () => `(${this.e('str', d)}).slice(${this.lit('num')}, ${this.lit('num')})`],
				[2, () => `(${this.e('arr', d)}).join(${this.e('str', 0)})`],
				[1, () => `String(${this.e(r.pick(['num', 'bool'] as const), d)})`],
				[1, () => `JSON.stringify(${this.e(r.pick(['obj', 'arr'] as const), d)})`],
				[
					1,
					() =>
						`(${this.e('str', d)}).replace(${r.pick(['/a/g', '/[bc]/', "'a'", '/(x)|y/g'])}, ${this.e('str', 0)})`
				],
				[1, () => `(${this.e('str', d)}).toUpperCase()`],
				[1, () => `(${this.e('str', d)}).padStart(${r.int(8)}, '.')`],
				[1, () => `(${this.e('str', d)}).repeat(${r.int(3)})`],
				[1, () => this.tagged(d)],
				[1, () => `(${this.e('str', d)}).trim()`]
			],
			bool: [
				[
					4,
					() =>
						this.bin(
							this.e('num', d),
							r.pick(['<', '<=', '>', '>=', '===', '!==', '==', '!=']),
							this.e('num', d)
						)
				],
				[2, () => `!(${this.e('any', d)})`],
				[1, () => `('${r.pick(KEYS)}' in ${this.e('obj', d)})`],
				[1, () => `Array.isArray(${this.e('any', d)})`],
				[1, () => `(${this.e('arr', d)}).includes(${this.e('any', 0)})`],
				[1, () => `(${this.e('str', d)}).startsWith(${this.e('str', 0)})`],
				[1, () => `(${this.e('arr', d)}).some((x) => !!x)`],
				[1, () => this.instance_of(d)]
			],
			arr: [
				[3, () => this.array_lit(d)],
				[2, () => `(${this.e('arr', d)}).map((x, i) => ${this.callback('any', d)})`],
				[2, () => `(${this.e('arr', d)}).filter((x) => ${this.callback('bool', d)})`],
				[1, () => `(${this.e('arr', d)}).slice(${this.lit('num')})`],
				[1, () => `(${this.e('str', d)}).split(${r.pick(["''", "','", "'a'", '/b/'])})`],
				[1, () => `Object.keys(${this.e('obj', d)})`],
				[
					1,
					() =>
						`[...(${this.e('arr', d)})].sort((p, q) => (String(p) < String(q) ? -1 : String(p) > String(q) ? 1 : 0))`
				],
				[1, () => `(${this.e('arr', d)}).concat(${this.e('arr', d)})`],
				[1, () => `Array.from({ length: ${r.int(5)} }, (_, i) => i * ${this.lit('num')})`],
				[1, () => `[${this.e('arr', d)}, ${this.e('arr', d)}].flat()`],
				[1, () => this.spread_generator(d)],
				[1, () => `Object.entries(${this.e('obj', d)}).map(([k, v]) => k + v)`]
			],
			obj: [
				[3, () => this.object_lit(d)],
				[1, () => `{ ...(${this.e('obj', d)}), ${r.pick(KEYS)}: ${this.e('num', d)} }`],
				[1, () => `Object.assign({}, ${this.e('obj', d)})`],
				[1, () => `Object.fromEntries([[${this.e('str', 0)}, ${this.e('num', 0)}]])`],
				[1, () => `structuredClone({ ${r.pick(KEYS)}: [${this.lit('num')}] })`]
			],
			any: [
				[2, () => this.e(r.pick(DATA), d)],
				[2, () => this.optional_chain(d)],
				[1, () => this.assign_expr(d)],
				[1, () => (this.fn.own_args ? (this.f('arguments'), `arguments[${r.int(3)}]`) : 'null')],
				[
					1,
					() => (this.fn.own_args ? (this.f('new.target'), '(new.target === undefined)') : 'void 0')
				],
				[1, () => `(${this.e('arr', d)})[${this.e('num', 0)}]`],
				[1, () => `(${this.e('arr', d)}).at(-1)`]
			]
		};
		return r.weighted([...own[ty], ...common])();
	}

	logical(ty: Ty, d: number): string {
		this.f('logical');
		// the left side has the same type, so the result keeps it (`[] || x` is the array)
		return this.bin(this.e(ty, d), this.rng.pick(['&&', '||', '??']), this.e(ty, d));
	}

	ternary(ty: Ty, d: number): string {
		this.f('ternary');
		return `(${this.e('bool', d)} ? ${this.e(ty, d)} : ${this.e(ty, d)})`;
	}

	comma(ty: Ty, d: number): string {
		this.f('comma');
		return `(${this.log(d)}, ${this.e(ty, d)})`;
	}

	log(d: number): string {
		return `log(${this.label()}, ${this.e(this.rng.pick([...DATA, 'any'] as const), d)})`;
	}

	update_expr(): string {
		const vs = this.vars('num', true);
		if (vs.length === 0) return this.lit('num');
		const v = this.rng.pick(vs).name;
		this.f('update-expression');
		return this.rng.pick([
			`${v}++`,
			`--${v}`,
			`(${v} += 2)`,
			`(${v} ||= 3)`,
			`(${v} ??= 4)`,
			`(${v} &&= 5)`
		]);
	}

	assign_expr(d: number): string {
		const vs = this.vars(undefined, true);
		if (vs.length === 0) return this.lit('any');
		const v = this.rng.pick(vs);
		this.f('assignment-expression');
		return `(${v.name} = ${this.capped(v.ty, this.e(v.ty as Ty, d))})`;
	}

	template(d: number): string {
		this.f('template');
		let s = '`';
		for (let i = 0, n = this.rng.int(3) + 1; i < n; i++)
			s += `t${i}\${${this.e(this.rng.pick(['num', 'str', 'bool'] as const), d)}}`;
		return s + 'end`';
	}

	tagged(d: number): string {
		this.f('tagged-template');
		return `tag\`p\${${this.e('num', d)}}q\${${this.e('str', d)}}\``;
	}

	array_lit(d: number): string {
		const r = this.rng;
		const items: string[] = [];
		for (let i = 0, n = r.int(5); i < n; i++) {
			if (r.chance(0.2)) {
				this.f('spread-array');
				items.push(`...${this.e('arr', d)}`);
			} else if (r.chance(0.05)) {
				this.f('array-hole');
				items.push('');
			} else items.push(this.e(r.pick(DATA), d));
		}
		if (items.length > 0 && items[items.length - 1] === '') items.push('0');
		return `[${items.join(', ')}]`;
	}

	object_lit(d: number): string {
		const r = this.rng;
		const props: string[] = [];
		for (const k of KEYS) {
			if (!r.chance(0.6)) continue;
			if (r.chance(0.15)) {
				this.f('spread-object');
				props.push(`...${this.e('obj', d)}`);
			}
			if (r.chance(0.1)) {
				this.f('computed-key');
				props.push(`[${this.e('str', 0)} + '${k}']: ${this.e('num', d)}`);
			} else props.push(`${k}: ${this.e(r.pick(DATA), d)}`);
		}
		return `{ ${props.join(', ')} }`;
	}

	optional_chain(d: number): string {
		this.f('optional-chain');
		const r = this.rng;
		const base = r.pick([this.e('obj', d), this.e('any', d), 'null', this.e('arr', d)]);
		return r.pick([
			`(${base})?.${r.pick(KEYS)}`,
			`(${base})?.${r.pick(KEYS)}?.length`,
			`(${base})?.[${this.lit('num')}]`,
			`(${base})?.toString?.()`,
			`(${base})?.${r.pick(KEYS)}?.at?.(0)`,
			`(${this.e('any', d)})?.valueOf()`
		]);
	}

	callback(ty: Ty, d: number): string {
		return this.scoped(() => {
			this.add({ name: 'x', ty: 'any', mutable: false });
			return this.e(ty, Math.min(d, 1));
		});
	}

	callable(f: FnInfo): boolean {
		if (this.fn.top) return true;
		if (this.fn.is_async || this.fn.is_gen) return f.index < this.fn.index;
		return true;
	}

	spread_generator(d: number): string {
		const gens = this.fns.filter((f) => f.kind === 'gen' && this.callable(f));
		if (gens.length === 0) return this.array_lit(d);
		this.f('generator-spread');
		const g = this.rng.pick(gens);
		return `[...${g.name}(${this.args(g.arity, d)})]`;
	}

	args(n: number, d: number): string {
		const out: string[] = [];
		for (let i = 0; i < n; i++) out.push(this.e(this.rng.pick([...DATA, 'any'] as const), d));
		if (this.rng.chance(0.1)) {
			this.f('spread-arguments');
			out.push(`...${this.e('arr', d)}`);
		}
		return out.join(', ');
	}

	call(ty: Ty, d: number): string {
		const r = this.rng;
		const sync = this.fns.filter((f) => f.kind === 'sync' && this.callable(f));
		const fvars = this.vars('fn');
		if (fvars.length > 0 && r.chance(0.35)) {
			this.f('closure-call');
			return `${r.pick(fvars).name}(${this.e('any', d)})`;
		}
		if (sync.length === 0) return this.lit(ty);
		const f = r.pick(sync);
		this.f('call');
		if (r.chance(0.05)) {
			this.f('call-method');
			return `${f.name}.call(null, ${this.args(f.arity, d)})`;
		}
		return `${f.name}(${this.args(f.arity, d)})`;
	}

	instance_of(d: number): string {
		if (this.classes.length === 0) return this.lit('bool');
		this.f('instanceof');
		return `(${this.e('any', d)} instanceof ${this.rng.pick(this.classes).name})`;
	}

	use_instance(d: number): string {
		const insts = this.vars('inst');
		if (insts.length === 0) return this.lit('num');
		const r = this.rng;
		const v = r.pick(insts);
		const cls = v.cls!;
		this.f('instance-use');
		const choices: Array<readonly [number, () => string]> = [[1, () => this.lit('num')]];
		if (cls.methods.length > 0)
			choices.push([3, () => `${v.name}.${r.pick(cls.methods)}(${this.e('num', d)})`]);
		if (cls.getters.length > 0)
			choices.push([2, () => (this.f('getter-read'), `${v.name}.${r.pick(cls.getters)}`)]);
		if (cls.setters.length > 0)
			choices.push([
				1,
				() => (this.f('setter-write'), `(${v.name}.${r.pick(cls.setters)} = ${this.e('num', d)})`)
			]);
		if (cls.statics.length > 0)
			choices.push([1, () => `${cls.name}.${r.pick(cls.statics)}(${this.e('num', d)})`]);
		return r.weighted(choices)();
	}

	// ------------------------------------------------------------------ statements

	block(n: number): string[] {
		const out: string[] = [];
		for (let i = 0; i < n; i++) out.push(...this.stmt());
		return out;
	}

	body(min = 1, max = 4): string[] {
		return this.nested(() => this.block(min + this.rng.int(max - min + 1)));
	}

	stmt(): string[] {
		const r = this.rng;
		const choices: Array<readonly [number, () => string[]]> = [
			[5, () => this.decl()],
			[3, () => [`${this.log(2)};`]],
			[2, () => this.assign_stmt()],
			[1, () => this.destructure()],
			[1, () => this.rich_object()],
			[1, () => this.class_expression()],
			[1, () => [`if (${this.e('bool', 1)}) throw new Error('E' + ${this.e('num', 1)});`]]
		];
		if (this.nest > 0) {
			choices.push(
				[3, () => this.if_stmt()],
				[2, () => this.for_stmt()],
				[1, () => this.while_stmt()],
				[1, () => this.do_while()],
				[1, () => this.for_of()],
				[1, () => this.for_in()],
				[2, () => this.switch_stmt()],
				[2, () => this.try_stmt()],
				[1, () => this.labeled_block()],
				[1, () => this.inner_function()],
				[1, () => this.closure()],
				[1, () => this.block_stmt()]
			);
			if (this.fn.is_async)
				choices.push(
					[2, () => this.await_stmt()],
					[1, () => this.for_await()],
					[1, () => this.using_block(true)]
				);
			else if (!this.fn.top) choices.push([1, () => this.using_block(false)]);
			if (this.fn.is_gen) choices.push([3, () => this.yield_stmt()]);
			if (this.classes.length > 0) choices.push([2, () => this.new_instance()]);
		}
		if (this.jumps.targets.length > 0)
			choices.push([2, () => [`if (${this.e('bool', 1)}) ${this.jump()}`]]);
		if (this.jumps.blocks.length > 0)
			choices.push([
				1,
				() => (
					this.f('break-block-label'),
					[`if (${this.e('bool', 1)}) break ${r.pick(this.jumps.blocks)};`]
				)
			]);
		if (this.fn.can_return)
			choices.push([
				1,
				() => (this.f('early-return'), [`if (${this.e('bool', 1)}) return ${this.e('any', 1)};`])
			]);
		if (r.chance(0.02)) {
			this.f('empty-statement');
			return [';'];
		}
		return r.weighted(choices)();
	}

	/** `break`, `continue`, maybe labeled, valid where it is. */
	jump(): string {
		const r = this.rng;
		const loops = this.jumps.targets.filter((t) => t.kind === 'loop');
		const labels = loops.filter((t) => t.label !== null).map((t) => t.label!);
		const can_continue = loops.length > 0;
		const kind = can_continue && r.chance(0.5) ? 'continue' : 'break';
		const label = labels.length > 0 && r.chance(0.4) ? r.pick(labels) : null;
		this.f(`${kind}${label ? '-label' : ''}`);
		return `${kind}${label ? ' ' + label : ''};`;
	}

	decl(): string[] {
		const r = this.rng;
		const ty = r.pick(['num', 'num', 'str', 'bool', 'arr', 'obj', 'any'] as const);
		const kind = r.weighted([
			[4, 'let'],
			[4, 'const'],
			[1, 'var']
		] as const);
		const init = this.capped(ty, this.e(ty, 3));
		const v = this.declare(ty, kind !== 'const');
		this.f(`declare-${kind}`);
		return [`${kind} ${v.name}${this.t(': ' + TS_TYPES[ty])} = ${init};`];
	}

	assign_stmt(): string[] {
		const r = this.rng;
		const vs = this.vars(undefined, true);
		if (vs.length === 0) return this.decl();
		const v = r.pick(vs);
		if (v.ty === 'obj' && r.chance(0.4)) {
			this.f('member-write');
			return [`${v.name}.${r.pick(KEYS)} = ${this.e(r.pick(DATA), 2)};`];
		}
		if (v.ty === 'arr' && r.chance(0.4)) {
			this.f('index-write');
			return [`${v.name}[(${this.e('num', 1)}) & 3] = ${this.e('num', 2)};`];
		}
		if (v.ty === 'num' && r.chance(0.5)) {
			const op = r.pick(['+=', '-=', '*=', '%=', '|=', '&&=', '||=', '??=']);
			this.f(`assign ${op}`);
			return [`${v.name} ${op} ${this.e('num', 2)};`];
		}
		if (v.ty === 'str' && r.chance(0.5)) {
			this.f('string-append');
			return [`${v.name} = cap(${v.name} + ${this.e('str', 2)});`];
		}
		return [`${v.name} = ${this.capped(v.ty, this.e(v.ty as Ty, 2))};`];
	}

	destructure(): string[] {
		const r = this.rng;
		this.f('destructuring');
		if (r.chance(0.5)) {
			const src = this.e('obj', 2);
			const parts: string[] = [];
			for (const k of KEYS) {
				if (!r.chance(0.5)) continue;
				const v = this.declare('any', true);
				if (r.chance(0.4)) {
					this.f('destructuring-default');
					parts.push(`${k}: ${v.name} = ${this.e('num', 1)}`);
				} else parts.push(`${k}: ${v.name}`);
			}
			if (r.chance(0.3)) {
				this.f('object-rest');
				parts.push(`...${this.declare('obj', true).name}`);
			}
			return [`let { ${parts.join(', ')} } = ${src};`];
		}
		const src = this.e('arr', 2);
		const parts: string[] = [];
		for (let i = 0, n = r.int(3) + 1; i < n; i++) {
			if (r.chance(0.15)) {
				parts.push('');
				continue;
			}
			const v = this.declare('any', true);
			if (r.chance(0.3)) {
				this.f('destructuring-default');
				parts.push(`${v.name} = ${this.e('str', 1)}`);
			} else parts.push(v.name);
		}
		if (r.chance(0.3)) {
			this.f('array-rest');
			parts.push(`...${this.declare('arr', true).name}`);
		}
		return [`let [${parts.join(', ')}] = ${src};`];
	}

	/** A class expression (named after its variable, or named itself), used right away. */
	class_expression(): string[] {
		this.f('class-expression');
		const name = this.fresh('K');
		const own = this.rng.chance(0.3) ? ` ${name}Own` : '';
		return [
			`const ${name} = class${own} {`,
			`\tk = ${this.lit('num')};`,
			`\tm(q${this.t(': any')}) { return (q | 0) + this.k; }`,
			'};',
			`log(${this.label()}, [${name}.name, new ${name}().m(${this.e('num', 1)})]);`
		];
	}

	/** An object with a getter, a setter and a method, used right away. */
	rich_object(): string[] {
		this.f('object-accessors');
		const name = this.fresh('r');
		return [
			`const ${name} = {`,
			`\tv: ${this.lit('num')},`,
			`\tget a() { return this.v; },`,
			`\tset a(q${this.t(': any')}) { log(${this.label()}, q); this.v = q; },`,
			`\tm(q${this.t(': any')}) { return (q | 0) + this.v; }`,
			'};',
			`log(${this.label()}, ${name}.a);`,
			`${name}.a = ${this.e('num', 1)};`,
			`log(${this.label()}, ${name}.m(${this.e('num', 1)}));`
		];
	}

	if_stmt(): string[] {
		const r = this.rng;
		this.f('if');
		let test = this.e('bool', 2);
		const vs = this.vars('any', true);
		if (vs.length > 0 && r.chance(0.15)) {
			this.f('assignment-in-condition');
			test = `(${r.pick(vs).name} = ${this.e('any', 1)})`;
		}
		const out = [`if (${test}) {`, ...indent(this.body()), '}'];
		if (r.chance(0.3)) {
			this.f('else-if');
			out[out.length - 1] = `} else if (${this.e('bool', 1)}) {`;
			out.push(...indent(this.body()), '}');
		}
		if (r.chance(0.5)) {
			this.f('else');
			out[out.length - 1] = '} else {';
			out.push(...indent(this.body()), '}');
		}
		if (r.chance(0.15)) {
			this.f('if-without-braces');
			const choices = [`${this.log(1)};`];
			if (this.jumps.targets.length > 0) choices.push(this.jump());
			if (this.fn.can_return) choices.push(`return ${this.e('any', 1)};`);
			return [`if (${this.e('bool', 1)}) ${r.pick(choices)}`, ...out];
		}
		return out;
	}

	loop_body(label: string | null, kind: 'loop' | 'switch' = 'loop', fn?: () => string[]): string[] {
		this.jumps.targets.push({ kind, label });
		try {
			return fn ? fn() : this.body();
		} finally {
			this.jumps.targets.pop();
		}
	}

	maybe_label(): string | null {
		if (!this.rng.chance(0.25)) return null;
		this.f('labeled-loop');
		return this.fresh('L');
	}

	lab(label: string | null): string {
		return label ? `${label}: ` : '';
	}

	for_stmt(): string[] {
		const r = this.rng;
		const label = this.maybe_label();
		this.f('for');
		return this.scoped(() => {
			const i = this.declare('num', false, 'i');
			let head: string;
			if (r.chance(0.2)) {
				this.f('for-two-variables');
				head = `for (let ${i.name} = 0, j${i.name} = ${r.int(5)}; ${i.name} < j${i.name}; ${i.name}++, j${i.name}--)`;
			} else if (r.chance(0.1)) {
				this.f('for-no-test');
				head = `for (let ${i.name} = 0; ; ${i.name}++)`;
				const body = this.loop_body(label, 'loop', () => [
					`if (${i.name} > ${r.int(4)}) break;`,
					...this.body()
				]);
				return [`${this.lab(label)}${head} {`, ...indent(body), '}'];
			} else head = `for (let ${i.name} = 0; ${i.name} < ${r.int(5)}; ${i.name}++)`;
			const body = this.loop_body(label);
			if (
				body.length === 1 &&
				(body[0].startsWith('log(') || body[0].startsWith('if (')) &&
				r.chance(0.5)
			) {
				this.f('loop-without-braces');
				return [`${this.lab(label)}${head} ${body[0]}`];
			}
			return [`${this.lab(label)}${head} {`, ...indent(body), '}'];
		});
	}

	while_stmt(): string[] {
		const label = this.maybe_label();
		this.f('while');
		const w = this.declare('num', false, 'w');
		const body = this.loop_body(label);
		return [
			`let ${w.name} = 0;`,
			`${this.lab(label)}while (${w.name}++ < ${this.rng.int(4)}) {`,
			...indent(body),
			'}'
		];
	}

	do_while(): string[] {
		const label = this.maybe_label();
		this.f('do-while');
		const w = this.declare('num', false, 'w');
		const body = this.loop_body(label);
		return [
			`let ${w.name} = 0;`,
			`${this.lab(label)}do {`,
			...indent(body),
			`} while (++${w.name} < ${this.rng.int(4)});`
		];
	}

	for_of(): string[] {
		const r = this.rng;
		const label = this.maybe_label();
		this.f('for-of');
		const gens = this.fns.filter((f) => f.kind === 'gen' && this.callable(f));
		if (gens.length > 0 && r.chance(0.3)) {
			const g = r.pick(gens);
			this.f('for-of-generator');
			const src = `${g.name}(${this.args(g.arity, 1)})`;
			return this.scoped(() => {
				const x = this.declare('any', false);
				const body = this.loop_body(label);
				return [`${this.lab(label)}for (const ${x.name} of ${src}) {`, ...indent(body), '}'];
			});
		}
		const src = this.e('arr', 2);
		return this.scoped(() => {
			if (r.chance(0.2)) {
				this.f('for-of-destructuring');
				const x = this.declare('any', false);
				const y = this.declare('any', false);
				const body = this.loop_body(label);
				return [
					`${this.lab(label)}for (const [${x.name}, ${y.name} = 1] of (${src}).map((q, i) => [i, q])) {`,
					...indent(body),
					'}'
				];
			}
			if (r.chance(0.15)) {
				// an existing variable as the target
				const vs = this.vars('any', true);
				if (vs.length > 0) {
					this.f('for-of-assign-target');
					const v = r.pick(vs);
					const body = this.loop_body(label);
					return [`${this.lab(label)}for (${v.name} of ${src}) {`, ...indent(body), '}'];
				}
			}
			const x = this.declare('any', false);
			const body = this.loop_body(label);
			return [`${this.lab(label)}for (const ${x.name} of ${src}) {`, ...indent(body), '}'];
		});
	}

	for_in(): string[] {
		const label = this.maybe_label();
		this.f('for-in');
		const src = this.e('obj', 2);
		return this.scoped(() => {
			const k = this.declare('str', false);
			const body = this.loop_body(label);
			return [`${this.lab(label)}for (const ${k.name} in ${src}) {`, ...indent(body), '}'];
		});
	}

	switch_stmt(): string[] {
		const r = this.rng;
		this.f('switch');
		const out = [`switch ((${this.e('num', 2)}) % 4) {`];
		const n = r.int(4) + 1;
		const default_at = r.chance(0.5) ? r.int(n) : -1;
		this.loop_body(null, 'switch', () => {
			for (let i = 0; i < n; i++) {
				const head =
					i === default_at ? 'default:' : `case ${r.chance(0.2) ? this.e('num', 1) : String(i)}:`;
				if (i === default_at) this.f('switch-default');
				const body = this.nested(() => this.block(r.int(3)));
				if (r.chance(0.6)) body.push('break;');
				else this.f('switch-fallthrough');
				out.push(`\t${head}`, ...indent(indent(body)));
			}
			return [];
		});
		out.push('}');
		return out;
	}

	try_stmt(): string[] {
		const r = this.rng;
		this.f('try');
		const out = ['try {', ...indent(this.body()), '}'];
		const has_catch = r.chance(0.75);
		if (has_catch) {
			if (r.chance(0.2)) {
				this.f('catch-without-binding');
				out[out.length - 1] = '} catch {';
				out.push(...indent(this.body()), '}');
			} else {
				const name = this.fresh('e');
				const body = this.nested(() => {
					this.add({ name, ty: 'any', mutable: true });
					return [
						`log(${this.label()}, ${name} instanceof Error ? ${name}.message : ${name});`,
						...this.block(r.int(3))
					];
				});
				out[out.length - 1] = `} catch (${name}) {`;
				out.push(...indent(body), '}');
			}
		}
		if (!has_catch || r.chance(0.4)) {
			this.f('finally');
			out[out.length - 1] = '} finally {';
			out.push(...indent(this.body(1, 3)), '}');
		}
		return out;
	}

	labeled_block(): string[] {
		const l = this.fresh('B');
		this.f('labeled-block');
		this.jumps.blocks.push(l);
		try {
			return [`${l}: {`, ...indent(this.body(1, 4)), '}'];
		} finally {
			this.jumps.blocks.pop();
		}
	}

	block_stmt(): string[] {
		this.f('block');
		return ['{', ...indent(this.body()), '}'];
	}

	await_stmt(): string[] {
		const r = this.rng;
		this.f('await');
		const asyncs = this.fns.filter((f) => f.kind === 'async' && this.callable(f));
		const v = this.declare('any', true);
		if (asyncs.length > 0 && r.chance(0.6)) {
			const a = r.pick(asyncs);
			if (r.chance(0.3)) {
				this.f('promise-all');
				const b = r.pick(asyncs);
				return [
					`let ${v.name} = await Promise.all([${a.name}(${this.args(a.arity, 1)}), ${b.name}(${this.args(b.arity, 1)})]);`
				];
			}
			if (r.chance(0.2)) {
				this.f('then');
				return [
					`let ${v.name} = await ${a.name}(${this.args(a.arity, 1)}).then((q) => (log(${this.label()}, q), q));`
				];
			}
			return [`let ${v.name} = await ${a.name}(${this.args(a.arity, 1)});`];
		}
		if (r.chance(0.2)) {
			this.f('await-rejection');
			return [`let ${v.name} = await Promise.reject(new Error('R')).catch((q) => q.message);`];
		}
		return [`let ${v.name} = await ${this.e('any', 1)};`];
	}

	for_await(): string[] {
		const r = this.rng;
		this.f('for-await');
		const agens = this.fns.filter((f) => f.kind === 'agen' && this.callable(f));
		let src = `[${this.e('num', 1)}, Promise.resolve(${this.e('str', 1)})]`;
		if (agens.length > 0 && r.chance(0.6)) {
			const g = r.pick(agens);
			this.f('for-await-async-generator');
			src = `${g.name}(${this.args(g.arity, 1)})`;
		}
		const label = this.maybe_label();
		return this.scoped(() => {
			const x = this.declare('any', false);
			const body = this.loop_body(label);
			return [`${this.lab(label)}for await (const ${x.name} of ${src}) {`, ...indent(body), '}'];
		});
	}

	using_block(awaited: boolean): string[] {
		const r = this.rng;
		this.f(awaited ? 'await-using' : 'using');
		return this.nested(() => {
			const lines: string[] = [];
			for (let i = 0, n = r.int(2) + 1; i < n; i++) {
				const v = this.declare('any', false, 'u');
				if (awaited && r.chance(0.6)) {
					lines.push(
						`await using ${v.name} = ${r.chance(0.2) ? 'null' : `res_async('${v.name}')`};`
					);
				} else lines.push(`using ${v.name} = res_sync('${v.name}');`);
				lines.push(...this.block(r.int(2)));
			}
			if (awaited && r.chance(0.3)) {
				this.f('for-await-using');
				const u = this.fresh('u');
				lines.push(
					`for (await using ${u} of [res_async('loop')]) {`,
					`\tlog(${this.label()}, 'in loop');`,
					'}'
				);
			}
			return ['{', ...indent(lines), '}'];
		});
	}

	yield_stmt(): string[] {
		const r = this.rng;
		this.f('yield');
		if (r.chance(0.2)) {
			this.f('yield-delegate');
			return [`yield* ${this.e('arr', 1)};`];
		}
		if (r.chance(0.3)) {
			this.f('yield-value-received');
			return [`let ${this.declare('any', true).name} = yield ${this.e('num', 1)};`];
		}
		if (r.chance(0.1)) return ['yield;'];
		return [`yield ${this.e('any', 1)};`];
	}

	new_instance(): string[] {
		const c = this.rng.pick(this.classes);
		this.f('new');
		const v = this.add({ name: this.fresh('inst'), ty: 'inst', mutable: false, cls: c });
		return [`const ${v.name} = new ${c.name}(${this.args(c.arity, 1)});`];
	}

	/** A nested function declaration: hoisted, a closure over the enclosing scope. */
	inner_function(): string[] {
		this.f('inner-function');
		const name = this.fresh('fn');
		const ctx: FnCtx = {
			...this.fn,
			is_async: false,
			is_gen: false,
			own_args: true,
			can_return: true,
			top: false
		};
		const body = this.in_function(ctx, () => {
			this.add({ name: 'p', ty: 'any', mutable: true });
			return this.nested(() => [...this.block(this.rng.int(3)), `return ${this.e('any', 2)};`]);
		});
		this.add({ name, ty: 'fn', mutable: false });
		return [`function ${name}(p${this.t(': any')}) {`, ...indent(body), '}'];
	}

	/** An arrow, a function expression or a bound function, in a variable. */
	closure(): string[] {
		const r = this.rng;
		const name = this.fresh('fn');
		const kind = r.weighted([
			[3, 'arrow-expression'],
			[3, 'arrow'],
			[2, 'function-expression'],
			[1, 'bind']
		] as const);
		this.f(kind);
		let text: string;
		if (kind === 'bind') {
			const sync = this.fns.filter((f) => f.kind === 'sync');
			if (sync.length === 0) return this.decl();
			text = `${r.pick(sync).name}.bind(null, ${this.e('num', 1)})`;
		} else {
			const arrow = kind !== 'function-expression';
			const ctx: FnCtx = {
				...this.fn,
				is_async: false,
				is_gen: false,
				own_args: arrow ? this.fn.own_args : true,
				can_return: true,
				top: false
			};
			const def = r.chance(0.3);
			if (def) this.f('default-parameter');
			const param = `p${this.t('?: any')}${def && !this.ts ? ` = ${this.lit('num')}` : ''}`;
			if (kind === 'arrow-expression') {
				text = this.in_function(ctx, () => {
					this.add({ name: 'p', ty: 'any', mutable: false });
					return `(${param}) => (${this.e('any', 2)})`;
				});
			} else {
				const body = this.in_function(ctx, () => {
					this.add({ name: 'p', ty: 'any', mutable: true });
					return this.nested(() => [...this.block(r.int(3)), `return ${this.e('any', 2)};`]);
				});
				text = arrow
					? `(${param}) => {\n${indent(body).join('\n')}\n}`
					: `function (${param}) {\n${indent(body).join('\n')}\n}`;
			}
		}
		this.add({ name, ty: 'fn', mutable: false });
		return [`const ${name} = ${text};`];
	}

	// ------------------------------------------------------------------ top level

	function_decl(f: FnInfo): string[] {
		const r = this.rng;
		const is_async = f.kind === 'async' || f.kind === 'agen';
		const is_gen = f.kind === 'gen' || f.kind === 'agen';
		this.f(`function-${f.kind}`);
		const params: string[] = [];
		const ctx: FnCtx = {
			is_async,
			is_gen,
			own_args: true,
			index: f.index,
			can_return: true,
			top: false
		};
		const body = this.in_function(ctx, () => {
			for (let i = 0; i < f.arity; i++) {
				let p = `a${i}${this.t(': any')}`;
				if (i > 0 && r.chance(0.25)) {
					this.f('default-parameter');
					p += ` = ${this.e('num', 1)}`;
				}
				params.push(p);
				this.add({ name: `a${i}`, ty: 'any', mutable: true });
			}
			if (r.chance(0.15)) {
				this.f('rest-parameter');
				params.push(`...rest${this.t(': any[]')}`);
				this.add({ name: 'rest', ty: 'arr', mutable: true });
			}
			const lines = this.nested(() => this.block(2 + r.int(5)));
			lines.push(`return ${this.e('any', 2)};`);
			return lines;
		});
		const guarded =
			f.kind === 'sync'
				? [
						'if (--fuel < 0 || depth > 40) return 0;',
						'depth++;',
						'try {',
						...indent(body),
						'} finally {',
						'\tdepth--;',
						'}'
					]
				: ['if (--fuel < 0) return 0;', ...body];
		const ret = is_gen ? '' : this.t(is_async ? ': Promise<any>' : ': any');
		return [
			`${is_async ? 'async ' : ''}function${is_gen ? '*' : ''} ${f.name}(${params.join(', ')})${ret} {`,
			...indent(guarded),
			'}'
		];
	}

	class_decl(index: number): string[] {
		const r = this.rng;
		const name = `C${index}`;
		const parent = this.classes.length > 0 && r.chance(0.4) ? r.pick(this.classes) : null;
		const info: ClassInfo = {
			name,
			methods: parent ? [...parent.methods] : [],
			getters: parent ? [...parent.getters] : [],
			setters: parent ? [...parent.setters] : [],
			statics: [],
			arity: 1
		};
		this.f('class');
		if (parent) this.f('class-extends');
		const members: string[] = [];
		const method_ctx: FnCtx = {
			is_async: false,
			is_gen: false,
			own_args: true,
			index: -1,
			can_return: true,
			top: false
		};
		const has_private = r.chance(0.5);
		if (has_private) {
			this.f('private-field');
			members.push(`#p${this.t(': any')} = ${this.lit('num')};`);
		}
		if (r.chance(0.6)) {
			this.f('class-field');
			members.push(`x${index}${this.t(': any')} = ${this.lit('num')} + ${this.lit('num')};`);
		}
		if (r.chance(0.3)) {
			this.f('class-field-arrow');
			members.push(`h${index} = (q${this.t(': any')}) => (log(${this.label()}, q), q);`);
		}
		if (r.chance(0.4)) {
			this.f('static-field');
			members.push(`static s${index} = ${this.lit('str')};`);
		}
		if (r.chance(0.4)) {
			this.f('static-block');
			members.push(
				'static {',
				`\tlog(${this.label()}, '${name} static');`,
				`\tthis.t${index} = ${this.lit('num')};`,
				'}'
			);
		}
		if (parent || r.chance(0.6)) {
			this.f('constructor');
			const body = this.in_function(method_ctx, () => {
				this.add({ name: 'a0', ty: 'any', mutable: true });
				const lines: string[] = [];
				if (parent) lines.push('super(a0);');
				lines.push(`this.y${index} = a0;`, `log(${this.label()}, new.target === ${name});`);
				lines.push(...this.nested(() => this.block(r.int(2))));
				return lines;
			});
			members.push(`constructor(a0${this.t(': any')}) {`, ...indent(body), '}');
		}
		for (let i = 0, n = r.int(3) + 1; i < n; i++) {
			const m = `m${index}_${i}`;
			const body = this.in_function(method_ctx, () => {
				this.add({ name: 'q', ty: 'num', mutable: true });
				const lines = ['if (--fuel < 0) return 0;', ...this.nested(() => this.block(r.int(3)))];
				if (parent && parent.methods.length > 0 && r.chance(0.4)) {
					this.f('super-method-call');
					lines.push(`log(${this.label()}, super.${r.pick(parent.methods)}(q));`);
				}
				if (has_private && r.chance(0.5)) {
					this.f('private-method-call');
					lines.push('this.#p = this.#pm(this.#p, q);');
				}
				if (has_private && r.chance(0.2)) {
					this.f('private-in');
					lines.push(`log(${this.label()}, #p in this);`);
				}
				lines.push(`return ${this.e('any', 2)};`);
				return lines;
			});
			members.push(`${m}(q${this.t(': any')}) {`, ...indent(body), '}');
			info.methods.push(m);
		}
		if (has_private) {
			this.f('private-method');
			members.push(
				`#pm(a${this.t(': any')}, b${this.t(': any')}) {`,
				'\treturn (a | 0) + (b | 0);',
				'}'
			);
		}
		if (r.chance(0.6)) {
			this.f('getter');
			const g = `g${index}`;
			members.push(`get ${g}() {`, `\treturn ${has_private ? 'this.#p' : `this.y${index}`};`, '}');
			info.getters.push(g);
			if (r.chance(0.5)) {
				this.f('setter');
				members.push(`set ${g}(v${this.t(': any')}) {`, `\tlog(${this.label()}, v);`, '}');
				info.setters.push(g);
			}
		}
		if (r.chance(0.4)) {
			this.f('static-method');
			const s = `sm${index}`;
			const body = this.in_function(method_ctx, () => {
				this.add({ name: 'q', ty: 'num', mutable: true });
				return [...this.nested(() => this.block(r.int(2))), `return ${this.e('num', 1)};`];
			});
			members.push(`static ${s}(q${this.t(': any')}) {`, ...indent(body), '}');
			info.statics.push(s);
		}
		if (r.chance(0.2)) {
			this.f('computed-method');
			members.push(`['c' + ${index}]() {`, '\treturn 1;', '}');
		}
		this.classes.push(info);
		return [
			parent ? `class ${name} extends ${parent.name} {` : `class ${name} {`,
			...indent(members),
			'}'
		];
	}

	main_body(nfn: number): string[] {
		const r = this.rng;
		const ctx: FnCtx = {
			is_async: true,
			is_gen: false,
			own_args: true,
			index: nfn,
			can_return: false,
			top: false
		};
		return this.in_function(ctx, () => {
			const out: string[] = ['log = $log;'];
			for (const f of this.fns) {
				for (let t = 0, times = r.int(3); t < times; t++) {
					const call = `${f.name}(${this.args(f.arity, 1)})`;
					if (f.kind === 'sync') out.push(`log(${this.label()}, ${call});`);
					else if (f.kind === 'async') out.push(`log(${this.label()}, await ${call});`);
					else if (f.kind === 'agen')
						out.push(`for await (const q of ${call}) log(${this.label()}, q);`);
					else if (r.chance(0.3)) {
						this.f('generator-by-hand');
						out.push(
							'{',
							`\tconst it = ${call};`,
							`\tlog(${this.label()}, it.next());`,
							`\tlog(${this.label()}, it.next(7));`,
							r.chance(0.5)
								? `\tlog(${this.label()}, it.return(9));`
								: `\ttry { log(${this.label()}, it.throw(new Error('T'))); } catch (q) { log(${this.label()}, String(q)); }`,
							'}'
						);
					} else out.push(`log(${this.label()}, [...${call}]);`);
				}
			}
			if (this.classes.length > 0) {
				const c = r.pick(this.classes);
				const v = this.add({ name: 'inst', ty: 'inst', mutable: false, cls: c });
				out.push(`const ${v.name} = new ${c.name}(${this.args(1, 1)});`);
				for (const m of c.methods.slice(0, 2))
					out.push(`log(${this.label()}, ${v.name}.${m}(${this.e('num', 1)}));`);
				for (const g of c.getters) out.push(`log(${this.label()}, ${v.name}.${g});`);
			}
			const asyncs = this.fns.filter((f) => f.kind === 'async');
			if (asyncs.length > 1 && r.chance(0.4)) {
				this.f('interleaved-async');
				out.push(
					`log(${this.label()}, await Promise.all([${asyncs.map((a) => `${a.name}(${this.args(a.arity, 1)})`).join(', ')}]));`
				);
			}
			out.push(...this.nested(() => this.block(r.int(4))));
			if (r.chance(0.03)) {
				this.f('hot-loop');
				out.push(
					`let hot = 0;`,
					`for (let i = 0; i < ${20000 + r.int(20000)}; i++) hot += i & 7;`,
					`log('hot', hot);`
				);
			}
			if (r.chance(0.03)) {
				this.deep = true;
				this.f('stack-overflow');
				out.push(
					`function rec(n${this.t(': number')})${this.t(': number')} { return n <= 0 ? 0 : 1 + rec(n - 1); }`,
					"try { rec(1e7); } catch (q) { log('overflow', q instanceof RangeError); }"
				);
			}
			out.push('return fuel;');
			return out;
		});
	}

	program(seed: number, o: GenOptions): Program {
		const r = this.rng;
		const lines: string[] = [];
		if (this.ts) {
			this.f('ts');
			lines.push('type Num = number;', 'interface Shape { a?: Num; b?: string }');
		}
		lines.push(
			`let log${this.t(': (label: string, value: unknown) => void')} = () => {};`,
			'let fuel = 1500;',
			'let depth = 0;',
			`function cap(x${this.t(': any')}) {`,
			'\treturn x.length > 48 ? x.slice(0, 48) : x;',
			'}',
			`function tag(strs${this.t(': TemplateStringsArray')}, ...vals${this.t(': unknown[]')}) {`,
			"\treturn strs.raw.join('|') + vals.length;",
			'}',
			`function res_sync(name${this.t(': string')}) {`,
			"\treturn { [Symbol.dispose]() { log('dispose', name); } };",
			'}',
			`function res_async(name${this.t(': string')}) {`,
			"\treturn { async [Symbol.asyncDispose]() { await null; log('async dispose', name); } };",
			'}'
		);
		// module-level variables are literals: a function may run before a later one is initialised
		for (let i = 0, n = r.int(4) + 1; i < n; i++) {
			const ty = r.pick(['num', 'str', 'arr', 'obj'] as const);
			const v = this.declare(ty, true, 'g');
			lines.push(`let ${v.name}${this.t(': ' + TS_TYPES[ty])} = ${this.lit(ty)};`);
		}
		const nfn = o.functions ?? 3 + r.int(5);
		for (let i = 0; i < nfn; i++) {
			const kind = r.weighted([
				[6, 'sync'],
				[2, 'async'],
				[1, 'gen'],
				[1, 'agen']
			] as const);
			this.fns.push({ name: `f${i}`, arity: r.int(3), kind, index: i });
		}
		for (let i = 0, n = r.int(3); i < n; i++) lines.push(...this.class_decl(i));
		for (const f of this.fns) lines.push(...this.function_decl(f));
		const main = this.main_body(nfn);
		lines.push(`export async function main($log${this.t(': any')}) {`, ...indent(main), '}');
		if (r.chance(0.3)) {
			this.f('export-default');
			lines.push(
				r.pick([
					'export default { cap, tag };',
					'export default function (q) { return q; }',
					'export default class {}'
				])
			);
		}
		return {
			seed,
			lang: this.lang,
			source: lines.join('\n') + '\n',
			deep: this.deep,
			features: [...this.features].sort()
		};
	}
}

export function generate(seed: number, o: GenOptions = {}): Program {
	return new Generator(seed, o).program(seed, o);
}
