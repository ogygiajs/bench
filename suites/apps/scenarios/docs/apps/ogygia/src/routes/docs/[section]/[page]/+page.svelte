<script>
	// The markup of the shared DocPage.svelte, with ogygia's dials on the three interactive parts:
	// search wakes on the first keystroke or focus inside it, the code tabs when they scroll into
	// view, the table of contents when the browser is idle. Everything else is server HTML.
	import Sidebar from '$lib/shared/components/Sidebar.svelte';
	import Pager from '$lib/shared/components/Pager.svelte';
	import Search from '$lib/shared/components/Search.svelte' with { wake: 'interaction' };
	import CodeTabs from '$lib/shared/components/CodeTabs.svelte' with { wake: 'visible' };
	import Toc from '$lib/shared/components/Toc.svelte' with { wake: 'idle' };

	let { data } = $props();
	const page = $derived(data.page);
</script>

<svelte:head><title>{page.title} · Bench Docs</title></svelte:head>

<div class="docs">
	<header class="top">
		<a class="brand" href="/docs/getting-started/getting-started-overview">Bench Docs</a>
		<Search />
	</header>
	<div class="cols">
		<Sidebar nav={data.nav} current={page.slug} />
		<main class="article">
			<p class="crumb">{page.section}</p>
			<h1>{page.title}</h1>
			{#each page.blocks as block, i (page.slug + ':' + i)}
				{#if block.type === 'html'}
					{@html block.html}
				{:else}
					<CodeTabs tabs={block.tabs} />
				{/if}
			{/each}
			<Pager prev={page.prev} next={page.next} />
		</main>
		<Toc headings={page.headings} />
	</div>
</div>
