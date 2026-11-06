import { Mochi } from 'mochi-framework';
import dashboard from './shared/data/dashboard.json';

// The dashboard as Mochi serves it: rendered on the server per request, the live panel and the
// table as islands, the bar chart as static HTML.
await Mochi.serve({
	port: Number(process.env.PORT) || 3337,
	development: process.env.MODE === 'development',
	htmlShell: './src/shell.html',
	proxy: { origin: process.env.ORIGIN },
	routes: {
		'/': Mochi.page('./src/Dashboard.svelte', { serverProps: () => ({ data: dashboard }) })
	}
});
