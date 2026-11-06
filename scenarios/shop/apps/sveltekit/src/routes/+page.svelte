<script>
	import ProductGrid from '$lib/shared/components/ProductGrid.svelte';

	let { data } = $props();
</script>

<svelte:head><title>Bench Shop</title></svelte:head>

<ProductGrid products={data.products} />
