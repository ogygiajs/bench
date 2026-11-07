/*
 * Grammars for the worst-case search: how a string input is built, so the search can grow and
 * change it while it stays valid. A grammar cuts a string into tokens (an opening piece, a closing
 * piece, or a leaf); the tokens make a tree of nodes, each a span of the string (an element, a
 * bracket, an emphasis, a path segment). The search then edits whole nodes: duplicate one, nest one
 * in itself, swap two siblings, repeat one, grow a run inside a leaf, or insert a near-miss (a
 * piece that opens a construct and never closes it).
 *
 * Built in: `html` (markup, Svelte blocks included), `markdown`, `url` (paths, route patterns,
 * query strings), `js` (expressions and code), `json` and `text`. A bench case can declare its
 * own: `bench(name, fn, { setup, grammar })` with a built-in name, a grammar object, or a map from
 * input property paths (`'source'`, `'page.body'`) to either. Undeclared strings get the built-in
 * grammar their text looks like (`infer_grammar`).
 */

export type TokenKind = 'leaf' | 'open' | 'close';

export interface Token {
	kind: TokenKind;
	/** Opening and closing tokens pair up by key (`div`, `(`, `**`). */
	key: string;
	start: number;
	end: number;
}

export interface Grammar {
	name: string;
	/** The string's tokens, in order, covering it without gaps. */
	tokens(s: string): Token[];
	/** Valid pieces worth inserting between two nodes (a new element, a list item). */
	atoms: readonly string[];
	/** Pieces that open a construct and leave it open, or are one character off a valid one. */
	near: readonly string[];
	/** Ways to wrap a node one level deeper: [before, after]. */
	wraps: ReadonlyArray<readonly [string, string]>;
}

export type GrammarName = 'html' | 'markdown' | 'url' | 'js' | 'json' | 'text';

/** What a bench case may declare: one grammar for its strings, or one per input path. */
export type GrammarOption = GrammarName | Grammar | Record<string, GrammarName | Grammar>;

export interface Node {
	key: string;
	start: number;
	end: number;
	/** Where the inside starts and ends (the whole span for a leaf). */
	inner_start: number;
	inner_end: number;
	/** An opening and a closing token that pair up. */
	pair: boolean;
	depth: number;
	kids: Node[];
	parent: Node | null;
}

/** Near-misses every grammar shares: characters that end or confuse a scanner. */
export const NEAR_COMMON = [
	'<',
	'{',
	'`',
	'"',
	"'",
	'\\',
	'\r\n',
	'\r',
	' ',
	' ',
	'\u0000',
	'😀',
	'\ud800',
	'﻿',
	'é',
	'\t'
];

/** The tree of a string's tokens. Unpaired closing tokens are leaves; unclosed openings end where their content does. */
export function parse(g: Grammar, s: string): Node {
	const root: Node = {
		key: '',
		start: 0,
		end: s.length,
		inner_start: 0,
		inner_end: s.length,
		pair: true,
		depth: 0,
		kids: [],
		parent: null
	};
	const stack: Node[] = [root];
	const close_open = (n: Node, at: number): void => {
		n.inner_end = at;
		n.end = at;
	};
	for (const t of g.tokens(s)) {
		const top = stack[stack.length - 1];
		if (t.kind === 'open') {
			const n: Node = {
				key: t.key,
				start: t.start,
				end: t.end,
				inner_start: t.end,
				inner_end: t.end,
				pair: false,
				depth: stack.length,
				kids: [],
				parent: top
			};
			top.kids.push(n);
			stack.push(n);
			continue;
		}
		if (t.kind === 'close') {
			let j = stack.length - 1;
			while (j > 0 && stack[j].key !== t.key) j--;
			if (j > 0) {
				while (stack.length - 1 > j) close_open(stack.pop()!, t.start);
				const n = stack.pop()!;
				n.inner_end = t.start;
				n.end = t.end;
				n.pair = true;
				continue;
			}
		}
		top.kids.push({
			key: t.kind === 'leaf' ? t.key : `/${t.key}`,
			start: t.start,
			end: t.end,
			inner_start: t.start,
			inner_end: t.end,
			pair: false,
			depth: stack.length,
			kids: [],
			parent: top
		});
	}
	while (stack.length > 1) close_open(stack.pop()!, s.length);
	return root;
}

