<script>
	// The markup of the shared ChatPage.svelte, with Mochi's directive on the live chat.
	import History from './shared/components/History.svelte';
	import Chat from './shared/components/Chat.svelte';

	let { messages } = $props();
</script>

<svelte:head><title>Assistant · Bench Chat</title></svelte:head>

<div class="chat-app">
	<header class="chat-head">
		<h1>Assistant</h1>
		<p>{messages.length} messages</p>
	</header>
	<main class="thread">
		<History {messages} />
		<Chat mochi:hydrate start={messages.length / 2} />
	</main>
</div>
