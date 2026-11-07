import type { BenchCase } from '../bench.ts';
import { ANY_RECEIVER } from '../runtime/index.ts';
import type { Runtime } from '../runtime/index.ts';
import { StepCapError } from '../runtime/index.ts';

/*
 * The regex model of the worst-case search. Built-ins are priced by input size, so a regular
 * expression that backtracks costs no more steps than one that walks its input once, and the
 * search could not see a catastrophic regex. While the search counts a case, every regex match
 * (exec, and through it test, match, matchAll, replace, split and search) is first run on a small
 * backtracking machine that does what V8's irregexp does on the same pattern: try each start
 * position, take the preferred branch first, come back to the others on failure. Its instruction
 * count is the regex's work.
 *
 * A regex that walks its input about once runs at most its program's length in instructions per
 * character it walks: that is what exec's linear price already covers. Instructions past that
 * allowance are backtracking, each charged like one more character walked, as extra work next to
 * the counted steps (never inside them: `heisenbench run` counts the same with or without it).
 *
 * The machine stops at a budget per match. Past it the match is a runaway: the real regex is never
 * run (it could take hours), the call throws a RegexRunawayError, and the search reports the input
 * as one the code may never finish on. The machine is checked against V8 on every match it
 * finishes: a pattern where they disagree on where the match is, or one the machine cannot model
 * (lookbehind, Unicode property escapes, the v flag), is left to V8 and counted as not modeled.
 */

// Originals, captured at load: the model runs inside the measuring window.
const reflect_apply = Reflect.apply;
const buffer_from = Buffer.from.bind(Buffer);
const capture_stack = (Error as { captureStackTrace?: (o: object, f: Function) => void })
	.captureStackTrace;

/** A match that went past its budget: the real regex is never run. */
export class RegexRunawayError extends StepCapError {
	override name = 'RegexRunawayError';
	source: string;
	flags: string;
	/** Characters from where the match started to the end of the input. */
	size: number;

	constructor(source: string, flags: string, size: number, vm: number) {
		super(vm, vm);
		this.message = `heisenbench: /${source}/${flags} went past ${vm} backtracking steps on ${size} characters`;
		this.source = source;
		this.flags = flags;
		this.size = size;
	}
}

class Unsupported extends Error {}

// ---------------------------------------------------------------- parsing

type RNode =
	| { t: 'char'; c: number }
	| { t: 'any' }
	| { t: 'class'; ranges: number[]; neg: boolean }
	| { t: 'seq'; items: RNode[] }
	| { t: 'alt'; alts: RNode[] }
	| { t: 'group'; cap: number; body: RNode }
	| { t: 'look'; neg: boolean; body: RNode }
	| { t: 'quant'; body: RNode; min: number; max: number; greedy: boolean }
	| { t: 'bol' }
	| { t: 'eol' }
	| { t: 'wordb'; neg: boolean }
	| { t: 'backref'; n: number; name?: string };

const MAX_CP = 0x10ffff;
const DIGIT = [48, 57];
const WORD = [48, 57, 65, 90, 95, 95, 97, 122];
const SPACE = [
	9, 13, 32, 32, 160, 160, 5760, 5760, 8192, 8202, 8232, 8233, 8239, 8239, 8287, 8287, 12288, 12288,
	65279, 65279
];

function complement(r: number[]): number[] {
	const out: number[] = [];
	let lo = 0;
	for (let i = 0; i < r.length; i += 2) {
		if (r[i] > lo) out.push(lo, r[i] - 1);
		lo = r[i + 1] + 1;
	}
	if (lo <= MAX_CP) out.push(lo, MAX_CP);
	return out;
}

function normalize(r: number[]): number[] {
	const pairs: Array<[number, number]> = [];
	for (let i = 0; i < r.length; i += 2) pairs.push([r[i], r[i + 1]]);
	pairs.sort((a, b) => a[0] - b[0]);
	const out: number[] = [];
	for (const [lo, hi] of pairs) {
		const n = out.length;
		if (n > 0 && lo <= out[n - 1] + 1) out[n - 1] = Math.max(out[n - 1], hi);
		else out.push(lo, hi);
	}
	return out;
}

class Parser {
	i = 0;
	groups = 0;
	names = new Map<string, number>();
	src: string;
	u: boolean;
	total_groups: number;

	constructor(src: string, u: boolean) {
		this.src = src;
		this.u = u;
		this.total_groups = count_groups(src);
	}

	peek(): number {
		return this.i < this.src.length ? this.src.charCodeAt(this.i) : -1;
	}

	/** The next pattern character: a whole code point with the u flag. */
	next_char(): number {
		const s = this.src;
		const c = s.charCodeAt(this.i++);
		if (this.u && c >= 0xd800 && c <= 0xdbff && this.i < s.length) {
			const d = s.charCodeAt(this.i);
			if (d >= 0xdc00 && d <= 0xdfff) {
				this.i++;
				return (c - 0xd800) * 0x400 + (d - 0xdc00) + 0x10000;
			}
		}
		return c;
	}

	parse(): RNode {
		const n = this.disjunction();
		if (this.i < this.src.length) throw new Unsupported('unbalanced )');
		return n;
	}