/** Every node under the root, depth first (at most `max`). */
export function nodes_of(root: Node, max = 20_000): Node[] {
	const out: Node[] = [];
	const todo: Node[] = [...root.kids].reverse();
	while (todo.length > 0 && out.length < max) {
		const n = todo.pop()!;
		out.push(n);
		for (let i = n.kids.length - 1; i >= 0; i--) todo.push(n.kids[i]);
	}
	return out;
}

// ---------------------------------------------------------------- scanning helpers

function is_name(c: number): boolean {
	return (
		(c >= 48 && c <= 57) ||
		(c >= 65 && c <= 90) ||
		(c >= 97 && c <= 122) ||
		c === 95 ||
		c === 45 ||
		c === 58 ||
		c === 46 ||
		c === 36 ||
		c > 127
	);
}

function is_word(c: number): boolean {
	return (
		(c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c > 127
	);
}

function is_space(c: number): boolean {
	return c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
}

/** End of a run of characters that pass `test`, from `i`. */
function run_end(s: string, i: number, test: (c: number) => boolean): number {
	while (i < s.length && test(s.charCodeAt(i))) i++;
	return i;
}

/** End of a quoted string starting at `i` (the quote), backslash escapes included. */
function quoted_end(s: string, i: number, escapes = true): number {
	const q = s.charCodeAt(i);
	let j = i + 1;
	while (j < s.length) {
		const c = s.charCodeAt(j);
		if (escapes && c === 92) j += 2;
		else if (c === q) return j + 1;
		else if (c === 10 && q !== 96) return j;
		else j++;
	}
	return s.length;
}

const VOID = new Set([
	'area',
	'base',
	'br',
	'col',
	'embed',
	'hr',
	'img',
	'input',
	'link',
	'meta',
	'source',
	'track',
	'wbr',
	'!doctype'
]);
const RAW = new Set(['script', 'style', 'textarea', 'title']);

/** An HTML tag at `i` (`<`): [end, name, closing, self-closing], or null when it is not one. */
function tag_at(s: string, i: number): [number, string, boolean, boolean] | null {
	let j = i + 1;
	const closing = s.charCodeAt(j) === 47;
	if (closing) j++;
	const name_start = j;
	if (s.charCodeAt(j) === 33) j++;
	const first = s.charCodeAt(j);
	if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122))) return null;
	j = run_end(s, j, is_name);
	const name = s.slice(name_start, j).toLowerCase();
	while (j < s.length) {
		const c = s.charCodeAt(j);
		if (c === 62) return [j + 1, name, closing, s.charCodeAt(j - 1) === 47];
		if (c === 34 || c === 39) j = quoted_end(s, j, false);
		else if (c === 123) j = brace_end(s, j);
		else if (c === 60) return null;
		else j++;
	}
	return null;
}

/** End of a `{...}` expression at `i`, nested braces and strings included. */
function brace_end(s: string, i: number): number {
	let depth = 0;
	let j = i;
	while (j < s.length) {
		const c = s.charCodeAt(j);
		if (c === 34 || c === 39 || c === 96) {
			j = quoted_end(s, j);
			continue;
		}
		if (c === 123) depth++;
		else if (c === 125 && --depth === 0) return j + 1;
		j++;
	}
	return s.length;
}

function tok(kind: TokenKind, key: string, start: number, end: number): Token {
	return { kind, key, start, end };
}

// ---------------------------------------------------------------- html

