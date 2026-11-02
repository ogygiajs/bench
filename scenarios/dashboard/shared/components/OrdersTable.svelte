<script>
	/** Every order in one table: sort by any column, filter by text and by status. */
	import { untrack } from 'svelte';
	import { filterOrders, money } from '../format.ts';

	let { orders } = $props();
	const all = untrack(() => orders);
	let sortKey = $state('date');
	let dir = $state('desc');
	let q = $state('');
	let status = $state('all');

	const COLS = [
		['id', 'Order'],
		['customer', 'Customer'],
		['region', 'Region'],
		['product', 'Product'],
		['status', 'Status'],
		['amount', 'Amount'],
		['date', 'Date']
	];
	const STATUSES = ['all', 'paid', 'pending', 'refunded', 'failed'];

	const rows = $derived.by(() => {
		const k = sortKey;
		const m = dir === 'asc' ? 1 : -1;
		return filterOrders(all, q, status).sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * m);
	});

	function sortBy(k) {
		if (sortKey === k) dir = dir === 'asc' ? 'desc' : 'asc';
		else {
			sortKey = k;
			dir = k === 'amount' || k === 'date' ? 'desc' : 'asc';
		}
	}
</script>

<section class="orders" data-sort="{sortKey}:{dir}" data-count={rows.length}>
	<div class="controls">
		<input type="search" placeholder="Filter orders" aria-label="Filter orders" bind:value={q} />
		<select aria-label="Status" bind:value={status}>
			{#each STATUSES as s (s)}<option value={s}>{s === 'all' ? 'All statuses' : s}</option>{/each}
		</select>
		<span class="count">{rows.length} orders</span>
	</div>
	<table>
		<thead>
			<tr>
				{#each COLS as [k, label] (k)}
					<th>
						<button class:sorted={sortKey === k} onclick={() => sortBy(k)}
							>{label}{sortKey === k ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}</button
						>
					</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each rows as o (o.id)}
				<tr>
					<td>{o.id}</td>
					<td>{o.customer}</td>
					<td>{o.region}</td>
					<td>{o.product}</td>
					<td><span class={'status ' + o.status}>{o.status}</span></td>
					<td class="amount">{money(o.amount)}</td>
					<td>{o.date}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</section>
