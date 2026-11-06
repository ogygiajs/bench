<script>
	import { getContext } from 'svelte';
	import nav from '../../../../src/lib/shared/data/nav.json';
	import DocPage from '../../../../src/lib/shared/components/DocPage.svelte';

	const pageContext = getContext('vike-svelte:usePageContext');
	const page = pageContext.data.page;
</script>

<svelte:head><title>{page.title} · Bench Docs</title></svelte:head>

<DocPage {nav} {page} />
