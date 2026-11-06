<script>
	// A server island: rendered per visitor with their cookies.
	import { getRequestContext } from 'mochi-framework';
	import Greeting from './shared/components/Greeting.svelte';
	import { visitorFrom } from './shared/visitor.ts';

	const { cookies } = getRequestContext();
	const visitor = visitorFrom((name) => cookies.get(name));
</script>

<Greeting name={visitor?.name ?? null} />
