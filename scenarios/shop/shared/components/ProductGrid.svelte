<script>
	/** The home page body: every product. Static, the same in every app. */
	import ProductCard from './ProductCard.svelte';

	let { products } = $props();
</script>

<main class="shop">
	<h1>All products</h1>
	<div class="grid">
		{#each products as product (product.id)}<ProductCard {product} />{/each}
	</div>
</main>
