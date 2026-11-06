<script>
	import { getContext } from 'svelte';
	import ShopHeader from '../src/lib/shared/components/ShopHeader.svelte';

	let { Page } = $props();
	const pageContext = getContext('vike-svelte:usePageContext');
</script>

<svelte:head><link rel="stylesheet" href="/shop.css" /></svelte:head>

<ShopHeader visitor={pageContext.data.visitor} />
<Page />
