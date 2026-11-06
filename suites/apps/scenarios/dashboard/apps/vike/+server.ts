import { Hono } from 'hono';
import vike from '@vikejs/hono';

// Vike's own production server: a Hono app with Vike's page handler (vike.dev/server).
const app = new Hono();
vike(app);

export default { fetch: app.fetch };
