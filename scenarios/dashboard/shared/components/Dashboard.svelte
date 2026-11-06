<script>
	/**
	 * The dashboard, the whole tree. The apps that hydrate the whole page (SvelteKit, Vike, the SPA)
	 * render this; the islands apps write the same markup with their directives on LivePanel and
	 * OrdersTable (BarChart stays static).
	 */
	import LivePanel from './LivePanel.svelte';
	import BarChart from './BarChart.svelte';
	import OrdersTable from './OrdersTable.svelte';

	let { data } = $props();
</script>

<div class="dash">
	<header class="dash-head">
		<h1>Operations</h1>
		<p>{data.orders.length} orders this month</p>
	</header>
	<LivePanel live={data.live} />
	<BarChart regions={data.regions} />
	<OrdersTable orders={data.orders} />
</div>
