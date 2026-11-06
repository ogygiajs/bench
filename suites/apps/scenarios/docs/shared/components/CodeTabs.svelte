<script>
	/** Install commands per package manager, one visible at a time. */
	let { tabs } = $props();
	let active = $state(0);
</script>

<div class="code-tabs">
	<div class="tab-list" role="tablist">
		{#each tabs as tab, i (tab.label)}
			<button role="tab" aria-selected={i === active} class:active={i === active} onclick={() => (active = i)}
				>{tab.label}</button
			>
		{/each}
	</div>
	{#each tabs as tab, i (tab.label)}
		<pre class="tab-panel" hidden={i !== active}><code>{tab.code}</code></pre>
	{/each}
</div>
