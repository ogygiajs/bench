<script>
	// The markup of the shared ShopHeader.svelte, with the greeting and the cart count as server
	// islands. Their fallback is the anonymous markup, which is what the prerendered page holds.
	import Greeting from '$lib/shared/components/Greeting.svelte';
	import CartBadge from '$lib/shared/components/CartBadge.svelte';
	import GreetingHole from '$lib/GreetingHole.svelte' with { render: 'deferred' };
	import CartHole from '$lib/CartHole.svelte' with { render: 'deferred' };

	let { children } = $props();
</script>

<header class="shop-head">
	<a class="brand" href="/">Bench Shop</a>
	<div class="account">
		<GreetingHole>
			{#snippet ogygiaFallback()}<Greeting />{/snippet}
		</GreetingHole>
		<CartHole>
			{#snippet ogygiaFallback()}<CartBadge />{/snippet}
		</CartHole>
	</div>
</header>
{@render children()}
