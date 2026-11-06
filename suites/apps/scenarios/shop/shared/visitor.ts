// Who is visiting: a `bench_user` cookie names a known user, `bench_cart` holds the cart count.
// No login flow; the benchmark sets the cookies. Plus the two endpoints every app serves.
const USERS = { ada: 'Ada', linus: 'Linus' };

export function parseCookies(header) {
	const out = {};
	for (const part of (header ?? '').split(';')) {
		const i = part.indexOf('=');
		if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
	}
	return out;
}

/** The visitor from a cookie getter, or null for an anonymous one. */
export function visitorFrom(get) {
	const name = USERS[get('bench_user')];
	if (!name) return null;
	return { name, cart: Number(get('bench_cart')) || 0 };
}

const json = (body, headers = {}) =>
	new Response(JSON.stringify(body), {
		headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store', ...headers }
	});

/** POST /api/cart: one more item in the cart; answers the new count and sets the cookie. */
export function handleCart(request) {
	const cookies = parseCookies(request.headers.get('cookie'));
	const cart = (Number(cookies.bench_cart) || 0) + 1;
	return json({ cart }, { 'set-cookie': `bench_cart=${cart}; Path=/; SameSite=Lax` });
}

/** GET /api/me: the visitor, for the client-rendered SPA. */
export function handleMe(request) {
	const cookies = parseCookies(request.headers.get('cookie'));
	return json(visitorFrom((n) => cookies[n]));
}
