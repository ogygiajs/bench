// Generate the ai-chat scenario's data: a 120-message conversation (markdown, code blocks, lists,
// tool calls) and the five replies the local token stream plays back. Deterministic (seeded).
//
//   node scenarios/ai-chat/generate.ts   → scenarios/ai-chat/shared/data/
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('./shared/data/', import.meta.url));
let seed = 7331;
const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
const pick = (xs) => xs[next() % xs.length];
const WORDS =
	'the model reads your question then plans a short answer and checks the docs before it writes code that you can paste into the project so the build stays green and the page stays fast'.split(
		' '
	);
const TOPICS = ['caching', 'streaming', 'forms', 'routing', 'hydration', 'testing', 'deploys', 'layouts'];

function sentence(n) {
	const w = [];
	for (let i = 0; i < n; i++) w.push(pick(WORDS));
	const s = w.join(' ');
	return s[0].toUpperCase() + s.slice(1) + '.';
}
const para = () => [sentence(12 + (next() % 10)), sentence(10 + (next() % 10))].join(' ');

function code() {
	const t = pick(TOPICS);
	return [
		'```ts',
		`export function ${t}Config(input: string) {`,
		`\tconst value = input.trim();`,
		`\treturn { name: '${t}', value, enabled: value.length > 0 };`,
		'}',
		'```'
	].join('\n');
}

function answer(long) {
	const parts = [para(), `**${pick(TOPICS)}** works like this:`, ['- ' + sentence(8), '- ' + sentence(9), '- ' + sentence(7)].join('\n')];
	if (long || next() % 2) parts.push(code());
	parts.push(para());
	if (long) parts.push(`### Next steps`, para(), code(), para());
	return parts.join('\n\n');
}

function tool() {
	const t = pick(TOPICS);
	return {
		name: pick(['search_docs', 'run_query', 'read_file']),
		args: { query: `${t} setup`, limit: 3 },
		result: {
			hits: [1, 2, 3].map((i) => ({ title: `${t} guide part ${i}`, score: Number((0.9 - i * 0.1).toFixed(2)) }))
		}
	};
}

const messages = [];
for (let i = 0; i < 60; i++) {
	messages.push({ role: 'user', text: `How do I set up ${pick(TOPICS)} for ${pick(TOPICS)}? ${sentence(8)}` });
	const m = { role: 'assistant', text: answer(i % 10 === 0) };
	if (i % 4 === 1) m.tool = tool();
	messages.push(m);
}

// The replies the stream plays back, by turn: long ones, each with a tool call part-way.
const replies = Array.from({ length: 5 }, () => ({ text: answer(true), tool: tool() }));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'public', 'api'), { recursive: true });
writeFileSync(join(OUT, 'history.json'), JSON.stringify(messages));
writeFileSync(join(OUT, 'replies.json'), JSON.stringify(replies));
// What the client-rendered SPA fetches; the server apps import history.json directly.
writeFileSync(join(OUT, 'public', 'api', 'history.json'), JSON.stringify(messages));
const tokens = replies.map((r) => r.text.match(/\S+\s*/g).length);
console.log(`  ai-chat: ${messages.length} messages, replies of ${tokens.join('/')} tokens`);
