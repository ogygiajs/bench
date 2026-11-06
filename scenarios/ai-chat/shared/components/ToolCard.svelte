<script>
	/** A tool call and its result, collapsed by default. Native <details>: no JS. */
	let { tool } = $props();
</script>

<details class="tool">
	<summary>Tool · {tool.name}({tool.args.query})</summary>
	<pre>{JSON.stringify(tool.result, null, 2)}</pre>
</details>
