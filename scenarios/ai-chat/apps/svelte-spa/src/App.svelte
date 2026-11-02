<script>
	// A plain Svelte SPA: fetch the history, then render the chat in the browser.
	import ChatPage from './lib/shared/components/ChatPage.svelte';

	let messages = $state(null);
	fetch('/api/history.json')
		.then((r) => r.json())
		.then((m) => (messages = m));
</script>

{#if messages}
	<ChatPage {messages} />
{/if}
