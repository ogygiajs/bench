<script>
	// A plain Svelte SPA: fetch the dashboard's data, then render it in the browser.
	import Dashboard from './lib/shared/components/Dashboard.svelte';

	let data = $state(null);
	fetch('/api/dashboard.json')
		.then((r) => r.json())
		.then((d) => (data = d));
</script>

{#if data}
	<Dashboard {data} />
{/if}
