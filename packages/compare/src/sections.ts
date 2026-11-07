// The ONE benchmark comment on an ogygia PR, made of named sections. Each suite owns its section
// and rewrites only that one; the others are kept as they are:
//
//   <!-- ogygia-benchmarks -->
//   ### ogygia benchmarks
//
//   <!-- section:heisenbench -->
//   ...
//   <!-- /section:heisenbench -->
//
//   <!-- section:apps -->
//   ...
//   <!-- /section:apps -->
//
// A comment from before sections (the marker, then the app benchmark's body) reads as one `apps`
// section, so the first section upsert migrates it.

/** The line the comment is found by. */
export const MARKER = '<!-- ogygia-benchmarks -->';
export const HEADING = '### ogygia benchmarks';
/** Known sections, in the order the comment shows them; any other section follows these. */
export const SECTION_ORDER: readonly string[] = ['heisenbench', 'apps'];
/** What a comment without sections holds: the app benchmark's body. */
export const LEGACY_SECTION = 'apps';

export interface Section {
	name: string;
	content: string;
}

const START = '<!-- section:';
const END = '<!-- /section:';
const CLOSE = ' -->';
const NAME = /^[a-z][a-z0-9-]*$/;

export const startMarker = (name: string): string => `${START}${name}${CLOSE}`;
export const endMarker = (name: string): string => `${END}${name}${CLOSE}`;

/** Leading blank lines and trailing whitespace go; the rest is kept as written. */
function tidy(text: string): string {
	let start = 0;
	while (start < text.length) {
		const nl = text.indexOf('\n', start);
		if (nl === -1 || text.slice(start, nl).trim() !== '') break;
		start = nl + 1;
	}
	return text.slice(start).trimEnd();
}

function check_name(name: string): void {
	if (!NAME.test(name)) throw new Error(`bad section name: ${JSON.stringify(name)}`);
}

function check_content(content: string): void {
	if (content.includes(START) || content.includes(END))
		throw new Error('section content must not contain section markers');
}

/** A comment without sections: the marker and the heading go, the rest is the legacy section. */
function parse_legacy(body: string): Section[] {
	const lines = body.split('\n').filter((line) => line.trim() !== MARKER);
	const first = lines.findIndex((line) => line.trim() !== '');
	if (first !== -1 && lines[first].trim() === HEADING) lines.splice(first, 1);
	const content = tidy(lines.join('\n'));
	return content ? [{ name: LEGACY_SECTION, content }] : [];
}

/**
 * The sections of a comment body, in the order they appear. A section without its end marker runs
 * to the end of the body; a name seen twice keeps its first section. Text outside the sections
 * (the marker, the heading) is not part of any section.
 */
export function parseComment(body: string | null | undefined): Section[] {
	if (!body) return [];
	const text = body.replaceAll('\r\n', '\n');
	if (!text.includes(START)) return parse_legacy(text);
	const sections: Section[] = [];
	let at = text.indexOf(START);
	while (at !== -1) {
		const name_end = text.indexOf(CLOSE, at + START.length);
		if (name_end === -1) break;
		const name = text.slice(at + START.length, name_end);
		const from = name_end + CLOSE.length;
		if (!NAME.test(name)) {
			at = text.indexOf(START, from);
			continue;
		}
		const end = text.indexOf(endMarker(name), from);
		const content = tidy(text.slice(from, end === -1 ? text.length : end));
		if (!sections.some((s) => s.name === name)) sections.push({ name, content });
		if (end === -1) break;
		at = text.indexOf(START, end + endMarker(name).length);
	}
	return sections;
}

const rank = (name: string): number => {
	const i = SECTION_ORDER.indexOf(name);
	return i === -1 ? SECTION_ORDER.length : i;
};

/** The comment body for these sections: known ones in SECTION_ORDER, then the rest as given. */
export function renderComment(sections: readonly Section[]): string {
	const seen = new Set<string>();
	const unique = sections.filter((s) => {
		check_name(s.name);
		if (seen.has(s.name)) return false;
		seen.add(s.name);
		return true;
	});
	const ordered = unique
		.map((s, i) => ({ s, i }))
		.sort((a, b) => rank(a.s.name) - rank(b.s.name) || a.i - b.i)
		.map(({ s }) => s);
	const parts = [`${MARKER}\n${HEADING}`];
	for (const { name, content } of ordered) {
		check_content(content);
		parts.push(`${startMarker(name)}\n${tidy(content)}\n${endMarker(name)}`);
	}
	return parts.join('\n\n') + '\n';
}

