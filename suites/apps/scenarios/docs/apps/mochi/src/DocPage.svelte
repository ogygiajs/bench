<script>
	// The markup of the shared DocPage.svelte, with Mochi's directives on the three interactive parts.
	import Sidebar from './shared/components/Sidebar.svelte';
	import Pager from './shared/components/Pager.svelte';
	import Search from './shared/components/Search.svelte';
	import CodeTabs from './shared/components/CodeTabs.svelte';
	import Toc from './shared/components/Toc.svelte';

	let { nav, page } = $props();
</script>

<svelte:head><title>{page.title} · Bench Docs</title></svelte:head>

<div class="docs">
	<header class="top">
		<a class="brand" href="/docs/getting-started/getting-started-overview">Bench Docs</a>
		<Search mochi:hydrate />
	</header>
	<div class="cols">
		<Sidebar {nav} current={page.slug} />
		<main class="article">
			<p class="crumb">{page.section}</p>
			<h1>{page.title}</h1>
			{#each page.blocks as block, i (page.slug + ':' + i)}
				{#if block.type === 'html'}
					{@html block.html}
				{:else}
					<CodeTabs mochi:hydrate:visible tabs={block.tabs} />
				{/if}
			{/each}
			<Pager prev={page.prev} next={page.next} />
		</main>
		<Toc mochi:hydrate headings={page.headings} />
	</div>
</div>
