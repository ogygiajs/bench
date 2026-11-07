import { createHash } from 'node:crypto';
import { parseSync } from 'oxc-parser';

/*
 * The text of a module the way counting sees it: what can change a count, and nothing else.
 *
 *   comments        gone: the transform never counts them (one with a complexity contract,
 *                   `@heisenbench ...`, stays: growth reads the contract from it)
 *   whitespace      every run between two tokens is one space, or one newline when the run (with
 *                   the comments in it) breaks a line: automatic semicolon insertion reads line
 *                   breaks, so a newline never becomes a space or the other way round
 *   literals        strings, template text, regular expressions and JSX text stay byte for byte
 *   skipped bodies  the body of each span in `blank` (a function the case never ran) is one
 *                   placeholder: what it says cannot change what the case did
 *
 * Two texts that normalize the same run the same, block for block. Only their lines can differ
 * (a comment line above moves the code below it), so `table` keeps where each source line starts
 * in the normalized text: a count taken on one is moved onto the other's lines (cache/index.ts).
 */

/** A body left out of the key. A NUL in the source itself is written as two (`ESCAPED_NUL`). */
const PLACEHOLDER = '\u0000.';
const ESCAPED_NUL = '\u0000\u0000';
/** contracts/declare.ts TAG: a comment that carries it declares something, so it is kept. */
const CONTRACT_TAG = '@heisenbench';

export interface LineTable {
	/** Source lines (1-based, ascending) that put at least one character into the text. */
	lines: number[];
	/** Offset in the normalized text of each one's first character. */
	offsets: number[];
}

export interface Normalized {
	text: string;
	hash: string;
	table: LineTable;
}

interface Span {
	start: number;
	end: number;
	kind: 'comment' | 'literal' | 'blank';
	/** A comment that breaks a line. */
	nl?: boolean;
}

type Lang = 'js' | 'jsx' | 'ts' | 'tsx';

export function lang_of(filename: string): Lang {
	if (filename.endsWith('.tsx')) return 'tsx';
	if (/\.[mc]?ts$/.test(filename)) return 'ts';
	if (filename.endsWith('.jsx')) return 'jsx';
	return 'js';
}

/** Characters that keep their bytes: the text inside literals. */
function literal_spans(program: unknown, out: Span[]): void {
	const stack: unknown[] = [program];
	while (stack.length > 0) {
		const v = stack.pop();
		if (v === null || typeof v !== 'object') continue;
		if (Array.isArray(v)) {
			for (const x of v) stack.push(x);
			continue;
		}
		const n = v as { type?: unknown; start?: unknown; end?: unknown; [k: string]: unknown };
		const t = n.type;
		if (
			typeof n.start === 'number' &&
			typeof n.end === 'number' &&
			((t === 'Literal' && (typeof n.value === 'string' || n.regex !== undefined)) ||
				t === 'TemplateElement' ||
				t === 'JSXText')
		) {
			out.push({ start: n.start, end: n.end, kind: 'literal' });
			continue;
		}
		for (const k in n) {
			if (k === 'parent') continue;
			const x = n[k];
			if (x !== null && typeof x === 'object') stack.push(x);
		}
	}
}

/** A line terminator: LF, CR, LINE SEPARATOR, PARAGRAPH SEPARATOR. */
function breaks(c: number): boolean {
	return c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
}

const OTHER_SPACE = /\s/;

/** JavaScript white space or a line terminator. */
function is_space(code: string, i: number): boolean {
	const c = code.charCodeAt(i);
	if (c === 32 || (c >= 9 && c <= 13)) return true;
	return c > 127 && OTHER_SPACE.test(code[i]);
}

function has_break(code: string, from: number, to: number): boolean {
	for (let i = from; i < to; i++) if (breaks(code.charCodeAt(i))) return true;
	return false;
}

/**
 * `code` normalized, with the spans in `blank` (start, end; they may nest, the outermost wins)
 * replaced by the placeholder. Null when it does not parse.
 */
