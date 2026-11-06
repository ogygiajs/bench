<script>
	// The markup of the shared ProductPage.svelte; Add to cart ships no JS until the visitor
	// reaches for it (the first pointer or key inside wakes it and replays the click).
	import ProductDetail from '$lib/shared/components/ProductDetail.svelte';
	import ProductCard from '$lib/shared/components/ProductCard.svelte';
	import AddToCart from '$lib/shared/components/AddToCart.svelte' with { wake: 'interaction' };

	let { data } = $props();
</script>

<svelte:head><title>{data.product.name} · Bench Shop</title></svelte:head>

<main class="shop">
	<ProductDetail product={data.product} />
	<AddToCart id={data.product.id} />
	<h2>You may also like</h2>
	<div class="grid related">
		{#each data.related as p (p.id)}<ProductCard product={p} />{/each}
	</div>
</main>