	disjunction(): RNode {
		const alts: RNode[] = [this.alternative()];
		while (this.peek() === 124 /* | */) {
			this.i++;
			alts.push(this.alternative());
		}
		return alts.length === 1 ? alts[0] : { t: 'alt', alts };
	}

	alternative(): RNode {
		const items: RNode[] = [];
		while (this.i < this.src.length) {
			const c = this.peek();
			if (c === 124 || c === 41) break;
			const atom = this.term();
			if (atom) items.push(atom);
		}
		return items.length === 1 ? items[0] : { t: 'seq', items };
	}

	term(): RNode | null {
		const s = this.src;
		const c = this.peek();
		if (c === 94 /* ^ */) {
			this.i++;
			return { t: 'bol' };
		}
		if (c === 36 /* $ */) {
			this.i++;
			return { t: 'eol' };
		}
		if (c === 92 /* \ */ && (s[this.i + 1] === 'b' || s[this.i + 1] === 'B')) {
			const neg = s[this.i + 1] === 'B';
			this.i += 2;
			return { t: 'wordb', neg };
		}
		if (c === 40 /* ( */ && s[this.i + 1] === '?') {
			const k = s[this.i + 2];
			if (k === '=' || k === '!') {
				this.i += 3;
				const body = this.disjunction();
				this.expect(41);
				const look: RNode = { t: 'look', neg: k === '!', body };
				// Annex B lets a lookahead be quantified; it matches the same as one copy
				if (!this.u && this.at_quantifier()) this.quantifier(look);
				return look;
			}
			if (k === '<' && (s[this.i + 3] === '=' || s[this.i + 3] === '!'))
				throw new Unsupported('lookbehind');
		}
		const atom = this.atom();
		return this.at_quantifier() ? this.quantifier(atom) : atom;
	}

	expect(c: number): void {
		if (this.peek() !== c) throw new Unsupported('syntax');
		this.i++;
	}

	at_quantifier(): boolean {
		const c = this.peek();
		if (c === 42 || c === 43 || c === 63) return true;
		if (c === 123 /* { */) return /^\{\d+(,\d*)?\}/.test(this.src.slice(this.i));
		return false;
	}

	quantifier(body: RNode): RNode {
		const c = this.peek();
		let min = 0;
		let max = Infinity;
		if (c === 42) this.i++;
		else if (c === 43) {
			this.i++;
			min = 1;
		} else if (c === 63) {
			this.i++;
			max = 1;
		} else {
			const m = /^\{(\d+)(,(\d*))?\}/.exec(this.src.slice(this.i))!;
			this.i += m[0].length;
			min = Number(m[1]);
			max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
			if (max < min) throw new Unsupported('range');
		}
		let greedy = true;
		if (this.peek() === 63) {
			this.i++;
			greedy = false;
		}
		return { t: 'quant', body, min, max, greedy };
	}

	atom(): RNode {
		const s = this.src;
		const c = this.peek();
		if (c === 46 /* . */) {
			this.i++;
			return { t: 'any' };
		}
		if (c === 40 /* ( */) {
			this.i++;
			let cap = -1;
			if (s[this.i] === '?') {
				if (s[this.i + 1] === ':') this.i += 2;
				else if (s[this.i + 1] === '<') {
					const end = s.indexOf('>', this.i);
					if (end < 0) throw new Unsupported('group name');
					const name = s.slice(this.i + 2, end);
					this.i = end + 1;
					cap = ++this.groups;
					if (this.names.has(name)) throw new Unsupported('duplicate group name');
					this.names.set(name, cap);
				} else throw new Unsupported('group modifier');
			} else cap = ++this.groups;
			const body = this.disjunction();
			this.expect(41);
			return { t: 'group', cap, body };
		}
		if (c === 91 /* [ */) return this.char_class();
		if (c === 92 /* \ */) return this.escape();
		if (c === 42 || c === 43 || c === 63) throw new Unsupported('nothing to repeat');
		if (this.u && (c === 41 || c === 93 || c === 123 || c === 125)) throw new Unsupported('syntax');
		return { t: 'char', c: this.next_char() };
	}

	escape(): RNode {
		const s = this.src;
		this.i++;
		const k = s[this.i];
		if (k === undefined) throw new Unsupported('trailing \\');
		const set = class_escape(k);
		if (set) {
			this.i++;
			return { t: 'class', ranges: set, neg: false };
		}
		if (k === 'k' && (this.u || this.total_groups > 0 || s.includes('(?<'))) {
			const end = s.indexOf('>', this.i);
			if (s[this.i + 1] !== '<' || end < 0) throw new Unsupported('\\k');
			const name = s.slice(this.i + 2, end);
			this.i = end + 1;
			return { t: 'backref', n: 0, name };
		}
		if (k >= '1' && k <= '9') {
			const m = /^\d+/.exec(s.slice(this.i))![0];
			const n = Number(m);
			if (n <= this.total_groups) {
				this.i += m.length;
				return { t: 'backref', n };
			}
			if (this.u) throw new Unsupported('backref');
			// Annex B: an octal escape, or the digit itself
			if (k >= '8') {
				this.i++;
				return { t: 'char', c: k.charCodeAt(0) };
			}
		}
		return { t: 'char', c: this.char_escape() };
	}

