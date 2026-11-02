// Starting the apps: a static build is served by the harness, a server app is spawned as its own
// process on a free port. Either way the caller gets a base URL and a stop().
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
	'.txt': 'text/plain'
};
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg)|javascript/;

/**
 * Fixed dummy values the apps need to build and start; not secrets. The same at build and run
 * time: a prerendered page's server islands are signed with OGYGIA_SECRET when it is built.
 */
export const APP_ENV = {
	OGYGIA_SECRET: 'bench-secret-bench-secret-bench-secret-0123456789',
	// 32 bytes, base64url (Mochi warns about shorter keys).
	MOCHI_KEY: 'YmVuY2gtbW9jaGkta2V5LTMyLWJ5dGVzLWxvbmchISE'
};

/** A free TCP port on 127.0.0.1. */
export function freePort() {
	return new Promise((res, rej) => {
		const s = createServer();
		s.once('error', rej);
		s.listen(0, '127.0.0.1', () => {
			const { port } = s.address();
			s.close(() => res(port));
		});
	});
}

async function toRequest(req, base) {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	const body = chunks.length ? Buffer.concat(chunks) : undefined;
	const headers = new Headers();
	for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, String(v));
	return new Request(new URL(req.url, base), {
		method: req.method,
		headers,
		body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body
	});
}

async function sendResponse(res, response) {
	const headers = {};
	response.headers.forEach((v, k) => (headers[k] = v));
	const cookies = response.headers.getSetCookie?.() ?? [];
	if (cookies.length) headers['set-cookie'] = cookies;
	res.writeHead(response.status, headers);
	if (!response.body) return res.end();
	// Stream it through: a scenario's stream must reach the browser chunk by chunk.
	for await (const chunk of response.body) res.write(chunk);
	res.end();
}

/**
 * Serve a build directory with SSG-style path resolution (/x, /x/, /x.html, /x/index.html).
 * `spa` answers unknown paths with index.html. `api` is a module whose `handle(request)` answers
 * the scenario's shared endpoints for apps that have no server of their own (the plain SPA).
 * Compresses with gzip only when the client asks, like any real server; the harness pins the
 * browser to `identity`.
 */
export async function serveDir(root, { spa = false, api = null } = {}) {
	const handler = api ? (await import(resolve(api))).handle : null;
	const tryFiles = (p) => {
		if (p === '/') return ['/index.html'];
		if (p.endsWith('/')) return [p + 'index.html', p.slice(0, -1) + '.html'];
		return [p, p + '.html', p + '/index.html'];
	};
	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	const server = createServer(async (req, res) => {
		try {
			const pathname = decodeURIComponent(new URL(req.url, base).pathname);
			if (handler) {
				const answer = await handler(await toRequest(req, base));
				if (answer) return await sendResponse(res, answer);
			}
			const candidates = tryFiles(pathname);
			if (spa && !extname(pathname)) candidates.push('/index.html');
			for (const rel of candidates) {
				const file = join(root, rel);
				if (existsSync(file) && statSync(file).isFile()) {
					const type = MIME[extname(file)] ?? 'application/octet-stream';
					const headers = { 'content-type': type };
					let body = readFileSync(file);
					if (COMPRESSIBLE.test(type) && (req.headers['accept-encoding'] ?? '').includes('gzip')) {
						body = gzipSync(body, { level: 6 });
						headers['content-encoding'] = 'gzip';
						headers.vary = 'Accept-Encoding';
					}
					headers['content-length'] = body.length;
					res.writeHead(200, headers);
					return res.end(body);
				}
			}
			res.writeHead(404);
			res.end('not found');
		} catch (e) {
			res.writeHead(500);
			res.end(String(e?.stack ?? e));
		}
	});
	await new Promise((r) => server.listen(port, '127.0.0.1', r));
	return { base, kind: 'static', stop: () => new Promise((r) => server.close(() => r())) };
}

/**
 * Spawn a server app: `start` is `[cmd, ...args]`, run in the app's directory with PORT/HOST (and
 * ORIGIN for Kit's CSRF check) set. Resolves once `ready` answers below 500.
 */
export async function spawnServer(cwd, start, { ready = '/', env = {} } = {}) {
	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	const child = spawn(start[0], start.slice(1), {
		cwd,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			NODE_ENV: 'production',
			PORT: String(port),
			HOST: '127.0.0.1',
			ORIGIN: base,
			...APP_ENV,
			...env
		}
	});
	let log = '';
	child.stdout.on('data', (d) => (log = (log + d).slice(-4000)));
	child.stderr.on('data', (d) => (log = (log + d).slice(-4000)));
	const stop = () =>
		new Promise((r) => {
			if (child.exitCode != null) return r();
			child.once('exit', () => r());
			child.kill('SIGTERM');
			setTimeout(() => child.kill('SIGKILL'), 3000).unref();
		});
	for (let i = 0; i < 120; i++) {
		if (child.exitCode != null) throw new Error(`${start.join(' ')} exited (${child.exitCode}):\n${log}`);
		try {
			const r = await fetch(base + ready, { signal: AbortSignal.timeout(2000) });
			await r.arrayBuffer();
			if (r.status < 500) return { base, kind: 'server', stop, log: () => log };
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	await stop();
	throw new Error(`${start.join(' ')} did not answer ${ready} within 60 s:\n${log}`);
}

/** Boot one app of a scenario from its config entry. */
export async function bootApp(root, app, ready) {
	if (app.url) return { base: app.url.replace(/\/$/, ''), kind: 'server', stop: async () => {} };
	// `out` is the app's client output; no output means the app was not built in this run.
	if (app.out && !existsSync(resolve(root, app.dir, app.out))) return null;
	if (app.start) return spawnServer(resolve(root, app.dir), app.start, { ready, env: app.env });
	const dist = resolve(root, app.dir, app.dist);
	if (!existsSync(dist)) return null;
	return serveDir(dist, { spa: app.spa, api: app.api ? resolve(root, app.api) : null });
}
