import vikeSvelte from 'vike-svelte/config';

// The shop as Vike builds it: every page rendered on the server per request with the visitor's
// cookies, then hydrated, Vike's client routing.
export default {
	extends: [vikeSvelte]
};
