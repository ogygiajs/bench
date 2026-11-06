<script>
	/** The conversation so far, rendered from markdown. Static. */
	import { md } from '../md.ts';
	import ToolCard from './ToolCard.svelte';

	let { messages } = $props();
</script>

<div class="history">
	{#each messages as m, i (i)}
		<div class={'msg ' + m.role}>
			{#if m.tool}<ToolCard tool={m.tool} />{/if}
			<div class="body">{@html md(m.text)}</div>
		</div>
	{/each}
</div>
