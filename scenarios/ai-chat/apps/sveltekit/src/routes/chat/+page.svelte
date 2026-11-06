<script>
	import ChatPage from '$lib/shared/components/ChatPage.svelte';

	let { data } = $props();
</script>

<svelte:head><title>Assistant · Bench Chat</title></svelte:head>

<ChatPage messages={data.messages} />
