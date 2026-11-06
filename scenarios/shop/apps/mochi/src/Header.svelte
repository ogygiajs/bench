<script>
	// The markup of the shared ShopHeader.svelte, with the two personal parts as server islands.
	// Their fallback is the anonymous markup, which is what the page itself holds.
	import Greeting from './shared/components/Greeting.svelte';
	import CartBadge from './shared/components/CartBadge.svelte';
	import GreetingIsland from './GreetingIsland.svelte';
	import CartIsland from './CartIsland.svelte';
</script>

<header class="shop-head">
	<a class="brand" href="/">Bench Shop</a>
	<div class="account">
		<GreetingIsland mochi:defer><Greeting /></GreetingIsland>
		<CartIsland mochi:defer><CartBadge /></CartIsland>
	</div>
</header>
