<script>
	/** Paid revenue by region. Static: it does not change while the page is open. */
	import { whole } from '../format.ts';

	let { regions } = $props();
	const max = $derived(Math.max(...regions.map((r) => r.revenue)));
</script>

<figure class="chart bars">
	<figcaption>Paid revenue by region, this month</figcaption>
	<svg viewBox="0 0 600 {regions.length * 36}" role="img" aria-label="Revenue by region">
		{#each regions as r, i (r.name)}
			<g transform="translate(0 {i * 36})">
				<text x="0" y="22" class="label">{r.name}</text>
				<rect x="90" y="6" height="22" width={(r.revenue / max) * 400} rx="3" />
				<text x={100 + (r.revenue / max) * 400} y="22" class="amount">${whole(r.revenue)}</text>
			</g>
		{/each}
	</svg>
</figure>
