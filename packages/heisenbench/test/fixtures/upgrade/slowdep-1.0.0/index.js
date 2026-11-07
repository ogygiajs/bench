import { is_space } from './lib/is_space.js';

/** Split text into words. */
export function tokenize(text) {
	const out = [];
	let start = 0;
	for (let i = 0; i <= text.length; i++) {
		if (i === text.length || is_space(text.charCodeAt(i))) {
			if (i > start) {
				const word = text.slice(start, i);
				out.push(word);
			}
			start = i + 1;
		}
	}
	return out;
}

export function count_words(text) {
	return tokenize(text).length;
}
