<script>
	let { items = [] } = $props();
	function label(item) {
		if (item.done) {
			return 'done: ' + item.name;
		}
		return item.name;
	}
</script>

{#each items as item}
	<p>{label(item)}</p>
{/each}
