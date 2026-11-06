// The shop's endpoints for an app with no server of its own (the client-rendered SPA): the
// harness's static server calls `handle` for every request. The server apps route them themselves.
import { handleCart, handleMe } from './visitor.ts';

export async function handle(request) {
	const { pathname } = new URL(request.url);
	if (pathname === '/api/cart' && request.method === 'POST') return handleCart(request);
	if (pathname === '/api/me' && request.method === 'GET') return handleMe(request);
	return null;
}
