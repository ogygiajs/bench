<script>
	/**
	 * The live part of the chat: the composer, and the replies of this visit, streamed from
	 * POST /api/chat and re-rendered from markdown as each token arrives. `start` is the turn the
	 * first new message gets (the history before it is rendered by History.svelte).
	 */
	import { md } from '../md.ts';
	import ToolCard from './ToolCard.svelte';

	let { start } = $props();
	let turns = $state([]);
	let draft = $state('');
	let busy = $state(false);

	async function send(e) {
		e.preventDefault();
		const prompt = draft.trim() || 'Go on.';
		draft = '';
		const turn = start + turns.length;
		turns.push({ turn, prompt, text: '', tools: [], done: false });
		const live = turns[turns.length - 1];
		busy = true;
		try {
			const res = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ turn, prompt })
			});
			const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
			let buf = '';
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += value;
				let nl;
				while ((nl = buf.indexOf('\n')) >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (!line) continue;
					const ev = JSON.parse(line);
					if (ev.t != null) live.text += ev.t;
					else if (ev.tool) live.tools.push(ev.tool);
				}
			}
		} finally {
			live.done = true;
			busy = false;
		}
	}
</script>

<div class="chat-live">
	{#each turns as t (t.turn)}
		<div class="msg user"><div class="body"><p>{t.prompt}</p></div></div>
		<div class="msg assistant" data-turn={t.turn} data-done={t.done ? '' : undefined}>
			{#each t.tools as tool, i (i)}<ToolCard {tool} />{/each}
			<div class="body">{@html md(t.text)}</div>
		</div>
	{/each}
	<form class="composer" onsubmit={send}>
		<textarea bind:value={draft} rows="2" placeholder="Message the assistant" aria-label="Message"></textarea>
		<button type="submit" disabled={busy}>Send</button>
	</form>
</div>
