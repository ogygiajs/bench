<script>
	/**
	 * A product page body: the product, Add to cart, related products. The whole-page apps render
	 * this; the islands apps write the same markup with their directive on AddToCart.
	 */
	import ProductDetail from './ProductDetail.svelte';
	import ProductCard from './ProductCard.svelte';
	import AddToCart from './AddToCart.svelte';

	let { product, related } = $props();
</script>

<main class="shop">
	<ProductDetail {product} />
	<AddToCart id={product.id} />
	<h2>You may also like</h2>
	<div class="grid related">
		{#each related as p (p.id)}<ProductCard product={p} />{/each}
	</div>
</main>
