<script>
	// A server island: rendered per visitor with their cookies.
	import { getRequestContext } from 'mochi-framework';
	import CartBadge from './shared/components/CartBadge.svelte';
	import { visitorFrom } from './shared/visitor.ts';

	const { cookies } = getRequestContext();
	const visitor = visitorFrom((name) => cookies.get(name));
</script>

<CartBadge count={visitor?.cart ?? 0} />
