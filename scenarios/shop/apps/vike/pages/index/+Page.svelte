<script>
	import { getContext } from 'svelte';
	import ProductGrid from '../../src/lib/shared/components/ProductGrid.svelte';

	const pageContext = getContext('vike-svelte:usePageContext');
</script>

<svelte:head><title>Bench Shop</title></svelte:head>

<ProductGrid products={pageContext.data.products} />
