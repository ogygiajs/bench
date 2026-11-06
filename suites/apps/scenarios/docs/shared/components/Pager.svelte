<script>
	/** Previous / next page links. Static. */
	let { prev, next } = $props();
</script>

<nav class="pager" aria-label="Pages">
	{#if prev}<a class="prev" href={'/docs/' + prev.slug}><span>Previous</span>{prev.title}</a>{/if}
	{#if next}<a class="next" href={'/docs/' + next.slug}><span>Next</span>{next.title}</a>{/if}
</nav>
