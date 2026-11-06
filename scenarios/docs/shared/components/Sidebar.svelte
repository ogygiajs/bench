<script>
	/** Every page of the site, grouped by section; the current section is open. Static: native
	 *  <details> collapse, no JS. */
	let { nav, current } = $props();
</script>

<nav class="sidebar" aria-label="Docs">
	{#each nav as section (section.slug)}
		<details open={current.startsWith(section.slug + '/')}>
			<summary>{section.title}</summary>
			<ul>
				{#each section.pages as p (p.slug)}
					<li>
						<a href={'/docs/' + p.slug} aria-current={p.slug === current ? 'page' : undefined}
							>{p.title}</a
						>
					</li>
				{/each}
			</ul>
		</details>
	{/each}
</nav>