	/** One escaped character (after the `\`), as a code point. */
	char_escape(): number {
		const s = this.src;
		const k = s[this.i++];
		switch (k) {
			case 't':
				return 9;
			case 'n':
				return 10;
			case 'v':
				return 11;
			case 'f':
				return 12;
			case 'r':
				return 13;
			case 'c': {
				const l = s.charCodeAt(this.i);
				if ((l >= 65 && l <= 90) || (l >= 97 && l <= 122)) {
					this.i++;
					return l % 32;
				}
				if (this.u) throw new Unsupported('\\c');
				this.i--;
				return 92;
			}
			case 'x': {
				const m = /^[0-9a-fA-F]{2}/.exec(s.slice(this.i));
				if (m) {
					this.i += 2;
					return parseInt(m[0], 16);
				}
				if (this.u) throw new Unsupported('\\x');
				return 120;
			}
			case 'u': {
				if (s[this.i] === '{' && this.u) {
					const end = s.indexOf('}', this.i);
					if (end < 0) throw new Unsupported('\\u{');
					const cp = parseInt(s.slice(this.i + 1, end), 16);
					this.i = end + 1;
					return cp;
				}
				const m = /^[0-9a-fA-F]{4}/.exec(s.slice(this.i));
				if (!m) {
					if (this.u) throw new Unsupported('\\u');
					return 117;
				}
				this.i += 4;
				const hi = parseInt(m[0], 16);
				if (this.u && hi >= 0xd800 && hi <= 0xdbff) {
					const n = /^\\u([0-9a-fA-F]{4})/.exec(s.slice(this.i));
					const lo = n ? parseInt(n[1], 16) : -1;
					if (lo >= 0xdc00 && lo <= 0xdfff) {
						this.i += 6;
						return (hi - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
					}
				}
				return hi;
			}
			case '0':
				if (!/[0-9]/.test(s[this.i] ?? '')) return 0;
				if (this.u) throw new Unsupported('octal');
				return this.octal(0);
			case 'p':
			case 'P':
				if (this.u) throw new Unsupported('property escape');
				return k.charCodeAt(0);
			default:
				if (k >= '1' && k <= '7' && !this.u) return this.octal(k.charCodeAt(0) - 48);
				this.i--;
				return this.next_char();
		}
	}

	octal(first: number): number {
		let v = first;
		for (let j = 0; j < 2; j++) {
			const d = this.src.charCodeAt(this.i) - 48;
			if (d < 0 || d > 7 || v * 8 + d > 255) break;
			v = v * 8 + d;
			this.i++;
		}
		return v;
	}

	char_class(): RNode {
		const s = this.src;
		this.i++;
		let neg = false;
		if (s[this.i] === '^') {
			neg = true;
			this.i++;
		}
		const ranges: number[] = [];
		while (true) {
			if (this.i >= s.length) throw new Unsupported('unterminated class');
			if (s[this.i] === ']') {
				this.i++;
				break;
			}
			const a = this.class_atom();
			if (s[this.i] === '-' && s[this.i + 1] !== ']' && this.i + 1 < s.length && a !== null) {
				this.i++;
				const b = this.class_atom();
				if (b === null || typeof a !== 'number' || typeof b !== 'number') {
					if (this.u) throw new Unsupported('class range');
					// Annex B: [\w-x] is \w, '-' and x
					push_atom(ranges, a);
					ranges.push(45, 45);
					if (b !== null) push_atom(ranges, b);
					continue;
				}
				if (b < a) throw new Unsupported('class range order');
				ranges.push(a, b);
				continue;
			}
			if (a !== null) push_atom(ranges, a);
		}
		return { t: 'class', ranges: normalize(ranges), neg };
	}

	/** A class member: one code point, or a set (`\d`). */
	class_atom(): number | number[] | null {
		const s = this.src;
		if (s[this.i] !== '\\') return this.next_char();
		this.i++;
		const k = s[this.i];
		const set = class_escape(k);
		if (set) {
			this.i++;
			return set;
		}
		if (k === 'b') {
			this.i++;
			return 8;
		}
		if (k === '-' && this.u) {
			this.i++;
			return 45;
		}
		if (k >= '1' && k <= '9' && !this.u) {
			if (k >= '8') {
				this.i++;
				return k.charCodeAt(0);
			}
			this.i++;
			return this.octal(k.charCodeAt(0) - 48);
		}
		return this.char_escape();
	}
}

function push_atom(ranges: number[], a: number | number[]): void {
	if (typeof a === 'number') ranges.push(a, a);
	else ranges.push(...a);
}

function class_escape(k: string | undefined): number[] | null {
	switch (k) {
		case 'd':
			return DIGIT;
		case 'D':
			return complement(DIGIT);
		case 'w':
			return WORD;
		case 'W':
			return complement(WORD);
		case 's':
			return SPACE;
		case 'S':
			return complement(SPACE);
		default:
			return null;
	}
}

/** Capturing groups in a pattern (to tell `\10` the backreference from `\1` then `0`). */
function count_groups(s: string): number {
	let n = 0;
	let in_class = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === '\\') i++;
		else if (in_class) {
			if (c === ']') in_class = false;
		} else if (c === '[') in_class = true;
		else if (c === '(' && (s[i + 1] !== '?' || (s[i + 2] === '<' && /[A-Za-z_$]/.test(s[i + 3]))))
			n++;
	}
	return n;
}

