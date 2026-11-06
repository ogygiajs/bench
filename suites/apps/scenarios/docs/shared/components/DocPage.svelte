<script>
	/**
	 * One docs page, the whole tree. The apps that hydrate the whole page (SvelteKit, Vike, the SPA)
	 * render this; the islands apps (ogygia, Astro, Mochi) write the same markup in their own page
	 * template, with their island directives on Search, CodeTabs and Toc.
	 */
	import Sidebar from './Sidebar.svelte';
	import Search from './Search.svelte';
	import CodeTabs from './CodeTabs.svelte';
	import Toc from './Toc.svelte';
	import Pager from './Pager.svelte';

	let { nav, page } = $props();
</script>

<div class="docs">
	<header class="top">
		<a class="brand" href="/docs/getting-started/getting-started-overview">Bench Docs</a>
		<Search />
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
					<CodeTabs tabs={block.tabs} />
				{/if}
			{/each}
			<Pager prev={page.prev} next={page.next} />
		</main>
		<Toc headings={page.headings} />
	</div>
</div>
