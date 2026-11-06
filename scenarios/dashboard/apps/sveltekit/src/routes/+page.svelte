<script>
	import Dashboard from '$lib/shared/components/Dashboard.svelte';

	let { data } = $props();
</script>

<svelte:head><title>Operations · Bench Dashboard</title></svelte:head>

<Dashboard {data} />
