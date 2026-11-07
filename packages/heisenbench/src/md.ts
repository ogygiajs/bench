/** Markdown pieces every rendered section shares. */

/** Text for a table cell: the characters that would end the cell or the row are escaped. */
export function cell(s: string): string {
	return s.split('\\').join('\\\\').split('|').join('\\|').split(/\r?\n/).join(' ');
}

/**
 * Inline code that is safe in a table cell: a backtick would end the span, and in a GFM table a
 * `|` ends the cell even inside a code span, so it is escaped; a newline would end the row.
 */
export function code(s: string): string {
	return '`' + cell(s.split('`').join("'")) + '`';
}
