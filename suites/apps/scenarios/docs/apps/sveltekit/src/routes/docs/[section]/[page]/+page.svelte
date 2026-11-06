<script>
	import DocPage from '$lib/shared/components/DocPage.svelte';

	let { data } = $props();
</script>

<svelte:head><title>{data.page.title} · Bench Docs</title></svelte:head>

<DocPage nav={data.nav} page={data.page} />
