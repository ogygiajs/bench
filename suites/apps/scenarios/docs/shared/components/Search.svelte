<script>
	/** Site search: the index (/search.json) loads on first use, results filter as you type. */
	let q = $state('');
	let index = $state(null);
	let loading = false;

	async function load() {
		if (index || loading) return;
		loading = true;
		const res = await fetch('/search.json');
		index = await res.json();
	}

	$effect(() => {
		if (q.trim().length >= 2) load();
	});

	const results = $derived.by(() => {
		const needle = q.trim().toLowerCase();
		if (!index || needle.length < 2) return [];
		const out = [];
		for (const entry of index) {
			if (entry.title.toLowerCase().includes(needle) || entry.text.includes(needle)) out.push(entry);
			if (out.length === 8) break;
		}
		return out;
	});
</script>

<div class="search">
	<input type="search" placeholder="Search the docs" aria-label="Search the docs" bind:value={q} />
	{#if results.length}
		<ul class="search-results">
			{#each results as r (r.slug)}
				<li><a href={'/docs/' + r.slug}>{r.title} <span>{r.section}</span></a></li>
			{/each}
		</ul>
	{/if}
</div>
