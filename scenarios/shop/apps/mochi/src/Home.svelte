<script>
	import Header from './Header.svelte';
	import ProductGrid from './shared/components/ProductGrid.svelte';

	let { products } = $props();
</script>

<svelte:head><title>Bench Shop</title></svelte:head>

<Header />
<ProductGrid {products} />