// ---------------------------------------------------------------- compiling

/** The machine's instructions: `[op, a, b]` triples. */
const Op = {
	MATCH: 0,
	CHAR: 1,
	CHAR_I: 2,
	ANY: 3,
	ANY_ALL: 4,
	CLASS: 5,
	/** Try `a`, come back to `b` on failure. */
	SPLIT: 6,
	JMP: 7,
	SAVE: 8,
	BOL: 9,
	EOL: 10,
	BOL_M: 11,
	EOL_M: 12,
	WORDB: 13,
	NWORDB: 14,
	BACKREF: 15,
	/** `a`: negative; `b`: where to go after the lookahead. */
	LOOK: 16,
	LOOK_END: 17,
	/** Progress registers: an iteration of a loop whose body can match nothing must move. */
	PSET: 18,
	PCHECK: 19
} as const;

interface Program {
	code: Int32Array;
	/** Instructions (code.length / 3). */
	length: number;
	classes: Array<{ ranges: number[]; neg: boolean }>;
	regs: number;
	/** First progress register (after the capture registers). */
	pbase: number;
	icase: boolean;
	unicode: boolean;
	/** Every alternative starts with `^` (and no m flag): only one start position to try. */
	anchored: boolean;
}

const MAX_PROGRAM = 60_000;

function nullable(n: RNode): boolean {
	switch (n.t) {
		case 'char':
		case 'any':
		case 'class':
			return false;
		case 'seq':
			return n.items.every(nullable);
		case 'alt':
			return n.alts.some(nullable);
		case 'group':
			return nullable(n.body);
		case 'quant':
			return n.min === 0 || nullable(n.body);
		default:
			return true;
	}
}

class Compiler {
	code: number[] = [];
	classes: Array<{ ranges: number[]; neg: boolean }> = [];
	progress = 0;
	flags: { i: boolean; m: boolean; s: boolean };
	names: Map<string, number>;

	constructor(flags: { i: boolean; m: boolean; s: boolean }, names: Map<string, number>) {
		this.flags = flags;
		this.names = names;
	}

	emit(op: number, a = 0, b = 0): number {
		const pc = this.code.length / 3;
		if (pc > MAX_PROGRAM) throw new Unsupported('program too large');
		this.code.push(op, a, b);
		return pc;
	}

	patch(pc: number, slot: 1 | 2, v: number): void {
		this.code[pc * 3 + slot] = v;
	}

	get pc(): number {
		return this.code.length / 3;
	}

	node(n: RNode): void {
		switch (n.t) {
			case 'char':
				if (this.flags.i) this.emit(Op.CHAR_I, fold(n.c));
				else this.emit(Op.CHAR, n.c);
				return;
			case 'any':
				this.emit(this.flags.s ? Op.ANY_ALL : Op.ANY);
				return;
			case 'class':
				this.classes.push({ ranges: n.ranges, neg: n.neg });
				this.emit(Op.CLASS, this.classes.length - 1);
				return;
			case 'seq':
				for (const x of n.items) this.node(x);
				return;
			case 'alt': {
				const jumps: number[] = [];
				for (let k = 0; k < n.alts.length; k++) {
					if (k < n.alts.length - 1) {
						const split = this.emit(Op.SPLIT, this.pc + 1, 0);
						this.node(n.alts[k]);
						jumps.push(this.emit(Op.JMP));
						this.patch(split, 2, this.pc);
					} else this.node(n.alts[k]);
				}
				for (const j of jumps) this.patch(j, 1, this.pc);
				return;
			}
			case 'group':
				if (n.cap < 0) {
					this.node(n.body);
					return;
				}
				this.emit(Op.SAVE, 2 * n.cap);
				this.node(n.body);
				this.emit(Op.SAVE, 2 * n.cap + 1);
				return;
			case 'look': {
				const look = this.emit(Op.LOOK, n.neg ? 1 : 0, 0);
				this.node(n.body);
				this.emit(Op.LOOK_END);
				this.patch(look, 2, this.pc);
				return;
			}
			case 'quant':
				this.quant(n.body, n.min, n.max, n.greedy);
				return;
			case 'bol':
				this.emit(this.flags.m ? Op.BOL_M : Op.BOL);
				return;
			case 'eol':
				this.emit(this.flags.m ? Op.EOL_M : Op.EOL);
				return;
			case 'wordb':
				this.emit(n.neg ? Op.NWORDB : Op.WORDB);
				return;
			case 'backref': {
				const g = n.name !== undefined ? this.names.get(n.name) : n.n;
				if (g === undefined) throw new Unsupported('unknown group');
				this.emit(Op.BACKREF, g, this.flags.i ? 1 : 0);
				return;
			}
		}
	}