function html_tokens(s: string): Token[] {
	const out: Token[] = [];
	let i = 0;
	const n = s.length;
	let lower: string | undefined;
	while (i < n) {
		const c = s.charCodeAt(i);
		if (c === 60) {
			if (s.startsWith('<!--', i)) {
				const e = s.indexOf('-->', i + 4);
				const end = e < 0 ? n : e + 3;
				out.push(tok('leaf', 'comment', i, end));
				i = end;
				continue;
			}
			const t = tag_at(s, i);
			if (t) {
				const [end, name, closing, self] = t;
				if (closing) out.push(tok('close', name, i, end));
				else if (self || VOID.has(name)) out.push(tok('leaf', name, i, end));
				else {
					out.push(tok('open', name, i, end));
					if (RAW.has(name)) {
						lower ??= s.toLowerCase();
						let e = lower.indexOf(`</${name}`, end);
						if (e < 0) e = n;
						if (e > end) out.push(tok('leaf', 'raw', end, e));
						i = e;
						continue;
					}
				}
				i = end;
				continue;
			}
		}
		if (c === 123) {
			const end = brace_end(s, i);
			const k = s.charCodeAt(i + 1);
			const name = s.slice(i + 2, run_end(s, i + 2, is_word));
			if (k === 35) out.push(tok('open', `{${name}`, i, end));
			else if (k === 47) out.push(tok('close', `{${name}`, i, end));
			else out.push(tok('leaf', '{}', i, end));
			i = end;
			continue;
		}
		let j = i + 1;
		while (j < n) {
			const d = s.charCodeAt(j);
			if (d === 60 || d === 123) break;
			j++;
		}
		out.push(tok('leaf', 'text', i, j));
		i = j;
	}
	return out;
}

export const html: Grammar = {
	name: 'html',
	tokens: html_tokens,
	atoms: [
		'<div></div>',
		'<p>text</p>',
		'<span class="a">x</span>',
		'<br>',
		'<!-- c -->',
		'<img src="a.png" alt="">',
		'{x}',
		'{#if a}b{/if}',
		'{#each xs as x}{x}{/each}',
		'<a href="/x">l</a>',
		'&amp;',
		'<input value="{v}">'
	],
	near: [
		'<',
		'</',
		'<div',
		'<a href="',
		'<!--',
		'{',
		'{#if',
		'{/',
		'"',
		'>',
		'&',
		'&#',
		'<script>',
		'</div>',
		'<![CDATA['
	],
	wraps: [
		['<div>', '</div>'],
		['<span>', '</span>'],
		['<p>', '</p>'],
		['<b><i>', '</i></b>'],
		['{#if x}', '{/if}'],
		['{#each xs as x}', '{/each}'],
		['<!-- ', ' -->']
	]
};

// ---------------------------------------------------------------- markdown

/** Inline delimiters that open and close the same way. */
const MD_TOGGLES = ['**', '__', '~~', '*', '_', '`'];

function md_tokens(s: string): Token[] {
	const out: Token[] = [];
	const open = new Set<string>();
	const n = s.length;
	let i = 0;
	let line_start = true;
	let fence = false;
	while (i < n) {
		const c = s.charCodeAt(i);
		if (c === 10) {
			out.push(tok('leaf', 'nl', i, i + 1));
			i++;
			line_start = true;
			open.clear();
			continue;
		}
		if (line_start) {
			line_start = false;
			if (s.startsWith('```', i) || s.startsWith('~~~', i)) {
				const e = s.indexOf('\n', i);
				const end = e < 0 ? n : e;
				out.push(tok(fence ? 'close' : 'open', 'fence', i, end));
				fence = !fence;
				i = end;
				continue;
			}
			if (fence) {
				const e = s.indexOf('\n', i);
				const end = e < 0 ? n : e;
				out.push(tok('leaf', 'code', i, end));
				i = end;
				continue;
			}
			const m = /^(?: {0,3}#{1,6} | {0,3}>+ ?|\s*(?:[-*+]|\d{1,9}[.)]) +|\s*\|)/.exec(
				s.slice(i, i + 64)
			);
			if (m) {
				out.push(tok('leaf', 'prefix', i, i + m[0].length));
				i += m[0].length;
				continue;
			}
		}
		if (fence) {
			const e = s.indexOf('\n', i);
			const end = e < 0 ? n : e;
			out.push(tok('leaf', 'code', i, end));
			i = end;
			continue;
		}
		if (c === 92 && i + 1 < n) {
			out.push(tok('leaf', 'escape', i, i + 2));
			i += 2;
			continue;
		}
		const toggle = MD_TOGGLES.find((t) => s.startsWith(t, i));
		if (toggle) {
			out.push(tok(open.has(toggle) ? 'close' : 'open', toggle, i, i + toggle.length));
			if (open.has(toggle)) open.delete(toggle);
			else open.add(toggle);
			i += toggle.length;
			continue;
		}
		if (c === 91 || c === 40) {
			out.push(tok('open', s[i], i, i + 1));
			i++;
			continue;
		}
		if (c === 93) {
			out.push(tok('close', '[', i, i + 1));
			i++;
			continue;
		}
		if (c === 41) {
			out.push(tok('close', '(', i, i + 1));
			i++;
			continue;
		}
		if (c === 60) {
			const t = tag_at(s, i);
			if (t) {
				const [end, name, closing, self] = t;
				out.push(tok(closing ? 'close' : self || VOID.has(name) ? 'leaf' : 'open', name, i, end));
				i = end;
				continue;
			}
		}
		let j = i + 1;
		while (j < n) {
			const d = s.charCodeAt(j);
			if (d === 10 || d === 92 || d === 42 || d === 95 || d === 96 || d === 126) break;
			if (d === 91 || d === 93 || d === 40 || d === 41 || d === 60) break;
			j++;
		}
		out.push(tok('leaf', 'text', i, j));
		i = j;
	}
	return out;
}

