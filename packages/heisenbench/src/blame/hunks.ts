import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { check_rev, git_diff } from '../diff/git.ts';
import type { FileDiff, Hunk } from '../diff/git.ts';

/*
 * A PR's diff as units that can be undone one by one, and the trees made from any set of them.
 *
 * A unit is one hunk as a PR shows it: git's zero-context hunks of a file, merged when fewer than
 * MERGE_GAP unchanged lines lie between them (what `git diff` with its default 3 lines of context
 * prints as one hunk). A file the PR added, deleted, renamed or that is binary is one unit, whole.
 *
 * A tree is the base with a set of units applied: no unit is the base, every unit is the head.
 * Undoing units from the head is the same thing seen from the other side (the head minus R is the
 * base plus the rest), so both directions of the search name trees the same way. Units never
 * overlap (they come from one diff), so every set of them makes a tree: each zero-context hunk is
 * either its base lines or its head lines. A tree that does not load or run is found by counting it.
 */

/** Unchanged lines between two zero-context hunks of a file that still make them one unit. */
export const MERGE_GAP = 6;

export type UnitKind = 'edit' | 'add' | 'delete' | 'rename' | 'binary';

export interface Unit {
	/** Index in the PR's units, in file then line order. */
	id: number;
	kind: UnitKind;
	/** The path the PR has (the base's for a deleted file), relative to the repository. */
	file: string;
	old_path: string | null;
	new_path: string | null;
	/** The zero-context hunks this unit is made of (an edit), in line order. */
	parts: Hunk[];
	/** Head lines the unit covers (`[first, last]`; the line before it when it only removes). */
	new_lines: [number, number];
	/** Base lines the unit covers. */
	old_lines: [number, number];
}

interface FileSide {
	/** Lines, each with its own line ending (the last one may have none). */
	lines: string[];
	bytes: Buffer;
}

interface FileChange {
	old_path: string | null;
	new_path: string | null;
	base: FileSide | null;
	head: FileSide | null;
	/** Whole-file: no line-level units. */
	whole: boolean;
	hunks: Hunk[];
	units: Unit[];
}

/** A tree's content for every path the units touch: the bytes, or null when the file is absent. */
export type TreeFiles = Map<string, Buffer | null>;

export interface Units {
	units: Unit[];
	/** Paths the units touch, sorted. */
	paths: string[];
	/** Files that are the same in every tree (a deleted file outside `paths`), by path. */
	fixed: TreeFiles;
	tree(applied: ReadonlySet<number>): TreeFiles;
	/** sha256 of a tree's content over the touched paths. */
	hash(applied: ReadonlySet<number>): string;
	/** The zero-context diff from tree `a` to tree `b`, as `git diff -U0` would print it. */
	file_diffs(a: ReadonlySet<number>, b: ReadonlySet<number>): FileDiff[];
	/** A unit's diff, with `context` unchanged lines around it, as the PR shows it. */
	text(unit: Unit, context?: number): string;
}

function split_lines(text: string): string[] {
	if (text === '') return [];
	return text.split(/(?<=\n)/);
}

function side(bytes: Buffer): FileSide {
	return { bytes, lines: split_lines(bytes.toString('utf8')) };
}

function is_binary(b: Buffer | null): boolean {
	return b !== null && b.subarray(0, 8000).includes(0);
}

function blob(repo: string, rev: string, path: string): Buffer {
	return execFileSync('git', ['cat-file', 'blob', `${check_rev(rev)}:${path}`], {
		cwd: repo,
		maxBuffer: 1 << 28,
		stdio: ['ignore', 'pipe', 'pipe']
	});
}

/** First and last line a zero-context hunk covers on one side (the line before it when empty). */
function span(start: number, count: number): [number, number] {
	return count === 0 ? [start, start] : [start, start + count - 1];
}

function group(parts: Hunk[]): Hunk[][] {
	const out: Hunk[][] = [];
	for (const h of parts) {
		const last = out.at(-1)?.at(-1);
		// unchanged base lines between the end of the last hunk and the start of this one
		const end = last
			? last.old_count === 0
				? last.old_start
				: last.old_start + last.old_count - 1
			: 0;
		const begin = h.old_count === 0 ? h.old_start + 1 : h.old_start;
		if (last && begin - end - 1 <= MERGE_GAP) out.at(-1)!.push(h);
		else out.push([h]);
	}
	return out;
}

export interface UnitsOptions {
	/** Only files at these repository paths (a deleted file outside them is in every tree). */
	paths?: ReadonlySet<string> | null;
	/** The run root, relative to the repository (`Report.git.prefix`): only files under it. */
	prefix?: string;
}

/** The units of `git diff base head` in `repo`, and the trees they make. */
export function diff_units(repo: string, base: string, head: string, o: UnitsOptions = {}): Units {
	return units_of(
		git_diff(repo, base, head),
		(rev, path) => blob(repo, rev === 'base' ? base : head, path),
		o
	);
}

