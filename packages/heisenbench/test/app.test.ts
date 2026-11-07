import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rolldown } from 'rolldown';
import { counted_plugins } from '../src/app/vite.ts';
import { CountedServer } from '../src/app/server.ts';
import { launch_browser, run_session } from '../src/app/browser.ts';
import type { PwBrowser } from '../src/app/browser.ts';
import { run_scenario } from '../src/app/run.ts';
import { deserialize_snapshot, serialize_snapshot, snapshot_delta } from '../src/app/snapshot.ts';
import { build_case_report } from '../src/report.ts';
import { temp_dir, write_files, load_module, rt } from './helpers.ts';

/*
 * The counted app run end to end on a small fake app: a "framework" package in node_modules with
 * a SvelteKit-shaped server (`Server` with init/respond) and a page script, bundled with the
 * counting plugins the way a counted Vite build bundles a real app.
 */

const FRAMEWORK = {
	'node_modules/fakekit/package.json': '{"name":"fakekit","version":"1.2.3","type":"module"}',
	'node_modules/fakekit/server.js': `
export class Server {
	constructor(manifest) { this.manifest = manifest; }
	async init({ env }) { this.secret = env.FAKE_SECRET ?? 'none'; }
	async respond(request) {
		const url = new URL(request.url);
		await new Promise((r) => setTimeout(r, 25));
		const parts = [];
		for (let i = 0; i < url.pathname.length; i++) parts.push(render_part(i));
		const stamp = Date.now() + ':' + Math.random().toFixed(6);
		return new Response('<p>' + parts.join('') + '</p>' + stamp + this.secret, {
			headers: { 'content-type': 'text/html' }
		});
	}
}
function render_part(i) { return '<b>' + i + '</b>'; }
`,
	'node_modules/fakekit/client.js': `
export let frames = 0;
export let ticks = 0;
export function frame() {
	frames++;
	if (frames < 10) requestAnimationFrame(frame);
}
export function tick() { ticks++; }
export function inc(el) { el.textContent = 'count: ' + (Number(el.textContent.slice(7)) + 1); }
export function seen(entries) { for (const e of entries) if (e.isIntersecting) e.target.dataset.seen = '1'; }
export function start() {
	requestAnimationFrame(frame);
	setInterval(tick, 100);
	const b = document.querySelector('.inc');
	b.addEventListener('click', () => inc(b));
	new IntersectionObserver(seen).observe(document.querySelector('.lazy'));
	fetch('/api/data').then((r) => r.text()).then((t) => { document.body.dataset.data = t; });
}
`,
	'server-entry.js': `export { Server } from 'fakekit/server.js';`,
	'client-entry.js': `import { start } from 'fakekit/client.js'; start();`
};

const PAGE = `<!doctype html><html><body>
<button class="inc">count: 0</button>
<div style="height: 3000px"></div>
<div class="lazy">lazy</div>
<script type="module" src="/app.js"></script>
</body></html>`;

async function build_fake_app(): Promise<{ dir: string; server_dir: string; client_dir: string }> {
	const dir = temp_dir('heisenbench-app-');
	write_files(dir, FRAMEWORK);
	const server_dir = join(dir, 'out', 'server');
	const client_dir = join(dir, 'out', 'client');
	const server = await rolldown({
		input: join(dir, 'server-entry.js'),
		cwd: dir,
		platform: 'node',
		plugins: counted_plugins({ packages: ['fakekit'], root: dir, target: 'server' })
	});
	await server.write({ dir: server_dir, format: 'esm', entryFileNames: 'index.js' });
	write_files(server_dir, { 'manifest-full.js': 'export const manifest = {};' });
	const client = await rolldown({
		input: join(dir, 'client-entry.js'),
		cwd: dir,
		platform: 'browser',
		plugins: counted_plugins({ packages: ['fakekit'], root: dir, target: 'client' })
	});
	await client.write({ dir: client_dir, format: 'esm', entryFileNames: 'app.js' });
	write_files(client_dir, { 'index.html': PAGE });
	return { dir, server_dir, client_dir };
}

test('snapshots cross a process boundary and subtract exactly', async () => {
	const m = await load_module<{ f: (n: number) => number }>(
		'export function f(n) { let s = 0; for (let i = 0; i < n; i++) s += i; return s; }'
	);
	rt.reset();
	m.f(3);
	const first = rt.snapshot();
	m.f(10);
	const second = rt.snapshot();
	const wire = deserialize_snapshot(
		JSON.parse(JSON.stringify(serialize_snapshot(rt, second))) as ReturnType<
			typeof serialize_snapshot
		>
	);
	const delta = snapshot_delta(wire, first);
	const info = { name: 'x', file: '', stable: true, timers: 0, runaway: false, error: null };
	rt.reset();
	m.f(10);
	const direct = build_case_report(rt, rt.snapshot(), info);
	assert.deepEqual(build_case_report(rt, delta, info), direct);
});

