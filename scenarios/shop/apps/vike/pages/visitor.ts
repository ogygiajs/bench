import { parseCookies, visitorFrom } from '../src/lib/shared/visitor.ts';

/** The visitor of a page request, from its cookies (server side, in a +data hook). */
export function visitorOf(pageContext) {
	const cookies = parseCookies(pageContext.headers?.cookie);
	return visitorFrom((name) => cookies[name]);
}