/** {@link diff_units} from a parsed diff and a reader of each side's files. */
export function units_of(
	diff: FileDiff[],
	read: (side: 'base' | 'head', path: string) => Buffer,
	o: UnitsOptions = {}
): Units {
	const prefix = o.prefix ? o.prefix.replace(/\/$/, '') + '/' : '';
	const under = (p: string | null) => p !== null && p.startsWith(prefix);
	const files: FileChange[] = [];
	const fixed: TreeFiles = new Map();
	for (const f of diff) {
		if (!under(f.old_path ?? f.new_path) && !under(f.new_path)) continue;
		const wanted =
			!o.paths ||
			(f.new_path !== null && o.paths.has(f.new_path)) ||
			(f.old_path !== null && o.paths.has(f.old_path));
		const base = f.old_path === null ? null : side(read('base', f.old_path));
		if (!wanted) {
			// Nothing at the head imports a file the PR deleted, so no graph has it; an importer the
			// search puts back may. It stays on disk, as the base has it, in every tree.
			if (f.new_path === null && base) fixed.set(f.old_path!, base.bytes);
			continue;
		}
		const head = f.new_path === null ? null : side(read('head', f.new_path));
		const renamed = f.old_path !== null && f.new_path !== null && f.old_path !== f.new_path;
		const whole =
			base === null ||
			head === null ||
			renamed ||
			is_binary(base.bytes) ||
			is_binary(head.bytes) ||
			f.hunks.length === 0;
		if (whole && base && head && !renamed && base.bytes.equals(head.bytes)) continue; // mode only
		files.push({
			old_path: f.old_path,
			new_path: f.new_path,
			base,
			head,
			whole,
			hunks: f.hunks,
			units: []
		});
	}
	files.sort((a, b) => {
		const x = a.new_path ?? a.old_path!;
		const y = b.new_path ?? b.old_path!;
		return x < y ? -1 : x > y ? 1 : 0;
	});
	const units: Unit[] = [];
	for (const f of files) {
		const file = f.new_path ?? f.old_path!;
		if (f.whole) {
			const kind: UnitKind =
				f.base === null
					? 'add'
					: f.head === null
						? 'delete'
						: f.old_path !== f.new_path
							? 'rename'
							: 'binary';
			const u: Unit = {
				id: units.length,
				kind,
				file,
				old_path: f.old_path,
				new_path: f.new_path,
				parts: [],
				new_lines: [1, Math.max(1, f.head?.lines.length ?? 0)],
				old_lines: [1, Math.max(1, f.base?.lines.length ?? 0)]
			};
			units.push(u);
			f.units.push(u);
			continue;
		}
		const sorted = [...f.hunks].sort(
			(a, b) => a.old_start - b.old_start || a.new_start - b.new_start
		);
		for (const g of group(sorted)) {
			const first = g[0];
			const last = g[g.length - 1];
			const u: Unit = {
				id: units.length,
				kind: 'edit',
				file,
				old_path: f.old_path,
				new_path: f.new_path,
				parts: g,
				new_lines: [
					span(first.new_start, first.new_count)[0],
					span(last.new_start, last.new_count)[1]
				],
				old_lines: [
					span(first.old_start, first.old_count)[0],
					span(last.old_start, last.old_count)[1]
				]
			};
			units.push(u);
			f.units.push(u);
		}
	}

	const paths = new Set<string>();
	for (const f of files) {
		if (f.old_path) paths.add(f.old_path);
		if (f.new_path) paths.add(f.new_path);
	}
	const sorted_paths = [...paths].sort();

	/** An edited file's lines with the units in `applied` taken from the head, the rest from the base. */
	const edit_lines = (f: FileChange, applied: ReadonlySet<number>): string[] => {
		const base = f.base!.lines;
		const head = f.head!.lines;
		const out: string[] = [];
		let next = 1; // next base line to copy
		for (const u of f.units) {
			const take = applied.has(u.id);
			for (const h of u.parts) {
				const begin = h.old_count === 0 ? h.old_start + 1 : h.old_start;
				for (; next < begin; next++) out.push(base[next - 1]);
				if (take) for (let i = 0; i < h.new_count; i++) out.push(head[h.new_start - 1 + i]);
				else for (let i = 0; i < h.old_count; i++) out.push(base[begin - 1 + i]);
				next = begin + h.old_count;
			}
		}
		for (; next <= base.length; next++) out.push(base[next - 1]);
		return out;
	};

	const tree = (applied: ReadonlySet<number>): TreeFiles => {
		const out: TreeFiles = new Map();
		for (const f of files) {
			if (!f.whole) {
				out.set(f.new_path!, Buffer.from(edit_lines(f, applied).join(''), 'utf8'));
				continue;
			}
			const take = applied.has(f.units[0].id);
			if (f.old_path !== null && f.old_path !== f.new_path)
				out.set(f.old_path, take ? null : f.base!.bytes);
			if (f.new_path !== null)
				out.set(
					f.new_path,
					take ? f.head!.bytes : f.old_path === f.new_path ? f.base!.bytes : null
				);
		}
		return out;
	};

	const hash = (applied: ReadonlySet<number>): string => {
		const h = createHash('sha256');
		const t = tree(applied);
		for (const p of sorted_paths) {
			const b = t.get(p);
			h.update(p).update('\0');
			if (b === undefined || b === null) h.update('-');
			else h.update(createHash('sha256').update(b).digest('hex'));
			h.update('\0');
		}
		return h.digest('hex');
	};

	const file_diffs = (a: ReadonlySet<number>, b: ReadonlySet<number>): FileDiff[] => {
		const out: FileDiff[] = [];
		for (const f of files) {
			const changed = f.units.filter((u) => a.has(u.id) !== b.has(u.id));
			if (changed.length === 0) continue;
			if (f.whole) {
				const in_a = a.has(f.units[0].id);
				const from = in_a ? f.new_path : f.old_path;
				const to = in_a ? f.old_path : f.new_path;
				const from_lines = (in_a ? f.head : f.base)?.lines.length ?? 0;
				const to_lines = (in_a ? f.base : f.head)?.lines.length ?? 0;
				out.push({
					old_path: from,
					new_path: to,
					hunks: [
						{
							old_start: from_lines === 0 ? 0 : 1,
							old_count: from_lines,
							new_start: to_lines === 0 ? 0 : 1,
							new_count: to_lines
						}
					]
				});
				continue;
			}
			const hunks: Hunk[] = [];
			let pa = 0; // last line written in tree a
			let pb = 0;
			let next = 1;
			for (const u of f.units) {
				for (const h of u.parts) {
					const begin = h.old_count === 0 ? h.old_start + 1 : h.old_start;
					pa += begin - next;
					pb += begin - next;
					const la = a.has(u.id) ? h.new_count : h.old_count;
					const lb = b.has(u.id) ? h.new_count : h.old_count;
					if (a.has(u.id) !== b.has(u.id)) {
						hunks.push({
							old_start: la === 0 ? pa : pa + 1,
							old_count: la,
							new_start: lb === 0 ? pb : pb + 1,
							new_count: lb
						});
					}
					pa += la;
					pb += lb;
					next = begin + h.old_count;
				}
			}
			out.push({ old_path: f.old_path, new_path: f.new_path, hunks });
		}
		return out;
	};

	const text = (unit: Unit, context = 3): string => {
		const f = files.find((x) => x.units.includes(unit))!;
		if (f.whole) {
			const what =
				unit.kind === 'add'
					? `new file ${unit.new_path}`
					: unit.kind === 'delete'
						? `deleted file ${unit.old_path}`
						: unit.kind === 'rename'
							? `renamed ${unit.old_path} → ${unit.new_path}`
							: `binary file ${unit.file}`;
			if (unit.kind === 'binary' || unit.kind === 'delete') return what;
			const lines = f.head!.lines;
			const shown = lines.slice(0, 40).map((l) => '+' + strip_eol(l));
			if (lines.length > 40) shown.push(`… ${lines.length - 40} more lines`);
			return [what, ...shown].join('\n');
		}
		const base = f.base!.lines;
		const head = f.head!.lines;
		const out: string[] = [];
		const first = unit.parts[0];
		const begin0 = first.old_count === 0 ? first.old_start + 1 : first.old_start;
		const new_begin0 = first.new_count === 0 ? first.new_start + 1 : first.new_start;
		const from = Math.max(1, begin0 - context);
		let old_line = from;
		const rows: string[] = [];
		for (const h of unit.parts) {
			const begin = h.old_count === 0 ? h.old_start + 1 : h.old_start;
			for (; old_line < begin; old_line++) rows.push(' ' + strip_eol(base[old_line - 1]));
			for (let i = 0; i < h.old_count; i++) rows.push('-' + strip_eol(base[begin - 1 + i]));
			for (let i = 0; i < h.new_count; i++) rows.push('+' + strip_eol(head[h.new_start - 1 + i]));
			old_line = begin + h.old_count;
		}
		const stop = Math.min(base.length, old_line - 1 + context);
		for (; old_line <= stop; old_line++) rows.push(' ' + strip_eol(base[old_line - 1]));
		const old_n = rows.filter((r) => r[0] !== '+').length;
		const new_n = rows.filter((r) => r[0] !== '-').length;
		const new_from = new_begin0 - (begin0 - from);
		out.push(`@@ -${from},${old_n} +${new_from},${new_n} @@`, ...rows);
		return out.join('\n');
	};

	return { units, paths: sorted_paths, fixed, tree, hash, file_diffs, text };
}

function strip_eol(l: string | undefined): string {
	if (l === undefined) return '';
	return l.endsWith('\r\n') ? l.slice(0, -2) : l.endsWith('\n') ? l.slice(0, -1) : l;
}

/** `L1035–1072` (or `L1035`) for a unit's head lines; a removal names the line it was after. */
export function line_range(u: Unit): string {
	const [a, b] = u.new_lines;
	return a === b ? `L${a}` : `L${a}–${b}`;
}
