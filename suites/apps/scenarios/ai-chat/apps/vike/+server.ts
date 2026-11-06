import { Hono } from 'hono';
import vike from '@vikejs/hono';
import { handleChat } from './src/lib/shared/stream.ts';

// Vike's own production server: a Hono app with Vike's page handler (vike.dev/server), plus the
// chat's streaming endpoint.
const app = new Hono();
vike(app);
app.post('/api/chat', (c) => handleChat(c.req.raw));

export default { fetch: app.fetch };