export const markdown: Grammar = {
	name: 'markdown',
	tokens: md_tokens,
	atoms: [
		'\n\n',
		'\n- item\n',
		'\n# Heading\n',
		'[a](/b)',
		'`code`',
		'**b**',
		'*i*',
		'\n```js\nx\n```\n',
		'\n> quote\n',
		'<div>x</div>',
		'\n| a | b |\n|---|---|\n| 1 | 2 |\n',
		'![i](/i.png)',
		'\n1. one\n'
	],
	near: [
		'[',
		'](',
		'`',
		'**',
		'*',
		'_',
		'<',
		'```',
		'\\',
		'![',
		'&',
		'|',
		':::',
		'[^',
		'\n#',
		'\n>'
	],
	wraps: [
		['**', '**'],
		['*', '*'],
		['_', '_'],
		['`', '`'],
		['[', '](/x)'],
		['~~', '~~'],
		['<em>', '</em>'],
		['> ', ''],
		['- ', '']
	]
};

// ---------------------------------------------------------------- url

function url_tokens(s: string): Token[] {
	const out: Token[] = [];
	const n = s.length;
	let i = 0;
	while (i < n) {
		const c = s.charCodeAt(i);
		if (c === 91 || c === 40) out.push(tok('open', s[i], i, i + 1));
		else if (c === 93) out.push(tok('close', '[', i, i + 1));
		else if (c === 41) out.push(tok('close', '(', i, i + 1));
		else if (c === 37 && /^%[0-9a-fA-F]{2}/.test(s.slice(i, i + 3))) {
			out.push(tok('leaf', 'escape', i, i + 3));
			i += 3;
			continue;
		} else if (is_word(c)) {
			const end = run_end(s, i, is_word);
			out.push(tok('leaf', 'word', i, end));
			i = end;
			continue;
		} else out.push(tok('leaf', s[i], i, i + 1));
		i++;
	}
	return out;
}

export const url: Grammar = {
	name: 'url',
	tokens: url_tokens,
	atoms: [
		'/a',
		'/[id]',
		'/[...rest]',
		'/[[opt]]',
		'/(group)',
		'?a=1',
		'&b=2',
		'#h',
		'/%20',
		'/.',
		'/x.json',
		'/-'
	],
	near: [
		'[',
		']',
		'[[',
		'[...',
		'(',
		'%',
		'%2',
		'//',
		'/../',
		'?',
		'#',
		'\\',
		':',
		'@',
		'*',
		'.',
		'%00',
		'='
	],
	wraps: [
		['[', ']'],
		['(', ')'],
		['[[', ']]'],
		['[...', ']']
	]
};

// ---------------------------------------------------------------- js

const JS_OPEN: Record<number, string> = { 40: '(', 91: '[', 123: '{' };
const JS_CLOSE: Record<number, string> = { 41: '(', 93: '[', 125: '{' };

