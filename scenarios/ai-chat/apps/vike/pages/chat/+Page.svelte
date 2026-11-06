<script>
	import { getContext } from 'svelte';
	import ChatPage from '../../src/lib/shared/components/ChatPage.svelte';

	const pageContext = getContext('vike-svelte:usePageContext');
</script>

<svelte:head><title>Assistant · Bench Chat</title></svelte:head>

<ChatPage messages={pageContext.data.messages} />
