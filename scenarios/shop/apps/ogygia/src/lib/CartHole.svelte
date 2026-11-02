<script>
	// A server island: renders on ogygia's endpoint with the visitor's cookies. An anonymous
	// visitor keeps the page's fallback (a 204, no swap).
	import { requestEvent, keepFallback } from 'ogygia';
	import CartBadge from './shared/components/CartBadge.svelte';
	import { visitorFrom } from './shared/visitor.ts';

	let { ogygiaFallback } = $props();
	const event = requestEvent();
	const visitor = visitorFrom((name) => event?.cookies.get(name));
	if (!visitor) keepFallback();
</script>

<CartBadge count={visitor.cart} />
