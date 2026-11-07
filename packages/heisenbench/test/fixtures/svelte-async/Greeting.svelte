<script>
	let { name } = $props();
	const greeting = await Promise.resolve('hello');
</script>

<p>{greeting}, {name}</p>
