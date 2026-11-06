<script>
	// The markup of the shared ProductPage.svelte, with Mochi's directive on Add to cart.
	import Header from './Header.svelte';
	import ProductDetail from './shared/components/ProductDetail.svelte';
	import ProductCard from './shared/components/ProductCard.svelte';
	import AddToCart from './shared/components/AddToCart.svelte';

	let { product, related } = $props();
</script>

<svelte:head><title>{product.name} · Bench Shop</title></svelte:head>

<Header />
<main class="shop">
	<ProductDetail {product} />
	<AddToCart mochi:hydrate id={product.id} />
	<h2>You may also like</h2>
	<div class="grid related">
		{#each related as p (p.id)}<ProductCard product={p} />{/each}
	</div>
</main>