function js_tokens(s: string): Token[] {
	const out: Token[] = [];
	const n = s.length;
	// open templates: the brace depth of each `${` inside one
	const tpl: number[] = [];
	let i = 0;
	let in_tpl = false;
	while (i < n) {
		const c = s.charCodeAt(i);
		if (in_tpl) {
			if (c === 96) {
				out.push(tok('close', '`', i, i + 1));
				in_tpl = false;
				i++;
			} else if (c === 36 && s.charCodeAt(i + 1) === 123) {
				out.push(tok('open', '${', i, i + 2));
				tpl.push(0);
				in_tpl = false;
				i += 2;
			} else {
				let j = i;
				while (j < n) {
					const d = s.charCodeAt(j);
					if (d === 92) j += 2;
					else if (d === 96 || (d === 36 && s.charCodeAt(j + 1) === 123)) break;
					else j++;
				}
				out.push(tok('leaf', 'text', i, Math.min(j, n)));
				i = Math.min(j, n);
			}
			continue;
		}
		if (c === 96) {
			out.push(tok('open', '`', i, i + 1));
			in_tpl = true;
			i++;
			continue;
		}
		if (c === 34 || c === 39) {
			const end = quoted_end(s, i);
			out.push(tok('leaf', 'string', i, end));
			i = end;
			continue;
		}
		if (c === 47 && s.charCodeAt(i + 1) === 47) {
			const e = s.indexOf('\n', i);
			const end = e < 0 ? n : e;
			out.push(tok('leaf', 'comment', i, end));
			i = end;
			continue;
		}
		if (c === 47 && s.charCodeAt(i + 1) === 42) {
			const e = s.indexOf('*/', i + 2);
			const end = e < 0 ? n : e + 2;
			out.push(tok('leaf', 'comment', i, end));
			i = end;
			continue;
		}
		if (JS_OPEN[c]) {
			if (c === 123 && tpl.length > 0) tpl[tpl.length - 1]++;
			out.push(tok('open', JS_OPEN[c], i, i + 1));
			i++;
			continue;
		}
		if (JS_CLOSE[c]) {
			if (c === 125 && tpl.length > 0 && tpl[tpl.length - 1] === 0) {
				tpl.pop();
				out.push(tok('close', '${', i, i + 1));
				in_tpl = true;
				i++;
				continue;
			}
			if (c === 125 && tpl.length > 0) tpl[tpl.length - 1]--;
			out.push(tok('close', JS_CLOSE[c], i, i + 1));
			i++;
			continue;
		}
		if (is_word(c) || c === 36) {
			const end = run_end(s, i, (d) => is_word(d) || d === 36);
			out.push(tok('leaf', 'word', i, end));
			i = end;
			continue;
		}
		if (is_space(c)) {
			const end = run_end(s, i, is_space);
			out.push(tok('leaf', 'space', i, end));
			i = end;
			continue;
		}
		out.push(tok('leaf', 'punct', i, i + 1));
		i++;
	}
	return out;
}

export const js: Grammar = {
	name: 'js',
	tokens: js_tokens,
	atoms: [
		'a',
		'1',
		' + b',
		', c',
		'.d',
		'?.e',
		'[0]',
		'()',
		' => x',
		'`t${u}`',
		"'s'",
		' ? f : g',
		'{ h }'
	],
	near: ['(', '[', '{', '`', '${', '"', "'", '/*', '//', '\\', '=>', '?.', '...', '<', ' ', '/'],
	wraps: [
		['(', ')'],
		['[', ']'],
		['{ a: ', ' }'],
		['f(', ')'],
		['`${', '}`'],
		['!', ''],
		['x ? ', ' : y']
	]
};

// ---------------------------------------------------------------- json

function json_tokens(s: string): Token[] {
	const out: Token[] = [];
	const n = s.length;
	let i = 0;
	while (i < n) {
		const c = s.charCodeAt(i);
		if (c === 34) {
			const end = quoted_end(s, i);
			out.push(tok('leaf', 'string', i, end));
			i = end;
		} else if (c === 91 || c === 123) {
			out.push(tok('open', s[i], i, i + 1));
			i++;
		} else if (c === 93 || c === 125) {
			out.push(tok('close', c === 93 ? '[' : '{', i, i + 1));
			i++;
		} else {
			let j = i + 1;
			while (j < n) {
				const d = s.charCodeAt(j);
				if (d === 34 || d === 91 || d === 93 || d === 123 || d === 125 || d === 44) break;
				j++;
			}
			if (c === 44) j = i + 1;
			out.push(tok('leaf', c === 44 ? ',' : 'value', i, j));
			i = j;
		}
	}
	return out;
}

