import { execFileSync } from 'node:child_process';

/** One `@@ -old_start,old_count +new_start,new_count @@` hunk of a zero-context diff. */
export interface Hunk {
	old_start: number;
	old_count: number;
	new_start: number;
	new_count: number;
}

export interface FileDiff {
	old_path: string | null;
	new_path: string | null;
	hunks: Hunk[];
}

/**
 * A revision as git must read it: a name or a sha, never an option. Revisions come from report
 * files, and `--output=<file>` in one would make git write that file.
 */
export function check_rev(rev: string): string {
	if (rev === '' || rev.startsWith('-') || !/^[\w./~^@{}-]+$/.test(rev))
		throw new Error(`heisenbench: not a git revision: ${JSON.stringify(rev)}`);
	return rev;
}

/** `git diff -M --unified=0 base head` between two commits, with rename detection. */
export function git_diff(repo: string, base: string, head: string): FileDiff[] {
	const out = execFileSync(
		'git',
		[
			// Paths as they are (no octal escapes for non-ASCII), with the usual a/ b/ prefixes
			// whatever the user's config says.
			'-c',
			'core.quotePath=false',
			'diff',
			'--no-color',
			'--no-ext-diff',
			'--src-prefix=a/',
			'--dst-prefix=b/',
			'-M',
			'--unified=0',
			'--end-of-options',
			check_rev(base),
			check_rev(head),
			'--'
		],
		{ cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }
	);
	return parse_diff(out);
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/** A path git wrote in C quotes (`"a/my \"x\".ts"`, octal bytes for the rest), unquoted. */
function unquote(p: string): string {
	if (!p.startsWith('"') || !p.endsWith('"') || p.length < 2) return p;
	const bytes: number[] = [];
	const s = p.slice(1, -1);
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch !== '\\') {
			for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
			continue;
		}
		const next = s[++i];
		if (next >= '0' && next <= '7') {
			bytes.push(parseInt(s.slice(i, i + 3), 8));
			i += 2;
		} else {
			bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
		}
	}
	return Buffer.from(bytes).toString('utf8');
}

function strip_prefix(raw: string): string | null {
	// git ends a `---`/`+++` path that has a space in it with a tab
	const p = unquote(raw.endsWith('\t') ? raw.slice(0, -1) : raw);
	if (p === '/dev/null') return null;
	if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
	return p;
}

function parse_range(r: string): [number, number] {
	const comma = r.indexOf(',');
	if (comma === -1) return [Number(r), 1];
	return [Number(r.slice(0, comma)), Number(r.slice(comma + 1))];
}

export function parse_diff(text: string): FileDiff[] {
	const files: FileDiff[] = [];
	let cur: FileDiff | null = null;
	for (const line of text.split('\n')) {
		if (line.startsWith('diff --git ')) {
			const rest = line.slice(11);
			const b = rest.indexOf(' b/');
			cur = {
				old_path: strip_prefix(rest.slice(0, b)),
				new_path: strip_prefix(rest.slice(b + 1)),
				hunks: []
			};
			files.push(cur);
		} else if (!cur) {
			continue;
		} else if (line.startsWith('rename from ')) {
			cur.old_path = unquote(line.slice(12));
		} else if (line.startsWith('rename to ')) {
			cur.new_path = unquote(line.slice(10));
		} else if (line.startsWith('--- ')) {
			cur.old_path = strip_prefix(line.slice(4));
		} else if (line.startsWith('+++ ')) {
			cur.new_path = strip_prefix(line.slice(4));
		} else if (line.startsWith('@@ ')) {
			const parts = line.split(' ');
			const [old_start, old_count] = parse_range(parts[1].slice(1));
			const [new_start, new_count] = parse_range(parts[2].slice(1));
			cur.hunks.push({ old_start, old_count, new_start, new_count });
		}
	}
	return files;
}

/** Line mapping of one file between base and PR. */
export class LineMap {
	hunks: Hunk[];

	constructor(hunks: Hunk[]) {
		this.hunks = hunks;
	}

	/** Index of the hunk that changed this base line, or -1. */
	removed_in(old_line: number): number {
		for (let i = 0; i < this.hunks.length; i++) {
			const h = this.hunks[i];
			if (h.old_count > 0 && old_line >= h.old_start && old_line < h.old_start + h.old_count)
				return i;
		}
		return -1;
	}

	/** Index of the hunk that added this PR line, or -1. */
	added_in(new_line: number): number {
		for (let i = 0; i < this.hunks.length; i++) {
			const h = this.hunks[i];
			if (h.new_count > 0 && new_line >= h.new_start && new_line < h.new_start + h.new_count)
				return i;
		}
		return -1;
	}

	/** PR line of an unchanged base line (null when the line was changed or removed). */
	forward(old_line: number): number | null {
		let delta = 0;
		for (const h of this.hunks) {
			if (h.old_count > 0 && old_line >= h.old_start && old_line < h.old_start + h.old_count)
				return null;
			const before =
				h.old_count === 0 ? h.old_start < old_line : h.old_start + h.old_count <= old_line;
			if (!before) break;
			delta += h.new_count - h.old_count;
		}
		return old_line + delta;
	}

	/** Base line of an unchanged PR line (null when the line was added or changed). */
	backward(new_line: number): number | null {
		let delta = 0;
		for (const h of this.hunks) {
			if (h.new_count > 0 && new_line >= h.new_start && new_line < h.new_start + h.new_count)
				return null;
			const before =
				h.new_count === 0 ? h.new_start < new_line : h.new_start + h.new_count <= new_line;
			if (!before) break;
			delta += h.old_count - h.new_count;
		}
		return new_line + delta;
	}
}

export const IDENTITY = new LineMap([]);
