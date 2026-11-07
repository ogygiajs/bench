/*
 * The recording transform wraps every piece of code it injects in these two comments, and nothing
 * else in a module is written between them, so the original text of a recorded function is its
 * text with every marked piece taken out (`original_source`). Injected pieces never nest: the code
 * a wrapped return keeps (`return X`) sits between two pieces, not inside one.
 */

export const INJECTED_OPEN = '/*heisenbench{*/';
export const INJECTED_CLOSE = '/*}heisenbench*/';

/** A function's source as written: every injected piece removed. */
export function original_source(text: string): string {
	let at = text.indexOf(INJECTED_OPEN);
	if (at === -1) return text;
	let out = '';
	let from = 0;
	while (at !== -1) {
		const end = text.indexOf(INJECTED_CLOSE, at + INJECTED_OPEN.length);
		out += text.slice(from, at);
		// an arrow function's text ends inside the piece that closes its added block
		if (end === -1) return out;
		from = end + INJECTED_CLOSE.length;
		at = text.indexOf(INJECTED_OPEN, from);
	}
	return out + text.slice(from);
}
