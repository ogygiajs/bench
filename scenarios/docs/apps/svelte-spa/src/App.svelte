<script>
	// A plain Svelte SPA: the nav ships in the bundle, each page body is fetched as JSON, and a
	// few lines of history routing handle links.
	import nav from './lib/shared/data/nav.json';
	import DocPage from './lib/shared/components/DocPage.svelte';

	const FIRST = '/docs/getting-started/getting-started-overview';
	if (!location.pathname.startsWith('/docs/')) history.replaceState(null, '', FIRST);

	let path = $state(location.pathname);
	let page = $state(null);
	let token = 0;

	$effect(() => {
		const slug = path.replace(/^\/docs\//, '');
		const mine = ++token;
		fetch(`/data/pages/${slug.replace('/', '--')}.json`)
			.then((r) => r.json())
			.then((p) => {
				if (mine !== token) return;
				page = p;
				document.title = `${p.title} · Bench Docs`;
			});
	});

	function onclick(e) {
		if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
		const a = e.target.closest?.('a');
		if (!a || a.origin !== location.origin || !a.pathname.startsWith('/docs/')) return;
		if (a.hash && a.pathname === location.pathname) return;
		e.preventDefault();
		if (a.pathname === location.pathname) return;
		history.pushState(null, '', a.pathname);
		path = a.pathname;
		scrollTo(0, 0);
	}
</script>

<svelte:document {onclick} />
<svelte:window onpopstate={() => (path = location.pathname)} />

{#if page}
	<DocPage {nav} {page} />
{/if}
