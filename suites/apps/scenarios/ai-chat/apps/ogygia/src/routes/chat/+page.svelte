<script>
	// The markup of the shared ChatPage.svelte. The history is server HTML; the composer and the
	// replies of this visit are one island, awake from the start.
	import History from '$lib/shared/components/History.svelte';
	import Chat from '$lib/shared/components/Chat.svelte' with { wake: 'load' };

	let { data } = $props();
</script>

<svelte:head><title>Assistant · Bench Chat</title></svelte:head>

<div class="chat-app">
	<header class="chat-head">
		<h1>Assistant</h1>
		<p>{data.messages.length} messages</p>
	</header>
	<main class="thread">
		<History messages={data.messages} />
		<Chat start={data.messages.length / 2} />
	</main>
</div>