	split(greedy: boolean, body: number, out: number): number {
		return greedy ? this.emit(Op.SPLIT, body, out) : this.emit(Op.SPLIT, out, body);
	}

	quant(body: RNode, min: number, max: number, greedy: boolean): void {
		if (max === 0) return;
		for (let k = 0; k < min; k++) this.node(body);
		const empty = nullable(body);
		if (max === Infinity) {
			const top = this.pc;
			const split = this.split(greedy, top + 1, 0);
			const reg = empty ? this.progress++ : -1;
			if (empty) this.emit(Op.PSET, reg);
			this.node(body);
			if (empty) this.emit(Op.PCHECK, reg);
			this.emit(Op.JMP, top);
			this.patch(split, greedy ? 2 : 1, this.pc);
			return;
		}
		const splits: number[] = [];
		const reg = empty ? this.progress++ : -1;
		for (let k = min; k < max; k++) {
			splits.push(this.split(greedy, this.pc + 1, 0));
			if (empty) this.emit(Op.PSET, reg);
			this.node(body);
			if (empty) this.emit(Op.PCHECK, reg);
		}
		for (const s of splits) this.patch(s, greedy ? 2 : 1, this.pc);
	}
}

const FOLD = new Int32Array(65536).fill(-1);

/** The canonical case of a character (what the i flag compares). */
function fold(c: number): number {
	if (c < 128) return c >= 65 && c <= 90 ? c + 32 : c;
	if (c > 0xffff) return c;
	let f = FOLD[c];
	if (f < 0) {
		const lower = String.fromCharCode(c).toLowerCase();
		f = lower.length === 1 ? lower.charCodeAt(0) : c;
		FOLD[c] = f;
	}
	return f;
}

const UPPER = new Int32Array(65536).fill(-1);

function upper(c: number): number {
	if (c < 128) return c >= 97 && c <= 122 ? c - 32 : c;
	if (c > 0xffff) return c;
	let f = UPPER[c];
	if (f < 0) {
		const up = String.fromCharCode(c).toUpperCase();
		f = up.length === 1 ? up.charCodeAt(0) : c;
		UPPER[c] = f;
	}
	return f;
}

function anchored(n: RNode): boolean {
	if (n.t === 'bol') return true;
	if (n.t === 'seq') return n.items.length > 0 && anchored(n.items[0]);
	if (n.t === 'alt') return n.alts.every(anchored);
	if (n.t === 'group') return anchored(n.body);
	return false;
}

/** The machine's program for a pattern, or null when it cannot model it. */
export function compile(source: string, flags: string): Program | null {
	if (flags.includes('v')) return null;
	try {
		const u = flags.includes('u');
		const p = new Parser(source, u);
		const ast = p.parse();
		const f = { i: flags.includes('i'), m: flags.includes('m'), s: flags.includes('s') };
		const c = new Compiler(f, p.names);
		c.emit(Op.SAVE, 0);
		c.node(ast);
		c.emit(Op.SAVE, 1);
		c.emit(Op.MATCH);
		const groups = p.groups + 1;
		return {
			code: Int32Array.from(c.code),
			length: c.code.length / 3,
			classes: c.classes,
			regs: 2 * groups + c.progress,
			pbase: 2 * groups,
			icase: f.i,
			unicode: u,
			anchored: !f.m && anchored(ast)
		};
	} catch (e) {
		if (e instanceof Unsupported) return null;
		throw e;
	}
}

// ---------------------------------------------------------------- running

function in_ranges(r: number[], c: number): boolean {
	for (let i = 0; i < r.length; i += 2) {
		if (c < r[i]) return false;
		if (c <= r[i + 1]) return true;
	}
	return false;
}

