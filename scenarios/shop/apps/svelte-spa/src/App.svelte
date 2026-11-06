<script>
	// A plain Svelte SPA: the catalog and the visitor come from JSON endpoints (the visitor again on
	// every navigation), a few lines of history routing handle links.
	import ShopHeader from './lib/shared/components/ShopHeader.svelte';
	import ProductGrid from './lib/shared/components/ProductGrid.svelte';
	import ProductPage from './lib/shared/components/ProductPage.svelte';
	import { productPage } from './lib/shared/catalog.ts';

	let path = $state(location.pathname);
	let products = $state(null);
	let visitor = $state(null);

	fetch('/api/products.json')
		.then((r) => r.json())
		.then((p) => (products = p));

	$effect(() => {
		path;
		fetch('/api/me')
			.then((r) => r.json())
			.then((v) => (visitor = v));
	});

	const page = $derived(
		products && path.startsWith('/product/') ? productPage(products, path.slice('/product/'.length)) : null
	);

	$effect(() => {
		document.title = page ? `${page.product.name} · Bench Shop` : 'Bench Shop';
	});

	function onclick(e) {
		if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
		const a = e.target.closest?.('a');
		if (!a || a.origin !== location.origin) return;
		e.preventDefault();
		if (a.pathname === location.pathname) return;
		history.pushState(null, '', a.pathname);
		path = a.pathname;
		scrollTo(0, 0);
	}
</script>

<svelte:document {onclick} />
<svelte:window onpopstate={() => (path = location.pathname)} />

{#if products}
	<ShopHeader {visitor} />
	{#if page}
		{#key page.product.id}<ProductPage product={page.product} related={page.related} />{/key}
	{:else}
		<ProductGrid {products} />
	{/if}
{/if}
