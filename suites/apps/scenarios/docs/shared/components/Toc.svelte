<script>
	/** On this page: the headings, with the one in view highlighted as you scroll. */
	let { headings } = $props();
	let active = $state(null);

	$effect(() => {
		const els = headings.map((h) => document.getElementById(h.id)).filter(Boolean);
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) if (e.isIntersecting) active = e.target.id;
			},
			{ rootMargin: '0px 0px -70% 0px' }
		);
		for (const el of els) io.observe(el);
		return () => io.disconnect();
	});
</script>

<nav class="toc" aria-label="On this page">
	<p>On this page</p>
	<ul>
		{#each headings as h (h.id)}
			<li class={'depth-' + h.depth}><a href={'#' + h.id} class:active={h.id === active}>{h.text}</a></li>
		{/each}
	</ul>
</nav>
