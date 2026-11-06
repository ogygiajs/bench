<script>
	import ProductPage from '$lib/shared/components/ProductPage.svelte';

	let { data } = $props();
</script>

<svelte:head><title>{data.product.name} · Bench Shop</title></svelte:head>

<ProductPage product={data.product} related={data.related} />