function is_word(c: number): boolean {
	return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function is_line_end(c: number): boolean {
	return c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
}

export interface MachineResult {
	/** -1: no match. */
	index: number;
	end: number;
	/** Instructions run (plus one per backtrack). */
	steps: number;
	/** Went past the budget. */
	over: boolean;
}

/** Stack entry kinds. */
const CHOICE = 0;
const UNDO = 1;
const BARRIER = 2;

/** Run `p` on `s` (UTF-16 code units, `n` of them) from `start`, as exec would. */
export function run_machine(
	p: Program,
	s: Uint16Array,
	n: number,
	start: number,
	sticky: boolean,
	budget: number
): MachineResult {
	const code = p.code;
	const regs = new Int32Array(p.regs);
	let sk = new Int32Array(256);
	let sa = new Int32Array(256);
	let sb = new Int32Array(256);
	let sp = 0;
	let steps = 0;
	const icase = p.icase;
	const uni = p.unicode;
	const read = (pos: number): number => {
		const c = s[pos];
		if (uni && c >= 0xd800 && c <= 0xdbff && pos + 1 < n) {
			const d = s[pos + 1];
			if (d >= 0xdc00 && d <= 0xdfff) return (c - 0xd800) * 0x400 + (d - 0xdc00) + 0x10000;
		}
		return c;
	};
	const push = (k: number, a: number, b: number): void => {
		if (sp === sk.length) {
			const grow = (x: Int32Array<ArrayBuffer>): Int32Array<ArrayBuffer> => {
				const y = new Int32Array(x.length * 2);
				y.set(x);
				return y;
			};
			sk = grow(sk);
			sa = grow(sa);
			sb = grow(sb);
		}
		sk[sp] = k;
		sa[sp] = a;
		sb[sp] = b;
		sp++;
	};
	const set_reg = (r: number, v: number): void => {
		push(UNDO, r, regs[r]);
		regs[r] = v;
	};
	const last = sticky || p.anchored ? start : n;
	if (start > n || (p.anchored && start > 0)) return { index: -1, end: -1, steps: 1, over: false };
	for (let q = start; q <= last; q++) {
		regs.fill(-1);
		sp = 0;
		let pc = 0;
		let pos = q;
		run: while (true) {
			if (++steps > budget) return { index: -1, end: -1, steps, over: true };
			const op = code[pc * 3];
			let ok = true;
			switch (op) {
				case Op.MATCH:
					return { index: regs[0], end: regs[1], steps, over: false };
				case Op.CHAR:
				case Op.CHAR_I: {
					if (pos >= n) {
						ok = false;
						break;
					}
					const c = read(pos);
					const want = code[pc * 3 + 1];
					if (op === Op.CHAR ? c !== want : fold(c) !== want) ok = false;
					else {
						pos += c > 0xffff ? 2 : 1;
						pc++;
					}
					break;
				}
				case Op.ANY:
				case Op.ANY_ALL: {
					if (pos >= n) {
						ok = false;
						break;
					}
					const c = read(pos);
					if (op === Op.ANY && is_line_end(c)) ok = false;
					else {
						pos += c > 0xffff ? 2 : 1;
						pc++;
					}
					break;
				}
				case Op.CLASS: {
					if (pos >= n) {
						ok = false;
						break;
					}
					const cls = p.classes[code[pc * 3 + 1]];
					const c = read(pos);
					let hit = in_ranges(cls.ranges, c);
					if (!hit && icase)
						hit = in_ranges(cls.ranges, fold(c)) || in_ranges(cls.ranges, upper(c));
					if (hit === cls.neg) ok = false;
					else {
						pos += c > 0xffff ? 2 : 1;
						pc++;
					}
					break;
				}
				case Op.SPLIT:
					push(CHOICE, code[pc * 3 + 2], pos);
					pc = code[pc * 3 + 1];
					break;
				case Op.JMP:
					pc = code[pc * 3 + 1];
					break;
				case Op.SAVE:
					set_reg(code[pc * 3 + 1], pos);
					pc++;
					break;
				case Op.BOL:
					if (pos !== 0) ok = false;
					else pc++;
					break;
				case Op.EOL:
					if (pos !== n) ok = false;
					else pc++;
					break;
				case Op.BOL_M:
					if (pos !== 0 && !is_line_end(s[pos - 1])) ok = false;
					else pc++;
					break;
				case Op.EOL_M:
					if (pos !== n && !is_line_end(s[pos])) ok = false;
					else pc++;
					break;
				case Op.WORDB:
				case Op.NWORDB: {
					const a = pos > 0 && is_word(s[pos - 1]);
					const b = pos < n && is_word(s[pos]);
					if ((a !== b) === (op === Op.WORDB)) pc++;
					else ok = false;
					break;
				}
				case Op.BACKREF: {
					const g = code[pc * 3 + 1];
					const from = regs[2 * g];
					const to = regs[2 * g + 1];
					if (from < 0 || to < 0) {
						pc++;
						break;
					}
					const len = to - from;
					if (pos + len > n) {
						ok = false;
						break;
					}
					for (let j = 0; j < len; j++) {
						const x = s[from + j];
						const y = s[pos + j];
						if (x !== y && !(code[pc * 3 + 2] === 1 && fold(x) === fold(y))) {
							ok = false;
							break;
						}
					}
					if (ok) {
						pos += len;
						pc++;
					}
					break;
				}
				case Op.LOOK:
					push(BARRIER, pc, pos);
					pc++;
					break;
				case Op.LOOK_END: {
					let b = sp - 1;
					while (sk[b] !== BARRIER) b--;
					const look = sa[b];
					const at = sb[b];
					const neg = code[look * 3 + 1] === 1;
					if (!neg) {
						// the lookahead matched: drop its choices, keep what it captured
						let w = b;
						for (let j = b + 1; j < sp; j++) {
							if (sk[j] !== UNDO) continue;
							sk[w] = UNDO;
							sa[w] = sa[j];
							sb[w] = sb[j];
							w++;
						}
						sp = w;
						pos = at;
						pc = code[look * 3 + 2];
					} else {
						// the negative lookahead's body matched: undo it, then fail
						while (sp > b + 1) {
							sp--;
							if (sk[sp] === UNDO) regs[sa[sp]] = sb[sp];
						}
						sp = b;
						ok = false;
					}
					break;
				}
				case Op.PSET:
					set_reg(p.pbase + code[pc * 3 + 1], pos);
					pc++;
					break;
				case Op.PCHECK:
					// an iteration that matched nothing ends the loop (ES RepeatMatcher)
					if (regs[p.pbase + code[pc * 3 + 1]] === pos) ok = false;
					else pc++;
					break;
			}
			if (ok) continue;
			// backtrack
			while (true) {
				if (sp === 0) break run;
				sp--;
				const k = sk[sp];
				if (k === UNDO) {
					regs[sa[sp]] = sb[sp];
					continue;
				}
				if (k === CHOICE) {
					steps++;
					pc = sa[sp];
					pos = sb[sp];
					break;
				}
				// a barrier: the lookahead's body failed
				if (code[sa[sp] * 3 + 1] === 1) {
					steps++;
					pos = sb[sp];
					pc = code[sa[sp] * 3 + 2];
					break;
				}
			}
		}
		if (uni && q < n) {
			const c = s[q];
			if (c >= 0xd800 && c <= 0xdbff && q + 1 < n && s[q + 1] >= 0xdc00 && s[q + 1] <= 0xdfff) q++;
		}
	}
	return { index: -1, end: -1, steps, over: false };
}

// ---------------------------------------------------------------- the probe

/** One regex the case ran, by the counted function that ran it. */
export interface RegexUse {
	source: string;
	flags: string;
	/** `module > function path`, the innermost counted function when the match ran. */
	fn: string;
	calls: number;
	/** Machine instructions over all calls, and past the allowance (the extra work, unpriced). */
	vm: number;
	backtracking: number;
	/** Extra work in steps. */
	extra: number;
	/** The most instructions one call took, and the characters it had to search. */
	worst_vm: number;
	worst_size: number;
}

export interface RegexRun {
	/** Extra work of the run in steps (backtracking past the linear allowance). */
	extra: number;
	/** Matches the machine ran, and those it left to V8 (not modeled, or it disagreed before). */
	modeled: number;
	skipped: number;
	/** A match went past its budget (the real regex was never run). */
	runaway: RegexRunawayError | null;
	/** The model's budget for the run ran out: later matches were left to V8. */
	partial: boolean;
	uses: RegexUse[];
}

export interface RegexStats {
	/** Patterns the machine cannot model (lookbehind, property escapes, the v flag). */
	unsupported: string[];
	/** Patterns where the machine and V8 disagreed on a match: left to V8 since. */
	mismatched: string[];
}

/** Budget of one match: generous for a linear pass over a long input, small for a short one. */
function call_budget(chars: number, program: number): number {
	return Math.min(2e7, 1e5 + 64 * program * (chars + 1));
}

/** One match the machine ran: where it found the match, and what it charged. */
interface Call {
	key: string;
	index: number;
	end: number;
	extra: number;
	use: RegexUse;
}

const RUN_BUDGET = 1e8;
const MY_URL = import.meta.url;

function caller_url(fn: Function): string | null {
	if (!capture_stack) return null;
	const E = Error as unknown as { prepareStackTrace?: unknown; stackTraceLimit: number };
	const prepare = E.prepareStackTrace;
	const limit = E.stackTraceLimit;
	E.prepareStackTrace = (_e: Error, frames: Array<{ getFileName(): string | null }>) => frames;
	E.stackTraceLimit = 1;
	try {
		const holder: { stack?: Array<{ getFileName(): string | null }> } = {};
		capture_stack(holder, fn);
		const frames = holder.stack;
		return frames && frames.length > 0 ? (frames[0].getFileName() ?? null) : null;
	} finally {
		E.prepareStackTrace = prepare;
		E.stackTraceLimit = limit;
	}
}

export class RegexModel {
	rt: Runtime;
	#programs = new Map<string, Program | null>();
	#bad = new Set<string>();
	#unsupported = new Set<string>();
	#price: number;
	#on = false;
	#run: RegexRun = RegexModel.empty();
	#vm = 0;
	#uses = new Map<string, RegexUse>();
	#strings: Array<{ s: string; u: Uint16Array }> = [];
	#installed: { prev: Function; wrapper: Function } | null = null;

	constructor(rt: Runtime) {
		this.rt = rt;
		this.#price = rt.prices.builtins['RegExp.prototype.exec']?.k ?? 0.1875;
	}

	static empty(): RegexRun {
		return { extra: 0, modeled: 0, skipped: 0, runaway: null, partial: false, uses: [] };
	}

	stats(): RegexStats {
		return { unsupported: [...this.#unsupported].sort(), mismatched: [...this.#bad].sort() };
	}

	/**
	 * The case with the model around its function: installed when the function starts, inside the
	 * measuring window, over the priced wrapper the window put on `exec`.
	 */
	wrap(c: BenchCase): BenchCase {
		return {
			...c,
			fn: (ctx: unknown) => {
				this.install();
				return c.fn(ctx);
			}
		};
	}

	begin(): void {
		this.#run = RegexModel.empty();
		this.#vm = 0;
		this.#uses = new Map();
		this.#on = true;
	}

	end(): RegexRun {
		this.#on = false;
		this.uninstall();
		const run = this.#run;
		run.uses = [...this.#uses.values()].sort((a, b) => b.extra - a.extra || b.vm - a.vm);
		this.#strings = [];
		return run;
	}

	install(): void {
		const proto = RegExp.prototype as unknown as { exec: Function };
		const prev = proto.exec;
		if (this.#installed && prev === this.#installed.wrapper) return;
		const rt = this.rt;
		const on = (): boolean => this.#on;
		const model = (re: RegExp, s: string): Call | null => this.#model(re, s);
		const check = (call: Call, result: RegExpExecArray | null): void => this.#check(call, result);
		const wrapper = function exec(this: unknown, arg: unknown): unknown {
			if (!on() || rt.depth === 0 || !(this instanceof RegExp) || typeof arg !== 'string')
				return reflect_apply(prev, this, [arg]);
			const site = rt.site;
			const rx = rt.rx;
			const rx_url = rt.rx_url;
			rt.site = -1;
			let call: Call | null;
			try {
				call = model(this, arg);
			} finally {
				rt.site = site;
				rt.rx = rx;
				rt.rx_url = rx_url;
			}
			// The priced wrapper below checks who called it, for a site whose receiver it could not
			// see: the caller is this wrapper's caller, not this file.
			if (rx === ANY_RECEIVER && site >= 0 && caller_url(wrapper) === rx_url) rt.rx_url = MY_URL;
			const result = reflect_apply(prev, this, [arg]) as RegExpExecArray | null;
			rt.rx_url = rx_url;
			if (call) check(call, result);
			return result;
		};
		Object.defineProperty(wrapper, 'name', { value: 'exec' });
		Object.defineProperty(wrapper, 'length', { value: 1 });
		proto.exec = wrapper;
		this.#installed = { prev, wrapper };
	}

	/** V8's answer for a match the machine ran: where they disagree, the pattern is left to V8. */
	#check(call: Call, result: RegExpExecArray | null): void {
		const index = result === null ? -1 : result.index;
		const end = result === null ? -1 : result.index + result[0].length;
		if (index === call.index && end === call.end) return;
		this.#bad.add(call.key);
		this.#run.extra -= call.extra;
		call.use.extra -= call.extra;
	}

	uninstall(): void {
		const proto = RegExp.prototype as unknown as { exec: Function };
		if (this.#installed && proto.exec === this.#installed.wrapper)
			proto.exec = this.#installed.prev;
		this.#installed = null;
	}

	#units(s: string): Uint16Array {
		const cache = this.#strings;
		for (let i = 0; i < cache.length; i++) if (cache[i].s === s) return cache[i].u;
		const b = buffer_from(s, 'utf16le');
		const u = new Uint16Array(b.buffer, b.byteOffset, s.length);
		if (cache.length >= 4) cache.shift();
		cache.push({ s, u });
		return u;
	}

	#model(re: RegExp, s: string): Call | null {
		const run = this.#run;
		const flags = re.flags;
		const source = re.source;
		const key = `/${source}/${flags}`;
		if (run.partial || this.#bad.has(key)) {
			run.skipped++;
			return null;
		}
		let p = this.#programs.get(key);
		if (p === undefined) {
			p = compile(source, flags);
			this.#programs.set(key, p);
			if (!p) this.#unsupported.add(key);
		}
		if (!p) {
			run.skipped++;
			return null;
		}
		const n = s.length;
		const sticky = re.sticky;
		const start = re.global || sticky ? Math.max(0, Math.floor(Number(re.lastIndex)) || 0) : 0;
		if (start > n) return null;
		const chars = n - start;
		const budget = Math.min(call_budget(chars, p.length), RUN_BUDGET - this.#vm);
		const r = run_machine(p, this.#units(s), n, start, sticky, budget);
		this.#vm += r.steps;
		run.modeled++;
		const use = this.#use(key, source, flags);
		use.calls++;
		use.vm += r.steps;
		if (r.steps > use.worst_vm) {
			use.worst_vm = r.steps;
			use.worst_size = chars;
		}
		if (r.over) {
			if (budget < call_budget(chars, p.length)) {
				// the run's budget ran out, not this match's: the rest is left to V8
				run.partial = true;
				return null;
			}
			const e = new RegexRunawayError(source, flags, chars, r.steps);
			run.runaway ??= e;
			throw e;
		}
		const walked = (r.index >= 0 ? r.end : n) - start;
		const allowance = p.length * (walked + 1);
		const back = Math.max(0, r.steps - allowance);
		const extra = back * this.#price;
		use.backtracking += back;
		use.extra += extra;
		run.extra += extra;
		return { key, index: r.index, end: r.end, extra, use };
	}

	#use(key: string, source: string, flags: string): RegexUse {
		const rt = this.rt;
		const fid = rt.depth > 0 ? rt.stack[rt.depth - 1] : -1;
		const k = `${fid}\u0000${key}`;
		let u = this.#uses.get(k);
		if (!u) {
			let fn = '<uncounted>';
			if (fid >= 0) {
				const m = rt.modules[rt.fn_module[fid]];
				const f = m.meta.functions[fid - m.f];
				fn = `${m.meta.id} > ${f.path} (line ${f.line})`;
			}
			u = {
				source,
				flags,
				fn,
				calls: 0,
				vm: 0,
				backtracking: 0,
				extra: 0,
				worst_vm: 0,
				worst_size: 0
			};
			this.#uses.set(k, u);
		}
		return u;
	}
}
