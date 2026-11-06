# Frameworks

Which Svelte frameworks the benchmark compares, and why. Checked on npm and GitHub on 2026-11-03.
A framework is in when it is actively maintained, runs Svelte 5, and can build the scenarios with
its own normal tools.

## In

| id           | what it is                                             | version pinned                                      | latest release              | why                                                                                                                                                                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------ | --------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ogygia`     | SvelteKit + ogygia islands                             | `OGYGIA_SPEC` (npm/PR)                              | 0.11.4                      | The subject of the benchmark.                                                                                                                                                                                                                                                                                                           |
| `sveltekit`  | SvelteKit, SSR + whole-page hydration                  | kit 2.70.2, svelte 5.56.8                           | kit 3.1.1, 2026-10-29       | The reference. Same pins as the blog app; ogygia supports Kit `>=2.70.2 <4`, so a Kit 3 bump is one change across every Kit app.                                                                                                                                                                                                        |
| `astro`      | Astro islands with `@astrojs/svelte`                   | astro 7.4.5                                         | 7.4.5, 2026-11-02           | The best known islands framework. `@astrojs/svelte` 9.1.2 needs Svelte `^5.43.6`.                                                                                                                                                                                                                                                       |
| `mochi`      | Mochi, Svelte 5 SSR islands on Bun                     | mochi-framework 0.9.1                               | 0.9.1, 2026-07-30           | khromov's islands framework; repo pushed 2026-10-30. Needs Bun, runs as a server.                                                                                                                                                                                                                                                       |
| `svelte-spa` | plain Svelte + Vite, client-rendered SPA               | svelte 5.56.8, vite 8.3.5                           | (Svelte 5.57.3, 2026-10-26) | **New.** The baseline: no SSR, no framework runtime, one bundle. Shows what SSR and islands buy (or cost) against the simplest build. Also stands in for SvelteKit's SPA mode (see below).                                                                                                                                              |
| `vike`       | Vike + `vike-svelte`, SSR + hydration + client routing | vike 0.4.268, vike-svelte 1.0.1, @vikejs/hono 0.4.1 | vike 0.4.268, 2026-11-01    | **New.** The main non-Kit Svelte metaframework. Vike is very active. `vike-svelte` is pinned to 1.0.1 on purpose: 1.1.0 (2026-05-16, the latest) fails every render with `ReferenceError: RenderStack is not defined` (brandonxiang/vike-svelte#31; fixed on `main` 2026-07-22, not released). 1.0.1 builds and hydrates Svelte 5 fine. |

## Out

| candidate                          | why not                                                                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SvelteKit SPA mode (`ssr = false`) | A mode of a framework already in, not a framework. Its numbers sit between `sveltekit` and `svelte-spa`; the plain SPA is the cleaner baseline. Easy to add later as a build variant of the Kit apps. |
| SvelteKit prerender / static mode  | Not a separate row: each scenario already uses the Kit mode that is best practice for it (prerender for the blog and docs, SSR for dashboard, chat and shop).                                         |
| Elder.js                           | Unmaintained: last release `1.8.0-beta.14` in 2023, repo last pushed 2022-11, Svelte 3 only.                                                                                                          |
| Routify 3                          | A file-based SPA router rather than a framework; last code change 2025-10 (3.6.4, 2025-09). Overlaps the plain SPA baseline.                                                                          |
| HonoX                              | No Svelte support: pages and islands are hono/jsx (or React). Hono alone with hand-written Svelte SSR would be our framework, not theirs.                                                             |
| îles                               | Pages and layouts are Vue; Svelte is only a guest island renderer. One release (0.10.0, 2026-03) after a two-year gap.                                                                                |
| Inertia (`@inertiajs/svelte` 3)    | Needs a backend framework (Laravel, Rails, ...) to own routing and rendering; out of scope for a Node/Bun comparison.                                                                                 |
| Eleventy + `is-land`               | Framework-neutral islands for Eleventy; rendering Svelte needs third-party plugins. Not a Svelte framework.                                                                                           |
| TanStack Start                     | No Svelte adapter published (React and Solid only).                                                                                                                                                   |
| Sapper, Sveltepress                | Sapper is retired; Sveltepress is built on SvelteKit (last release 2024-02).                                                                                                                          |

## Where each one runs

The blog keeps its four apps (`ogygia`, `sveltekit`, `astro`, `mochi`) unchanged. The four new
scenarios (docs, dashboard, ai-chat, shop) have all six; `frameworks.config.json` lists them. Every
framework could build every scenario its own way, so none is left out. Two things needed care and
are written in the apps: `vike-svelte` is pinned to 1.0.1 (above), and Astro's server-island
fallback in the shop is written as plain HTML, because Astro's swap stops at the first comment node
and a Svelte component's output starts with one.
