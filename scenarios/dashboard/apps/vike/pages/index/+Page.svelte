<script>
	import { getContext } from 'svelte';
	import Dashboard from '../../src/lib/shared/components/Dashboard.svelte';

	const pageContext = getContext('vike-svelte:usePageContext');
</script>

<svelte:head><title>Operations · Bench Dashboard</title></svelte:head>

<Dashboard data={pageContext.data} />
