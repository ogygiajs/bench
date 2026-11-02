// Runs the scenarios: for each one, boot its apps, check they render the same thing, then measure
// every metric the scenario defines. Called by benchmark.ts; returns the JSON's `scenarios` block.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { bootApp } from './serve.ts';
import { launchBrowser, openSession, routeWeight } from './browser.ts';
import { runLighthouse, startChrome } from './lighthouse.ts';
import { cacheability, loadTest, renderTime, streamTiming } from './server.ts';
import { BROWSER, SERVER } from './profile.ts';
import { linesOfCode } from './loc.ts';

export const SCENARIOS = ['blog', 'docs', 'dashboard', 'ai-chat', 'shop'];

const median = (xs) => {
	const s = xs.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
	if (!s.length) return null;
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (n, d = 0) => (n == null ? null : Number(n.toFixed(d)));
const log = (...a) => console.error(...a);

/** The apps of one scenario, from frameworks.config.json. The blog reuses the top-level list. */
function appsOf(cfg, name) {
	if (name === 'blog')
		return cfg.frameworks.map((fw) => ({
			...fw,
			dir: fw.url ? `frameworks/${fw.id}` : '.',
			buildDir: `frameworks/${fw.id}`
		}));
	return (cfg.scenarios?.[name]?.apps ?? []).map((a) => ({ ...a, buildDir: a.dir }));
}

function readBuild(root, app) {
	try {
		return JSON.parse(readFileSync(join(root, app.buildDir, '.bench-build.json'), 'utf8'));
	} catch {
		return null;
	}
}

/** Merge the metric maps of several passes: the median of each key. */
function mergePasses(runs) {
	const keys = new Set(runs.flatMap((r) => Object.keys(r)));
	const out = {};
	for (const k of keys) out[k] = median(runs.map((r) => r[k]));
	return out;
}

/** One pass of the scenario's browser session; returns its metrics. */
async function sessionPass(browser, scenario, target) {
	const s = await openSession(browser, target.base, { cookies: scenario.cookies ?? [] });
	try {
		await scenario.session(s);
		const m = { ...s.metrics };
		const interacts = s.steps.filter((x) => x.kind === 'interact');
		const navs = s.steps.filter((x) => x.kind === 'nav');
		if (interacts.length) {
			m.inp = Math.max(...interacts.map((x) => x.inp));
			m.resp = Math.max(...interacts.map((x) => x.resp));
		}
		if (navs.length) {
			m.navMs = median(navs.map((x) => x.ms));
			m.visitBr = await s.bytes();
		}
		if (scenario.long) {
			await scenario.long(s);
			m.heapMb = await s.heap();
		}
		return m;
	} finally {
		await s.close();
	}
}

/** The requests one cold view of `path` makes to the app's server (document, data, fragments). */
async function viewRequests(browser, scenario, target, path) {
	const s = await openSession(browser, target.base, { cookies: scenario.cookies ?? [], throttle: false });
	try {
		await s.goto(path);
		return s.serverRequests();
	} finally {
		await s.close();
	}
}

/** Render the same check page in every app and compare what the scenario says must match. */
async function fidelity(browser, scenario, targets, lines) {
	const prints = new Map();
	for (const t of targets) {
		const s = await openSession(browser, t.base, { cookies: scenario.cookies ?? [], throttle: false });
		try {
			const parts = [];
			for (const path of scenario.fidelity.paths) {
				await s.goto(path);
				parts.push(await s.page.evaluate(scenario.fidelity.print));
			}
			prints.set(t.app.id, parts.join('\n'));
		} catch (e) {
			prints.set(t.app.id, `ERROR ${e?.message ?? e}`);
		} finally {
			await s.close();
		}
	}
	const ids = [...prints.keys()];
	const ref = prints.get(ids[0]);
	let ok = true;
	for (const id of ids) {
		const same = prints.get(id) === ref && !ref.startsWith('ERROR');
		if (!same) ok = false;
		lines.push(`- **${id}**: ${same ? 'matches' : 'DIFFERS'} · \`${prints.get(id).replace(/\s+/g, ' ').slice(0, 160)}\``);
	}
	return ok;
}

async function runOne(root, cfg, name, opts, browser, chrome, lines) {
	const scenario = (await import(resolve(root, 'scenarios', name, 'scenario.ts'))).default;
	const apps = appsOf(cfg, name).filter((a) => !opts.skip.has(a.id) && (!opts.fast || a.fast));
	lines.push(`## ${name}`, '');
	const targets = [];
	for (const app of apps) {
		try {
			const booted = await bootApp(root, app, scenario.ready ?? '/');
			if (!booted) {
				log(`  ! ${name}/${app.id}: not built, skipped`);
				lines.push(`- **${app.id}**: SKIP (not built)`);
				continue;
			}
			targets.push({ app, ...booted });
		} catch (e) {
			log(`  ! ${name}/${app.id}: failed to start: ${e.message}`);
			lines.push(`- **${app.id}**: FAIL (did not start)`);
		}
	}
	const result = {
		title: scenario.title,
		routes: Object.keys(scenario.routes),
		steps: scenario.stepNames ?? [],
		frameworks: []
	};
	try {
		if (!targets.length) return result;
		log(`▸ ${name}: fidelity`);
		const ok = opts.skipFidelity || (await fidelity(browser, scenario, targets, lines));
		lines.push('', ok ? '**PASS**' : '**FAIL**, no numbers for this scenario', '');
		if (!ok) {
			result.error = 'fidelity check failed';
			return result;
		}

		const per = new Map(targets.map((t) => [t.app.id, { passes: [], lh: [], errors: [] }]));

		// Sizes are the same every run: measured once.
		for (const t of targets) {
			const m = {};
			const all = [];
			for (const [rid, path] of Object.entries(scenario.routes)) {
				try {
					const w = await routeWeight(browser, t.base, path, { cookies: scenario.cookies ?? [] });
					m[`jsBr:${rid}`] = w.jsBr;
					m[`htmlBr:${rid}`] = w.htmlBr;
					all.push(w);
				} catch (e) {
					per.get(t.app.id).errors.push(`weight ${rid}: ${e.message}`);
				}
			}
			if (all.length) {
				m.jsBr = Math.round(all.reduce((s, w) => s + w.jsBr, 0) / all.length);
				m.htmlBr = Math.round(all.reduce((s, w) => s + w.htmlBr, 0) / all.length);
			}
			per.get(t.app.id).fixed = m;
		}

		for (let pass = 1; pass <= opts.passes; pass++) {
			log(`▸ ${name}: pass ${pass}/${opts.passes}`);
			for (const t of targets) {
				const slot = per.get(t.app.id);
				try {
					const m = await sessionPass(browser, scenario, t);
					slot.passes.push(m);
					log(
						`  ${t.app.id}: ${['inp', 'resp', 'navMs', 'heapMb', 'ttft']
							.filter((k) => m[k] != null)
							.map((k) => `${k} ${round(m[k], 1)}`)
							.join(', ')}`
					);
				} catch (e) {
					slot.errors.push(`session pass ${pass}: ${e.message.split('\n')[0]}`);
					log(`  ! ${t.app.id}: session failed: ${e.message.split('\n')[0]}`);
				}
				for (const rid of scenario.lighthouse ?? []) {
					try {
						slot.lh.push(await runLighthouse(t.base + scenario.routes[rid], chrome.port, BROWSER.acceptEncoding));
					} catch (e) {
						slot.errors.push(`lighthouse ${rid}: ${e.message}`);
					}
				}
			}
		}

		for (const t of targets) {
			const slot = per.get(t.app.id);
			const metrics = { ...slot.fixed, ...mergePasses(slot.passes) };
			if (slot.lh.length) Object.assign(metrics, mergePasses(slot.lh));

			if (t.kind === 'server' && scenario.server) {
				log(`  ${t.app.id}: server`);
				try {
					const path = scenario.routes[scenario.server.route];
					const cookies = scenario.cookies ?? [];
					Object.assign(metrics, await renderTime(t.base, path, { cookies }));
					const recorded = await viewRequests(browser, scenario, t, path);
					const view = recorded.length ? recorded : [{ method: 'GET', path }];
					metrics.reqsPerView = view.length;
					const load = await loadTest(t.base, view, {
						cookies,
						duration: opts.fast ? SERVER.duration.fast : SERVER.duration.full
					});
					if (!load.ok) slot.errors.push(`load test: ${load.non2xx} non-2xx, ${load.errors} errors`);
					metrics.p50 = load.p50;
					metrics.p99 = load.p99;
					metrics.vps = load.vps;
					metrics.reqsPerView = load.reqsPerView;
					if (scenario.server.stream) Object.assign(metrics, await streamTiming(t.base, scenario.server.stream));
				} catch (e) {
					slot.errors.push(`server: ${e.message}`);
				}
			}
			if (scenario.cacheability && t.kind === 'server') {
				try {
					const c = await cacheability(t.base, scenario.routes[scenario.cacheability.route], scenario.cacheability.visitors);
					metrics.cacheable = c.cacheable;
					if (c.reasons.length) slot.notes = c.reasons;
				} catch (e) {
					slot.errors.push(`cacheability: ${e.message}`);
				}
			} else if (scenario.cacheability) {
				// A static build is the same file for everyone by construction.
				metrics.cacheable = 1;
			}

			const build = readBuild(root, t.app);
			if (build && name !== 'blog') {
				metrics.buildMs = build.buildMs;
				metrics.outBytes = build.outBytes;
			}
			const composition = [scenario.composition ?? []].flat().map((f) => `scenarios/${name}/shared/${f}`);
			Object.assign(metrics, linesOfCode(root, t.app.buildDir, composition) ?? {});
			const clean = {};
			for (const [k, v] of Object.entries(metrics)) if (v != null) clean[k] = round(v, k === 'cls' || k === 'heapMb' ? 3 : k.startsWith('inp') ? 0 : 1);
			result.frameworks.push({
				id: t.app.id,
				approach: t.app.approach,
				served: t.kind,
				metrics: clean,
				...(slot.notes ? { notes: slot.notes } : {}),
				...(slot.errors.length ? { errors: slot.errors } : {})
			});
		}
		return result;
	} finally {
		for (const t of targets) await t.stop();
	}
}

/** Run the named scenarios; returns `{ [name]: result }` and writes the fidelity report. */
export async function runScenarios(root, cfg, opts) {
	const names = (opts.names ?? SCENARIOS).filter((n) => SCENARIOS.includes(n) && existsSync(join(root, 'scenarios', n, 'scenario.ts')));
	const lines = [
		'# Scenario fidelity',
		'',
		'Every app of a scenario must render the same thing on its check pages (the scenario defines what is compared).',
		''
	];
	const out = {};
	if (!names.length) return out;
	const browser = await launchBrowser();
	const chrome = await startChrome();
	try {
		for (const name of names) {
			try {
				out[name] = await runOne(root, cfg, name, opts, browser, chrome, lines);
			} catch (e) {
				log(`  ! scenario ${name} failed: ${e.stack ?? e}`);
				out[name] = { error: String(e.message ?? e), frameworks: [] };
			}
		}
	} finally {
		await browser.close();
		await chrome.kill();
		const file = resolve(root, 'results/fidelity-scenarios.md');
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, lines.join('\n') + '\n');
	}
	return out;
}
