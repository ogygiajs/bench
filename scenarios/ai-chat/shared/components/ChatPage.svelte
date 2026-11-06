<script>
	/**
	 * The chat page, the whole tree. The apps that hydrate the whole page (SvelteKit, Vike, the
	 * SPA) render this; the islands apps write the same markup with their directive on Chat
	 * (History stays static).
	 */
	import History from './History.svelte';
	import Chat from './Chat.svelte';

	let { messages } = $props();
</script>

<div class="chat-app">
	<header class="chat-head">
		<h1>Assistant</h1>
		<p>{messages.length} messages</p>
	</header>
	<main class="thread">
		<History {messages} />
		<Chat start={messages.length / 2} />
	</main>
</div>
