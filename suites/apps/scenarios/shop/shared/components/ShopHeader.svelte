<script>
	/**
	 * The header with the visitor's greeting and cart count, rendered from `visitor`. The apps
	 * that render per request or in the browser (SvelteKit, Vike, the SPA) use this; the
	 * cacheable-page apps write the same markup with server islands in place of the two parts.
	 */
	import Greeting from './Greeting.svelte';
	import CartBadge from './CartBadge.svelte';

	let { visitor } = $props();
</script>

<header class="shop-head">
	<a class="brand" href="/">Bench Shop</a>
	<div class="account">
		<Greeting name={visitor?.name ?? null} />
		<CartBadge count={visitor?.cart ?? 0} />
	</div>
</header>
