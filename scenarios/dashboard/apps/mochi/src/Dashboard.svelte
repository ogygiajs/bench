<script>
	// The markup of the shared Dashboard.svelte, with Mochi's directives on the live panel and the table.
	import BarChart from './shared/components/BarChart.svelte';
	import LivePanel from './shared/components/LivePanel.svelte';
	import OrdersTable from './shared/components/OrdersTable.svelte';

	let { data } = $props();
</script>

<svelte:head><title>Operations · Bench Dashboard</title></svelte:head>

<div class="dash">
	<header class="dash-head">
		<h1>Operations</h1>
		<p>{data.orders.length} orders this month</p>
	</header>
	<LivePanel mochi:hydrate live={data.live} />
	<BarChart regions={data.regions} />
	<OrdersTable mochi:hydrate:visible orders={data.orders} />
</div>
