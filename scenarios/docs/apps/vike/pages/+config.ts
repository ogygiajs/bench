import vikeSvelte from 'vike-svelte/config';

// Docs as Vike builds them: every page prerendered, hydrated, Vike's client routing (on by
// default with vike-svelte).
export default {
	extends: [vikeSvelte],
	prerender: true
};
