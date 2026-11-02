<script>
	/** The personal greeting in the header; anonymous visitors see a sign-in link. */
	let { name = null } = $props();
</script>

{#if name}
	<span class="greeting">Hello, {name}</span>
{:else}
	<a class="greeting" href="/">Sign in</a>
{/if}
