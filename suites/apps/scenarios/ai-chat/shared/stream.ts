// The assistant: a deterministic local token stream, no model. POST /api/chat { turn } answers
// with NDJSON events: `{"t":"<token>"}` per token and one `{"tool":{…}}` part-way, paced like a
// fast model (first token after 40 ms, then one every 10 ms). Every app's endpoint returns this.
import replies from './data/replies.json' with { type: 'json' };

export const FIRST_TOKEN_MS = 40;
export const TOKEN_MS = 10;
export const TOOL_AT = 24;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function replyFor(turn) {
	const reply = replies[Math.abs(turn) % replies.length];
	return { tokens: reply.text.match(/\S+\s*/g), tool: reply.tool };
}

export async function handleChat(request) {
	const { turn = 0 } = await request.json().catch(() => ({}));
	const { tokens, tool } = replyFor(Number(turn));
	const enc = new TextEncoder();
	let i = 0;
	const body = new ReadableStream({
		async pull(controller) {
			await sleep(i === 0 ? FIRST_TOKEN_MS : TOKEN_MS);
			if (i === TOOL_AT) controller.enqueue(enc.encode(JSON.stringify({ tool }) + '\n'));
			if (i >= tokens.length) return controller.close();
			controller.enqueue(enc.encode(JSON.stringify({ t: tokens[i++] }) + '\n'));
		}
	});
	return new Response(body, {
		headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' }
	});
}
