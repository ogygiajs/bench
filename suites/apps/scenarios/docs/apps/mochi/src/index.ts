import { Mochi, error } from 'mochi-framework';
import nav from './shared/data/nav.json';
import pages from './shared/data/pages.json';

// Docs as Mochi serves them: every request rendered on the server (Mochi has no prerendering),
// Svelte islands for the search box, the code tabs and the table of contents, full page loads.
await Mochi.serve({
	port: Number(process.env.PORT) || 3336,
	development: process.env.MODE === 'development',
	htmlShell: './src/shell.html',
	trailingSlash: 'never',
	proxy: { origin: process.env.ORIGIN },
	routes: {
		'/docs/:section/:page': Mochi.page('./src/DocPage.svelte', {
			serverProps: (_req, params) => {
				const page = pages[`${params.section}/${params.page}`];
				if (!page) error(404);
				return { nav, page };
			}
		})
	}
});
