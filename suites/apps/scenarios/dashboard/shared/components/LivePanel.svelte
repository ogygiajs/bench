<script>
	/**
	 * Four KPI cards and a revenue-per-minute line, updated every second from a deterministic
	 * random walk. Each update records how long Svelte took to apply it to the DOM in
	 * `window.__bench_updates`, which the benchmark reads as the live update cost.
	 */
	import { tick } from 'svelte';
	import { untrack } from 'svelte';
	import { walker, money, whole } from '../format.ts';

	let { live } = $props();
	let kpis = $state(untrack(() => live.kpis.map((k) => ({ ...k, delta: 0 }))));
	let series = $state(untrack(() => live.series.slice()));
	let ticks = $state(0);

	const W = 600;
	const H = 160;
	const path = $derived.by(() => {
		const max = Math.max(...series);
		const min = Math.min(...series);
		const span = max - min || 1;
		return series
			.map((v, i) => `${i ? 'L' : 'M'}${((i / (series.length - 1)) * W).toFixed(1)},${(H - ((v - min) / span) * (H - 10) - 5).toFixed(1)}`)
			.join(' ');
	});

	$effect(() => {
		const rand = walker(live.seed);
		const id = setInterval(async () => {
			const t0 = performance.now();
			kpis = kpis.map((k) => {
				const delta = rand() * (k.id === 'aov' ? 2 : k.id === 'revenue' ? 400 : 12);
				return { ...k, value: Math.max(0, k.value + delta), delta };
			});
			series = [...series.slice(1), Math.max(100, series.at(-1) + rand() * 120)];
			ticks++;
			await tick();
			(window.__bench_updates ??= []).push(performance.now() - t0);
		}, 1000);
		return () => clearInterval(id);
	});
</script>

<section class="live" data-ticks={ticks}>
	<div class="kpis">
		{#each kpis as k (k.id)}
			<article class="kpi">
				<h2>{k.label}</h2>
				<p class="value">{k.id === 'revenue' || k.id === 'aov' ? money(k.value) : whole(k.value)}</p>
				<p class="delta" class:up={k.delta > 0} class:down={k.delta < 0}>
					{k.delta > 0 ? '▲' : k.delta < 0 ? '▼' : '•'}
					{Math.abs(k.delta).toFixed(1)}
				</p>
			</article>
		{/each}
	</div>
	<figure class="chart line">
		<figcaption>Revenue per minute, last hour</figcaption>
		<svg viewBox="0 0 {W} {H}" role="img" aria-label="Revenue per minute">
			<path d={path} fill="none" stroke="currentColor" stroke-width="2" />
		</svg>
	</figure>
</section>
