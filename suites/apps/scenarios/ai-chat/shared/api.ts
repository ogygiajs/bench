// The chat endpoint for an app with no server of its own (the client-rendered SPA): the harness's
// static server calls `handle` for every request. The server apps route POST /api/chat to
// `handleChat` themselves.
import { handleChat } from './stream.ts';

export async function handle(request) {
	const url = new URL(request.url);
	if (url.pathname === '/api/chat' && request.method === 'POST') return handleChat(request);
	return null;
}
