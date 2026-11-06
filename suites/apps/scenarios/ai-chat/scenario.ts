// AI chat: a 120-message conversation, and new replies streamed token by token from a local
// deterministic stream (no model), rendered as markdown as they arrive, with a tool-call card.
// Measures send-to-first-token on screen, INP while a reply streams, the heap after a long
// conversation, and (server apps) the stream's first chunk and the page's render cost.
import { readFileSync } from 'node:fs';

const history = JSON.parse(
	readFileSync(new URL('./shared/data/history.json', import.meta.url), 'utf8')
);
const START = history.length / 2;
const DRAFT = 'thanks, and the next step?';

const now = (s) => s.page.evaluate(() => performance.timeOrigin + performance.now());
const firstToken = (turn) =>
	`document.querySelector('.msg[data-turn="${turn}"] .body')?.textContent.length > 0`;
const finished = (turn) => `!!document.querySelector('.msg[data-turn="${turn}"][data-done]')`;

/** Send one message; resolves once its first token is on screen, with the send time. */
async function send(s, turn, prompt) {
	await s.page.fill('.composer textarea', prompt);
	await s.until(() => !document.querySelector('.composer button')?.disabled);
	const t0 = await now(s);
	await s.page.click('.composer button');
	const first = await s.until(firstToken(turn));
	return { t0, first };
}

export default {
	title: 'AI chat: a 120-message history, streamed markdown replies with tool calls',
	routes: { chat: '/chat' },
	ready: '/chat',
	lighthouse: ['chat'],
	stepNames: ['type-streaming', 'toggle-tool'],
	composition: 'components/ChatPage.svelte',
	server: { route: 'chat', stream: { path: '/api/chat', body: { turn: 0, prompt: 'hello' } } },
	fidelity: {
		paths: ['/chat'],
		print: () =>
			[
				document.querySelector('h1')?.textContent?.trim(),
				document.querySelectorAll('.history .msg').length,
				document.querySelectorAll('.history .tool').length,
				document.querySelectorAll('.history pre').length,
				document.querySelector('.history .msg.assistant .body')?.textContent?.length,
				document.querySelectorAll('.composer textarea').length
			].join('|')
	},
	async session(s) {
		await s.goto('/chat');

		// Turn 1: time from Send to the first token on screen, and to the last.
		const one = await send(s, START, 'How do I cache a page?');
		const end = await s.until(finished(START), 30000);
		s.mark('ttft', one.first - one.t0);
		s.mark('streamMs', end - one.t0);

		// Turn 2: while it streams, type the next message and open a tool card in the history.
		await send(s, START + 1, 'And for a whole section?');
		await s.interact(
			'type-streaming',
			(p) => p.type('.composer textarea', DRAFT, { delay: 30 }),
			`document.querySelector('.composer textarea')?.value === ${JSON.stringify(DRAFT)}`
		);
		await s.interact(
			'toggle-tool',
			(p) => p.click('.history .tool summary >> nth=0'),
			() => document.querySelector('.history .tool')?.open === true
		);
		await s.until(finished(START + 1), 30000);
	},
	// A long conversation: four more streamed replies, then the heap.
	async long(s) {
		for (let k = 2; k < 6; k++) {
			await send(s, START + k, `Question ${k}`);
			await s.until(finished(START + k), 30000);
		}
	}
};
