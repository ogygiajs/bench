<script>
	import ShopHeader from '$lib/shared/components/ShopHeader.svelte';

	let { data, children } = $props();
</script>

<ShopHeader visitor={data.visitor} />
{@render children()}
