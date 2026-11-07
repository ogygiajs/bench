import MagicString from 'magic-string';
import { parseSync } from 'oxc-parser';

/*
 * `import.meta` as the counted world shows it (runtime/paths.ts): every `import.meta` of a module
 * the counting loader serves is a call of a function the module defines at its end, which asks the
 * paths service for the module's virtual meta once (`url`, `filename`, `dirname` and `resolve`
 * under the virtual root) and falls back to the real one where no service is installed (a Vite
 * build, the plain build of the time layers).
 *
 * Counted modules get it from the transform (instrument.ts `virtual_paths`), uncounted modules of
 * the project (bench files) from `virtualize_meta`. The call is not priced: the transform prices the
 * module's own syntax, and a function declaration hoists, so a module reached early through an
 * import cycle still has it.
 */

/** The function that answers `import.meta` (`name()`), and the variable that keeps its answer. */
export function meta_footer(name: string, cache: string): string {
	return `\nfunction ${name}(){return ${cache}??=globalThis[Symbol.for("heisenbench.paths")]?.meta(import.meta)??import.meta}var ${cache};\n`;
}

/** Where `import.meta` is in a parsed program (start, end), in source order. */
export function meta_ranges(program: unknown): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	const walk = (v: unknown): void => {
		if (Array.isArray(v)) {
			for (const x of v) walk(x);
			return;
		}
		if (v === null || typeof v !== 'object') return;
		const n = v as { type?: unknown; start?: number; end?: number; meta?: { name?: unknown } };
		if (n.type === 'MetaProperty' && n.meta?.name === 'import') {
			out.push([n.start!, n.end!]);
			return;
		}
		for (const k in n) if (k !== 'parent') walk((n as Record<string, unknown>)[k]);
	};
	walk(program);
	return out.sort((a, b) => a[0] - b[0]);
}

const SAME_LENGTH = '$hb_meta_';

/**
 * An ES module that is not counted (a bench file) with its `import.meta` virtual. The call has the
 * length of `import.meta` when the name is free, so no line or column moves.
 */
export function virtualize_meta(code: string, filename: string): string {
	if (!code.includes('import.meta')) return code;
	const parsed = parseSync(filename, code, { sourceType: 'module' });
	if (parsed.errors.length > 0) return code;
	const ranges = meta_ranges(parsed.program);
	if (ranges.length === 0) return code;
	let name = SAME_LENGTH;
	for (let i = 1; code.includes(name); i++) name = `${SAME_LENGTH}${i}`;
	const s = new MagicString(code);
	for (const [a, b] of ranges) s.overwrite(a, b, `${name}()`);
	s.append(meta_footer(name, `${name}m`));
	return s.toString();
}