export function normalize(
	code: string,
	filename: string,
	blank: ReadonlyArray<readonly [number, number]> = []
): Normalized | null {
	let parsed;
	try {
		parsed = parseSync(filename, code, { sourceType: 'module', lang: lang_of(filename) });
	} catch {
		return null;
	}
	if (parsed.errors.length > 0) return null;

	// the outermost blanks; everything inside one is gone
	const blanks = blank
		.map(([s, e]) => ({ start: s, end: e }))
		.sort((a, b) => a.start - b.start || b.end - a.end);
	const outer: Span[] = [];
	for (const b of blanks) {
		const last = outer[outer.length - 1];
		if (last && b.start < last.end) continue;
		outer.push({ start: b.start, end: b.end, kind: 'blank' });
	}
	const inside_blank = (s: Span): boolean => {
		let lo = 0;
		let hi = outer.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const b = outer[mid];
			if (s.end <= b.start) hi = mid - 1;
			else if (s.start >= b.end) lo = mid + 1;
			else return true;
		}
		return false;
	};
	const spans: Span[] = [...outer];
	for (const c of parsed.comments) {
		// a complexity contract (`@heisenbench linear in rows`) is read from its comment: it stays
		if (code.slice(c.start, c.end).includes(CONTRACT_TAG)) {
			const s: Span = { start: c.start, end: c.end, kind: 'literal' };
			if (!inside_blank(s)) spans.push(s);
			continue;
		}
		const s: Span = {
			start: c.start,
			end: c.end,
			kind: 'comment',
			nl: has_break(code, c.start, c.end)
		};
		if (!inside_blank(s)) spans.push(s);
	}
	const literals: Span[] = [];
	literal_spans(parsed.program, literals);
	for (const s of literals) if (!inside_blank(s)) spans.push(s);
	spans.sort((a, b) => a.start - b.start);

	const out: string[] = [];
	let length = 0;
	const lines: number[] = [];
	const offsets: number[] = [];
	let line = 1;
	/** Whitespace waiting to be written: none, a space, or a newline. */
	let pending: 0 | 1 | 2 = 0;

	const mark = (): void => {
		if (lines.length === 0 || lines[lines.length - 1] !== line) {
			lines.push(line);
			offsets.push(length);
		}
	};
	const emit = (s: string): void => {
		out.push(s);
		length += s.length;
	};
	const flush = (): void => {
		if (pending !== 0 && length > 0) emit(pending === 2 ? '\n' : ' ');
		pending = 0;
	};
	const count_lines = (from: number, to: number): void => {
		for (let i = from; i < to; i++) if (code.charCodeAt(i) === 10) line++;
	};
	const char = (i: number): string => (code.charCodeAt(i) === 0 ? ESCAPED_NUL : code[i]);

	let pos = 0;
	const code_until = (to: number): void => {
		for (; pos < to; pos++) {
			if (is_space(code, pos)) {
				const c = code.charCodeAt(pos);
				if (breaks(c)) pending = 2;
				else if (pending === 0) pending = 1;
				if (c === 10) line++;
				continue;
			}
			flush();
			mark();
			emit(char(pos));
		}
	};

	for (const s of spans) {
		if (s.start < pos) continue;
		code_until(s.start);
		if (s.kind === 'comment') {
			if (s.nl) pending = 2;
			else if (pending === 0) pending = 1;
			count_lines(s.start, s.end);
		} else if (s.kind === 'blank') {
			flush();
			mark();
			emit(PLACEHOLDER);
			count_lines(s.start, s.end);
		} else {
			flush();
			for (let i = s.start; i < s.end; i++) {
				if (!is_space(code, i)) mark();
				emit(char(i));
				if (code.charCodeAt(i) === 10) line++;
			}
		}
		pos = s.end;
	}
	code_until(code.length);

	const text = out.join('');
	return { text, hash: sha256(text), table: { lines, offsets } };
}

export function sha256(s: string | Uint8Array): string {
	return createHash('sha256').update(s).digest('hex');
}

/** The source line that holds normalized offset `offset` (in the table of the same text). */
export function line_at(table: LineTable, offset: number): number | null {
	const { lines, offsets } = table;
	let lo = 0;
	let hi = offsets.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (offsets[mid] <= offset) {
			found = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return found === -1 ? null : lines[found];
}

/** The normalized offset of the first character of source line `line`, or null when it has none. */
export function offset_of(table: LineTable, line: number): number | null {
	const { lines, offsets } = table;
	let lo = 0;
	let hi = lines.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (lines[mid] === line) return offsets[mid];
		if (lines[mid] < line) lo = mid + 1;
		else hi = mid - 1;
	}
	return null;
}
