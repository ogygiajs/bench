<script>
	// The markup of the shared Dashboard.svelte. The live panel wakes on load (it ticks from the
	// start), the table when it scrolls into view; the bar chart is plain server HTML.
	import BarChart from '$lib/shared/components/BarChart.svelte';
	import LivePanel from '$lib/shared/components/LivePanel.svelte' with { wake: 'load' };
	import OrdersTable from '$lib/shared/components/OrdersTable.svelte' with { wake: 'visible' };

	let { data } = $props();
</script>

<svelte:head><title>Operations · Bench Dashboard</title></svelte:head>

<div class="dash">
	<header class="dash-head">
		<h1>Operations</h1>
		<p>{data.orders.length} orders this month</p>
	</header>
	<LivePanel live={data.live} />
	<BarChart regions={data.regions} />
	<OrdersTable orders={data.orders} />
</div>
