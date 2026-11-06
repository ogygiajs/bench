import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { get_runtime } from '../runtime/index.ts';
import { Builtins } from '../runtime/builtins.ts';
import { Determinism } from '../runtime/determinism.ts';
import { run_case } from '../runner.ts';
import { build_case_report } from '../report.ts';
import type { BenchCase } from '../bench.ts';
import { unstable_functions } from './stability.ts';
import type { AppRequest, ChildMessage, CountedServerCase, ParentMessage } from './server.ts';

/*
 * The counted SvelteKit server, in a process of its own (server.ts starts it).
 *
 * The runtime is created before the server's modules load, so the counters of the bundled code
 * (which find the runtime through a global) report into this process's runtime. The server is the
 * build's own `Server` class over the full manifest, answered two ways:
 *
 * - `listen`: a plain HTTP server for the browser session (static files of the build first, then
 *   the app), on the real clock. Nothing is counted there.
 * - `count`: requests made straight to `server.respond` inside Abax's measuring window (frozen
 *   clock, seeded random, fake timers, recorded IO), like a bench case: a warm-up run that records
 *   IO, then two measured runs whose counts must match.
 */

type KitServer = {
	init(o: { env: Record<string, string>; read: (file: string) => ReadableStream }): Promise<void>;
	respond(r: Request, o: { getClientAddress: () => string }): Promise<Response>;
};

const rt = get_runtime();
const builtins = new Builtins(rt);
const det = new Determinism();
let kit: KitServer | null = null;
let static_dirs: string[] = [];
let http: HttpServer | null = null;

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.txt': 'text/plain',
	'.woff2': 'font/woff2'
};

function static_file(pathname: string): string | null {
	const tries =
		pathname === '/'
			? ['/index.html']
			: pathname.endsWith('/')
				? [pathname + 'index.html', pathname.slice(0, -1) + '.html']
				: [pathname, pathname + '.html', pathname + '/index.html'];
	for (const dir of static_dirs) {
		for (const t of tries) {
			const file = join(dir, t);
			if (!file.startsWith(dir)) continue;
			if (existsSync(file) && statSync(file).isFile()) return file;
		}
	}
	return null;
}

function to_request(r: AppRequest, origin: string): Request {
	const method = r.method ?? 'GET';
	return new Request(new URL(r.path, origin), {
		method,
		headers: { origin, ...r.headers },
		body: method === 'GET' || method === 'HEAD' ? undefined : (r.body ?? '')
	});
}

async function node_request(req: IncomingMessage, origin: string): Promise<Request> {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	const headers = new Headers();
	for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, String(v));
	const method = req.method ?? 'GET';
	return new Request(new URL(req.url ?? '/', origin), {
		method,
		headers,
		body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks)
	});
}

async function send(res: ServerResponse, response: Response): Promise<void> {
	const headers: Record<string, string | string[]> = {};
	response.headers.forEach((v, k) => (headers[k] = v));
	const cookies = response.headers.getSetCookie();
	if (cookies.length) headers['set-cookie'] = cookies;
	res.writeHead(response.status, headers);
	if (!response.body) {
		res.end();
		return;
	}
	for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
	res.end();
}

async function listen(): Promise<string> {
	let origin = '';
	http = createServer((req, res) => {
		void (async () => {
			try {
				const pathname = decodeURIComponent(new URL(req.url ?? '/', origin).pathname);
				const file = req.method === 'GET' ? static_file(pathname) : null;
				if (file) {
					const body = readFileSync(file);
					res.writeHead(200, {
						'content-type': MIME[extname(file)] ?? 'application/octet-stream',
						'content-length': body.length
					});
					res.end(body);
					return;
				}
				const response = await kit!.respond(await node_request(req, origin), {
					getClientAddress: () => '127.0.0.1'
				});
				await send(res, response);
			} catch (e) {
				res.writeHead(500);
				res.end(String((e as Error)?.stack ?? e));
			}
		})();
	});
	await new Promise<void>((r) => http!.listen(0, '127.0.0.1', r));
	const addr = http.address();
	origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
	return origin;
}

async function count(cases: CountedServerCase[], origin: string, out: string): Promise<void> {
	const results = [];
	for (const c of cases) {
		const statuses: number[] = [];
		const bench_case: BenchCase = {
			name: c.name,
			file: '',
			fn: async () => {
				statuses.length = 0;
				for (let i = 0; i < c.repeat; i++) {
					for (const r of c.requests) {
						const res = await kit!.respond(to_request(r, origin), {
							getClientAddress: () => '127.0.0.1'
						});
						await res.arrayBuffer();
						statuses.push(res.status);
					}
				}
			}
		};
		try {
			const { a, b, stable } = await run_case(bench_case, det, builtins);
			const info = (s: typeof a) => ({
				name: c.name,
				file: '',
				stable,
				timers: s.timers,
				runaway: s.runaway,
				error: null
			});
			const ra = build_case_report(rt, a.snap, info(a));
			const rb = build_case_report(rt, b.snap, info(b));
			results.push({
				name: c.name,
				report: ra,
				unstable: stable ? [] : unstable_functions(ra, rb),
				statuses: [...statuses]
			});
		} catch (e) {
			results.push({ name: c.name, error: (e as Error)?.stack ?? String(e) });
		}
	}
	writeFileSync(out, JSON.stringify(results));
}

async function init(m: Extract<ParentMessage, { type: 'init' }>): Promise<void> {
	Object.assign(process.env, m.env);
	static_dirs = m.static_dirs;
	const { Server } = (await import(pathToFileURL(join(m.server_dir, 'index.js')).href)) as {
		Server: new (manifest: unknown) => KitServer;
	};
	const { manifest } = (await import(
		pathToFileURL(join(m.server_dir, 'manifest-full.js')).href
	)) as { manifest: unknown };
	kit = new Server(manifest);
	const client = m.static_dirs[0];
	await kit.init({
		env: process.env as Record<string, string>,
		read: (file) => Readable.toWeb(createReadStream(join(client, file))) as ReadableStream
	});
}

function reply(msg: ChildMessage): void {
	process.send!(msg);
}

process.on('message', (raw) => {
	const m = raw as ParentMessage;
	void (async () => {
		try {
			if (m.type === 'init') {
				await init(m);
				reply({ type: 'ready' });
			} else if (m.type === 'listen') {
				reply({ type: 'listening', base: await listen() });
			} else if (m.type === 'close') {
				http?.closeAllConnections();
				await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
				http = null;
				reply({ type: 'closed' });
			} else if (m.type === 'count') {
				await count(m.cases, m.origin, m.out);
				reply({ type: 'counted', out: m.out });
			}
		} catch (e) {
			reply({ type: 'error', message: (e as Error)?.stack ?? String(e) });
		}
	})();
});