test('counted server: requests inside the measuring window, twice, the same counts', async () => {
	const app = await build_fake_app();
	const server = await CountedServer.start({
		server_dir: app.server_dir,
		static_dirs: [app.client_dir],
		env: { FAKE_SECRET: 's3' },
		cwd: app.dir
	});
	try {
		const { results, loaded } = await server.count(
			[{ name: 'GET /abc', requests: [{ path: '/abc' }], repeat: 3 }],
			'http://127.0.0.1',
			app.dir
		);
		const r = results[0];
		assert.equal(r.error, undefined);
		assert.deepEqual(r.statuses, [200, 200, 200]);
		assert.equal(r.report!.stable, true);
		const by = new Map(r.report!.functions.map((f) => [f.path, f]));
		assert.equal(by.get('Server > respond')?.calls, 3);
		assert.equal(by.get('render_part')?.calls, 12); // '/abc'.length per request
		assert.equal(r.report!.timers, 3); // one fake timer per request, run by the fake loop
		assert.ok(loaded['fakekit@1.2.3/server.js'].some((f) => f[0] === 'Server > init'));
		// served over HTTP for a browser: static files first, then the app
		const base = await server.listen();
		assert.match(await (await fetch(base + '/')).text(), /class="inc"/);
		assert.match(await (await fetch(base + '/x')).text(), /<b>0<\/b><b>1<\/b>.*s3$/);
		await server.close_http();
	} finally {
		await server.stop();
	}
});

let browser: PwBrowser | null = null;
after(async () => {
	await browser?.close();
	browser = null;
});
async function chromium(): Promise<PwBrowser | null> {
	if (!browser) {
		try {
			browser = await launch_browser();
		} catch (e) {
			console.log(`no browser: ${(e as Error).message.split('\n')[0]}`);
			return null;
		}
	}
	return browser;
}

test('browser session under virtual time: frames, timers, observers and clicks are exact', async (t) => {
	const b = await chromium();
	if (!b) return t.skip('no Chromium to run');
	const app = await build_fake_app();
	const server = await CountedServer.start({
		server_dir: app.server_dir,
		static_dirs: [app.client_dir],
		cwd: app.dir
	});
	try {
		const base = await server.listen();
		const session = {
			path: '/',
			load_ms: 1000,
			steps: [
				{ name: 'click', actions: [{ click: '.inc' }] },
				{ name: 'scroll', actions: [{ scroll: '.lazy' }], settle_ms: 64 }
			]
		};
		const a = await run_session(b, base, session);
		const again = await run_session(b, base, session);
		assert.deepEqual(a.errors, []);
		assert.deepEqual(
			a.phases.map((p) => p.name),
			['load /', 'click', 'scroll']
		);
		const runtime = (await import('../src/app/snapshot.ts')).runtime_for(a.runtimes[0]);
		const info = { name: 'x', file: '', stable: true, timers: 0, runaway: false, error: null };
		const calls = (i: number, s = a) => {
			const r = build_case_report(runtime, s.phases[i].snap, info);
			return Object.fromEntries(r.functions.map((f) => [f.path, f.calls]));
		};
		const load = calls(0);
		// ten frames, then the loop stops. The interval starts once the script has loaded (a frame
		// into the page's virtual time), so 1008 granted ms hold nine of its 100 ms periods.
		assert.equal(load.frame, 10);
		assert.equal(load.tick, 9);
		assert.equal(load.start, 1);
		assert.equal(load.seen, 1); // the observer's first report (not intersecting)
		// the click: one inc; 500 ms of settling is 32 frames (512 ms), which takes the page's
		// clock from 1008 to 1520 ms: the interval's ticks at 1016 ... 1516
		assert.deepEqual({ inc: calls(1).inc, tick: calls(1).tick }, { inc: 1, tick: 6 });
		// scrolled into view: the observer reports it on the next frame
		assert.equal(calls(2).seen, 1);
		// the second session counted exactly the same
		for (let i = 0; i < 3; i++) assert.deepEqual(calls(i, again), calls(i));
		// the page's own request to the app is handed back for the server to count
		assert.deepEqual(
			a.requests.map((r) => r.path),
			['/api/data']
		);
	} finally {
		await server.stop();
	}
});

test('run_scenario: browser phases and server cases as app cases, with the page view requests', async (t) => {
	const b = await chromium();
	if (!b) return t.skip('no Chromium to run');
	const app = await build_fake_app();
	const run = await run_scenario(
		{
			name: 'fake',
			server: [{ label: 'GET /p', unit: 'request', requests: [{ path: '/p' }] }],
			repeat: 2,
			browser: { path: '/', load_ms: 320, steps: [{ name: 'click', actions: [{ click: '.inc' }] }] }
		},
		{ dir: app.dir, server_dir: app.server_dir, static_dirs: [app.client_dir], ms: 0 },
		b
	);
	assert.deepEqual(run.errors, []);
	assert.equal(run.stable, true);
	assert.deepEqual(
		run.cases.map((c) => [c.name, c.app.unit, c.app.units]),
		[
			['fake › browser › load /', 'page load', 1],
			['fake › browser › click', 'interaction', 1],
			['fake › server › GET /p', 'request', 2],
			['fake › server › page view requests (1)', 'request', 2]
		]
	);
	assert.ok(run.loaded['fakekit@1.2.3/client.js'].some((f) => f[0] === 'inc'));
	assert.ok(run.loaded['fakekit@1.2.3/server.js'].some((f) => f[0] === 'Server > respond'));
});
