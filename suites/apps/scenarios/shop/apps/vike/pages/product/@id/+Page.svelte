<script>
	import { getContext } from 'svelte';
	import ProductPage from '../../../src/lib/shared/components/ProductPage.svelte';

	const pageContext = getContext('vike-svelte:usePageContext');
	const { product, related } = pageContext.data;
</script>

<svelte:head><title>{product.name} · Bench Shop</title></svelte:head>

<ProductPage {product} {related} />
