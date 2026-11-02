import { Mochi } from 'mochi-framework';
import history from './shared/data/history.json';
import { handleChat } from './shared/stream.ts';

// The chat as Mochi serves it: rendered on the server per request, the history as static HTML,
// the composer and the replies of this visit as one island; replies stream from an API route.
await Mochi.serve({
	port: Number(process.env.PORT) || 3338,
	development: process.env.MODE === 'development',
	htmlShell: './src/shell.html',
	routes: {
		'/chat': Mochi.page('./src/ChatPage.svelte', { serverProps: () => ({ messages: history }) }),
		'/api/chat': Mochi.api(({ request }) => handleChat(request))
	}
});