/** GitHub refuses a comment body longer than this (a PATCH or POST fails with 422). */
export const COMMENT_LIMIT = 65_536;
/** What a body is cut down to: below the limit, with room for the closing tags a cut adds. */
export const COMMENT_TARGET = 65_000;

export interface FitOptions {
	/** The longest body (default COMMENT_TARGET). */
	limit?: number;
	/** The line that ends a cut section (default: a note that points to the run). */
	note?: (name: string) => string;
}

const default_note = (name: string): string =>
	`⚠️ The \`${name}\` section was cut here: it is longer than a GitHub comment holds. The full text is in the run that wrote it.`;

/**
 * `content` cut to at most `max` characters, at a line, with the `<details>` and code fences it
 * opened closed again and `note` at the end.
 */
export function truncateSection(content: string, max: number, note: string): string {
	if (content.length <= max) return content;
	const closers = (text: string): string => {
		let tail = '';
		const fences = text.split('\n').filter((l) => l.trimStart().startsWith('```')).length;
		if (fences % 2 === 1) tail += '\n```';
		const open = (text.match(/<details\b/g) ?? []).length;
		const closed = (text.match(/<\/details>/g) ?? []).length;
		for (let i = closed; i < open; i++) tail += '\n\n</details>';
		return tail;
	};
	let keep = Math.max(0, max - note.length - 2);
	for (;;) {
		let cut = content.slice(0, keep);
		const nl = cut.lastIndexOf('\n');
		if (nl !== -1) cut = cut.slice(0, nl);
		const out = `${cut.trimEnd()}${closers(cut)}\n\n${note}`;
		if (out.length <= max || keep === 0) return out.length <= max ? out : note.slice(0, max);
		keep = Math.max(0, keep - (out.length - max));
	}
}

/**
 * Sections whose rendered comment fits in `limit`. Nothing changes when it fits already; else each
 * section gets an equal share of the room, a section shorter than its share keeps all of it and
 * leaves the rest to the others, and the ones over their share are cut (truncateSection).
 */
export function fitSections(sections: readonly Section[], o: FitOptions = {}): Section[] {
	const limit = o.limit ?? COMMENT_TARGET;
	const note = o.note ?? default_note;
	const total = renderComment(sections).length;
	if (total <= limit) return [...sections];
	const content = sections.reduce((n, s) => n + tidy(s.content).length, 0);
	let room = limit - (total - content);
	const order = sections.map((s, i) => ({ i, len: tidy(s.content).length }));
	order.sort((a, b) => a.len - b.len);
	const share = new Map<number, number>();
	order.forEach(({ i, len }, k) => {
		const fair = Math.floor(room / (order.length - k));
		const got = Math.min(len, Math.max(0, fair));
		share.set(i, got);
		room -= got;
	});
	return sections.map((s, i) => {
		const text = tidy(s.content);
		const max = share.get(i)!;
		return text.length <= max
			? s
			: { name: s.name, content: truncateSection(text, max, note(s.name)) };
	});
}

/**
 * `body` with section `name` set to `content`; every other section stays as it was, unless the
 * comment would be too long for GitHub, when the longest sections are cut (fitSections).
 */
export function upsertSection(
	body: string | null | undefined,
	name: string,
	content: string,
	fit: FitOptions = {}
): string {
	check_name(name);
	check_content(content);
	const sections = parseComment(body);
	const next = { name, content: tidy(content) };
	const i = sections.findIndex((s) => s.name === name);
	if (i === -1) sections.push(next);
	else sections[i] = next;
	return renderComment(fitSections(sections, fit));
}

/** The content of section `name` in `body`, or null when it has none. */
export function sectionOf(body: string | null | undefined, name: string): string | null {
	return parseComment(body).find((s) => s.name === name)?.content ?? null;
}
