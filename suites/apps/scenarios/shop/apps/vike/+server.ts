import { Hono } from 'hono';
import vike from '@vikejs/hono';
import { handleCart } from './src/lib/shared/visitor.ts';

// Vike's own production server: a Hono app with Vike's page handler (vike.dev/server), plus the
// cart endpoint.
const app = new Hono();
vike(app);
app.post('/api/cart', (c) => handleCart(c.req.raw));

export default { fetch: app.fetch };