export const json: Grammar = {
	name: 'json',
	tokens: json_tokens,
	atoms: [',1', ',"x"', ',[]', ',{}', ',null', ',{"a":[1,{"b":2}]}', ',"\\u00e9"', ',1e308'],
	near: ['"', '\\', '[', '{', ',', ':', '\\u', '\\ud800', '-', '1e'],
	wraps: [
		['[', ']'],
		['{"a":', '}']
	]
};

// ---------------------------------------------------------------- text

function text_tokens(s: string): Token[] {
	const out: Token[] = [];
	const n = s.length;
	let i = 0;
	while (i < n) {
		const c = s.charCodeAt(i);
		let end: number;
		let key: string;
		if (is_word(c)) {
			end = run_end(s, i, is_word);
			key = 'word';
		} else if (c === 10) {
			end = i + 1;
			key = 'nl';
		} else if (is_space(c)) {
			end = run_end(s, i, (d) => is_space(d) && d !== 10);
			key = 'space';
		} else {
			end = i + 1;
			key = 'punct';
		}
		out.push(tok('leaf', key, i, end));
		i = end;
	}
	return out;
}

export const text: Grammar = {
	name: 'text',
	tokens: text_tokens,
	atoms: [' ', 'word', '\n', ', ', '. '],
	near: [],
	wraps: [
		['(', ')'],
		['"', '"']
	]
};

export const GRAMMARS: Record<GrammarName, Grammar> = { html, markdown, url, js, json, text };

function count(s: string, re: RegExp, max = 64): number {
	let n = 0;
	re.lastIndex = 0;
	while (n < max && re.exec(s)) n++;
	return n;
}

/** The built-in grammar a string looks like (`text` when none fits). */
export function infer_grammar(s: string): Grammar {
	const head = s.length > 8192 ? s.slice(0, 8192) : s;
	const t = head.trim();
	if (t.length === 0) return text;
	if ((t[0] === '{' || t[0] === '[') && s.length < 1e6) {
		try {
			JSON.parse(s);
			return json;
		} catch {
			// not JSON
		}
	}
	const tags = count(head, /<\/?[A-Za-z][\w:.-]*[\s>/]/g);
	const blocks = count(head, /\{[#/:@][a-z]/g);
	const md = count(head, /^(?: {0,3}#{1,6} | {0,3}> |\s*[-*+] |\s*\d+\. |```)/gm);
	const inline = count(head, /\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]*\)|`[^`\n]+`/g);
	const code = count(head, /=>|\bfunction\b|\bconst\b|\blet\b|\breturn\b|\bimport\b|[;{}]\s*$/gm);
	const scores: Array<[Grammar, number]> = [
		[html, tags >= 2 ? 4 + Math.min(8, tags / 2) + blocks : 0],
		[markdown, md + inline >= 2 ? 4 + Math.min(8, md + inline / 2) : 0],
		[js, code >= 2 && tags < 2 ? 3 + Math.min(6, code / 2) : 0],
		[url, /^(?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s]*$/i.test(t) && t.length < 8192 ? 9 : 0]
	];
	let best: [Grammar, number] = [text, 1];
	for (const x of scores) if (x[1] > best[1]) best = x;
	return best[0];
}

/** A declared grammar for the string at `path` (dotted, array indices left out), if any. */
export function declared_grammar(
	option: GrammarOption | undefined,
	path: Array<string | number>
): Grammar | null {
	if (option === undefined) return null;
	const resolve = (g: GrammarName | Grammar): Grammar => {
		if (typeof g !== 'string') return g;
		const found = GRAMMARS[g];
		if (!found)
			throw new Error(`heisenbench: unknown grammar '${g}' (${Object.keys(GRAMMARS).join(', ')})`);
		return found;
	};
	if (typeof option === 'string' || typeof (option as Grammar).tokens === 'function')
		return resolve(option as GrammarName | Grammar);
	const key = path.filter((p) => typeof p === 'string').join('.');
	const g = (option as Record<string, GrammarName | Grammar>)[key];
	return g === undefined ? null : resolve(g);
}
