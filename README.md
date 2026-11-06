# ogygia benchmarks

The same apps built with [ogygia](https://github.com/ogygiajs/ogygia) and other Svelte 5 frameworks,
then measured the same way: page load, interaction latency, client navigation, memory, server cost,
bytes, build and lines of code. Five scenarios, each standing for a kind of site people build.

The first scenario, the blog, is a port of **[Stanislav Khromov's interactive-blogs-benchmark](https://github.com/khromov/interactive-blogs-benchmark)**.
The method, the line-up of islands versus whole-page hydration, and the idea of three posts of
growing length are his. This version runs on current tooling and adds ogygia. Thank you,
[@khromov](https://github.com/khromov).

## Scenarios

| scenario    | stands for                                   | what it has                                                                                         | what it stresses                                                         |
| ----------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `blog`      | content sites with a few widgets             | three posts of 8.8k, 23k and 71k words, five counters each                                          | JS that grows (or not) with the page; Lighthouse load                     |
| `docs`      | documentation sites                          | 300 generated pages, a 300-link sidebar, search (index loaded on first use), code tabs, a scroll-spy table of contents, prev/next | load, navigation over a reading session, search and tab INP             |
| `dashboard` | internal tools and admin apps                | four live KPI cards and a live chart (a tick every second), a static bar chart, a 1,000-row orders table with sort and filters | sort/filter INP, the cost of one live update, JS weight, render per request |
| `ai-chat`   | chat UIs over a streaming model              | a 120-message history (markdown, code, tool calls), replies streamed token by token from a deterministic local stream (no model) and rendered as markdown as they arrive, tool-call cards | time to first token on screen, INP while streaming, memory after a long conversation, the stream's first chunk |
| `shop`      | storefronts with personal bits on shared HTML | a 48-product grid and product pages, "Hello, name" and the cart count in the header, Add to cart     | load, time to the personal header, server cost per view, whether one copy of the HTML can be cached for everyone |

All content is generated and deterministic: `generate-posts.ts` and `scenarios/<name>/generate.ts`.
Each scenario keeps its UI and data in `scenarios/<name>/shared` (Svelte components, CSS, the
generated data); `scenarios/sync.ts` copies them into each app before it builds. Its browser
script, routes and checks are in `scenarios/<name>/scenario.ts`.

## Frameworks

Which frameworks are in and why (and which were looked at and left out) is in
[FRAMEWORKS.md](FRAMEWORKS.md).

| id           | blog | docs | dashboard | ai-chat | shop | how it builds the scenarios                                                        |
| ------------ | :--: | :--: | :-------: | :-----: | :--: | ---------------------------------------------------------------------------------- |
| `ogygia`     |  ✓   |  ✓   |     ✓     |    ✓    |  ✓   | SvelteKit + ogygia: `csr = false` server HTML, islands, server islands (PPR), its router |
| `sveltekit`  |  ✓   |  ✓   |     ✓     |    ✓    |  ✓   | SvelteKit: SSR or prerender, whole-page hydration, Kit's router                     |
| `astro`      |  ✓   |  ✓   |     ✓     |    ✓    |  ✓   | Astro + `@astrojs/svelte`: islands, server islands, the Node adapter where it needs a server |
| `mochi`      |  ✓   |  ✓   |     ✓     |    ✓    |  ✓   | Mochi on Bun: server rendering per request, islands, `mochi:defer` server islands    |
| `vike`       |      |  ✓   |     ✓     |    ✓    |  ✓   | Vike + `vike-svelte`: SSR or prerender, hydration, Vike's client routing, Hono server |
| `svelte-spa` |      |  ✓   |     ✓     |    ✓    |  ✓   | plain Svelte + Vite: client-rendered, data from JSON endpoints (the baseline)        |

The blog keeps its original four apps in `frameworks/<id>`. Scenario apps live in
`scenarios/<name>/apps/<id>`. Every app has its own exact version pins and installs on its own (no
workspace, no lockfile). The only thing that changes between runs is which ogygia gets installed.

### Fair play

- **Same UI and data.** Every app of a scenario renders the same shared components from the same
  generated data and links the same stylesheet. Before measuring, a fidelity check renders each
  app's check pages in a browser and compares what the scenario says must match (headings, counts,
  visible text length, the personal header). A scenario whose apps differ publishes no numbers
  (`results/fidelity.md`, `results/fidelity-scenarios.md`).
- **Each framework's own best practice.** Prerender where the framework would (docs), render per
  request where the page is per request (dashboard, chat, SvelteKit's and Vike's shop), islands
  with the directive the framework recommends, server islands where the framework has them
  (ogygia, Astro, Mochi in the shop), the framework's default router or full page loads. The
  choice is written at the top of each app's config.
- **No framework-specific cheats.** No hand-tuned bundles, no skipping work another app does, no
  caching the measurement can see. The two settings that differ from a default are there because
  the measurement would otherwise be wrong for everyone's real users: ogygia's shop turns off the
  per-IP rate limit of its server-island endpoint (the load test sends everything from one IP),
  and the Mochi apps set `proxy.origin` (Mochi's production CSRF check needs it).

## Metrics

Each metric is defined once, in `harness/metrics.ts` (name, unit, which way is better), with its
floor (the smallest change that counts) in `compare.ts`'s `FLOOR` table. A result key is
`<metric>` or `<metric>:<route|step>`. Timings are the median of N passes, and every pass's value
is kept beside it (`samples`); sizes and lines of code are exact.

| metric | what it is |
| --- | --- |
| `score`, `lcp`, `tbt`, `cls` | Lighthouse (mobile, simulated throttling, performance only) on the scenario's Lighthouse page(s) |
| `evalMs` | JS evaluation + parse/compile on the main thread during the load, from Lighthouse's trace, × its CPU slowdown (`harness/lighthouse.ts`) |
| `jsBr`, `htmlBr` | brotli bytes of every script / of the document a route loads cold, before any interaction or scroll; bare = average of the routes |
| `inp:<step>` | the worst Event Timing duration of the interactions one scripted step caused (Playwright input, 4× CPU throttle); `inp` = the worst step. Below 16 ms reads as 16 |
| `resp:<step>` | from the step's last input to its result on screen: the wait Event Timing cannot see (a fetch, a lazy island waking) |
| `navMs` | median time from a click on a link to the new page's heading on screen, over a scripted visit |
| `visitBr` | brotli bytes of every response in that visit |
| `heapMb` | JS heap (`JSHeapUsedSize`, after a forced GC) after the scenario's long session |
| `updateMs` | dashboard: the DOM-update work of one live tick, measured in the page |
| `ttft`, `streamMs` | ai-chat: from Send to the first / last token on screen |
| `personalMs` | shop: from navigation start to the visitor's greeting and cart count on screen |
| `ttfb`, `htmlMs` | server apps: sequential requests (median of 25), time to headers / to the whole document |
| `p50`, `p99`, `vps`, `reqsPerView` | server apps under load: 10 connections replay every request one page view makes to the server (document, data and server-island fetches, a batched POST included) with the visitor's cookies; latency, page views per second, requests per view |
| `ttfc`, `streamTotal` | ai-chat server apps: the stream's first chunk and its end, from Node |
| `cacheable` | shop: 1 when the page's HTML carries no visitor's personal content and allows shared caching (no `private`/`no-store`, no cookie set) |
| `buildMs`, `outBytes` | the app's `build` command, and every file in its client output except the scenario's shared static files |
| `loc`, `locCode`, `locConfig` | lines of code a developer wrote for the app (rule below) |

The browser sessions run in Chrome with 4× CPU throttling and a 40 ms, 10 Mbps down / 5 Mbps up
network applied per request, pages served uncompressed like the Lighthouse runs
(`harness/profile.ts`). A step waits for the page to be ready first: the load event, 500 ms with
no request in flight, then an idle callback.

**Lines of code** (`harness/loc.ts`): non-blank lines that are not only a comment, in the app's
own tracked `.svelte`, `.ts`, `.js`, `.astro` and `.html` files. Config (vite / svelte / astro
config, tsconfig) is counted apart from source. Left out: the scenario's shared components and
data, the blog's generated posts and copied counter, `package.json`, lockfiles, `node_modules`,
build output. The apps that hydrate the whole page render the scenario's shared page component
instead of writing the page's markup themselves; they are charged that component's lines.

## Run it locally

You need Node 22.18 or newer, pnpm, bun (for mochi only) and Chrome or Chromium. The scripts are
TypeScript run by plain `node`.

```bash
pnpm install

# build: every app of the blog and every scenario, or only ogygia + sveltekit with --fast
node build-all.ts
node build-all.ts --fast

# one scenario only (its generator, sync and every app of it)
node build-all.ts --no-blog --scenarios docs

# pick the ogygia to build: an npm version or dist-tag (default `latest`), or a pkg.pr.new build
OGYGIA_SPEC=0.11.4 node build-all.ts --fast
OGYGIA_SPEC=https://pkg.pr.new/ogygia@<sha7> node build-all.ts --fast

# the blog's mochi app is measured as a running server; start it in another terminal
# (scenario apps start their own servers)
cd frameworks/mochi && PORT=3335 MOCHI_KEY=dGVzdC1rZXktMzItYnl0ZXMtYmFzZTY0dXJsISEh bun run start

# measure: --passes N = Lighthouse passes on the blog, --scenario-passes N = passes per scenario
node benchmark.ts --out results/latest.md --json
node benchmark.ts --fast --passes 5 --scenario-passes 3 --out results/scratch/run.md --json

# one scenario, without the blog's Lighthouse run
node benchmark.ts --no-blog --scenarios docs --out results/scratch/docs.md --json

# A/B: two ogygia builds on this machine, taking turns, and the PR comment body for them
node build-all.ts --fast --spec https://pkg.pr.new/ogygia@<pr sha7> --base-spec https://pkg.pr.new/ogygia@<base sha7>
node benchmark.ts --fast --ab --passes 5 --scenario-passes 5 --out results/scratch/run.md --json
node compare.ts --run results/scratch/run.json
```

`OGYGIA_SPEC` (or `--spec`) is the one input. For a pkg.pr.new build, `build-all.ts` takes
`ogygia`, `@ogygia/core` and `@ogygia/content` from the same commit, for the blog app and every
scenario's ogygia app alike. For an npm version, core is whatever that ogygia depends on, and
content is the release that was current at the time (`OGYGIA_CONTENT_SPEC` overrides it).

Chrome comes from `CHROME_PATH`, else Playwright's Chromium if it is installed, else the system
Chrome. The `MOCHI_KEY` above is a fixed dummy value Mochi needs to start, not a secret (the
scenario apps get theirs, and a dummy `OGYGIA_SECRET`, from `harness/serve.ts`).

### Docker

```bash
docker compose up --build
OGYGIA_SPEC=0.11.4 BENCH_FAST=1 docker compose up --build
```

One image with Node, Chromium, pnpm and bun. Results land in `results/` on the host.

## ogygia PRs and main

ogygia's CI sends a `repository_dispatch` here after pkg.pr.new has published a commit. The
[`bench` workflow](.github/workflows/bench.yml) then:

- **`ogygia-pr`**: an A/B run. It builds every ogygia app twice, from
  `https://pkg.pr.new/ogygia@<sha7>` (the PR) and from the PR's base commit (`ogygia-base`, a copy
  of the same app), and measures the two in the same job on the same runner, taking turns: every
  pass measures both, PR then base, then base then PR, five passes on the blog's Lighthouse and on
  every scenario. It posts one comment on the PR and edits that same comment on later pushes. A
  newer push cancels a run that is still going. **Time budget: about 25 minutes** (job timeout 60).
- **`ogygia-main`**: runs every app of every scenario (about 75 minutes, timeout 120). The docs
  read this result; no PR is compared with it.
- **Weekly**: the same full run against `ogygia@latest`.
- **By hand** (`workflow_dispatch`): pick fast or full, any spec, the passes and which scenarios;
  give a base spec too for an A/B run. The result is an artifact only.

The PR comment is grouped by scenario: one summary table (a row per scenario: load, JS, INP,
navigation or streaming, server page views per second, lines of code, and how many metrics
regressed), then every metric of each scenario in its own collapsed `<details>`, with the PR's
median, the base's, the change and the lowest and highest of each build's repeats; every metric
that changed beyond noise also lists all its repeats, in pass order. A change within noise reads
as ≈ and the summary gives it no percent.

Results are kept on the orphan `results` branch:

- `main/latest.json`: the newest main run
- `main/<sha>.json`: every run for an ogygia main commit (`main/v<version>.json` for the weekly run)
- `pr/<number>.json`: the newest run for that ogygia PR
- `commit/<sha>.json`: the newest run of that ogygia commit (full sha), written by PR runs and main
  runs alike, so a PR can be followed through its commits and main through its history. It is the
  same JSON as the run's other file: `meta.sha` is the commit, `meta.pr` the PR of a PR run and
  `meta.base` the base commit measured beside it. A rerun of a commit replaces its file; the weekly
  release run has no sha and no commit file.

The ogygia docs read
`https://raw.githubusercontent.com/ogygiajs/bench/results/main/latest.json`. The JSON is what
`benchmark.ts --json` writes: the blog's fields at the top level as before (`posts`,
`frameworks[].rows`, `frameworks[].avg`, `frameworks[].samples`), a `meta` block (`ogygia`,
`spec`, `sha`, `pr` (a PR run), `mode`, `passes`, `scenarioPasses`, `scenarios`, `runner`, `runAt`, and `base` for
an A/B run), and beside them
`scenarios: { <name>: { title, routes, steps, frameworks: [{ id, approach, served, metrics, samples }] } }`.
`samples` holds every pass's value of each key that more than one pass measured.

A PR is only ever compared with its base measured in the same run. A result from another run is
another machine: the same SvelteKit app, unchanged, served 25 to 54 page views per second on the
dashboard across this repository's runs, depending on the runner it got. Within the run, a timing
counts as changed (worse or better) only when the two builds' repeats do not overlap (with five
each, a 1-in-126 chance either way for two builds that perform the same), the medians differ by
more than the larger spread (max − min) of the two builds' repeats, and the change is above the
metric's floor. Sizes and lines of code are measured once and exact: a regression when worse by
more than the floor. Both rules and the floors are in `compare.ts`.

The PR comment needs a token in the `BENCH_TOKEN` secret that can write comments on ogygiajs/ogygia.
Without it the run still happens and stores its result; it just skips the comment.

## Router and ops benchmarks

`router/run.ts` (navigation, prefetch, view transitions, memory) and `router/ops.ts` (ops/sec of
core's hot functions) measure ogygia from source, so they need a local ogygia checkout:

```bash
OGYGIA_REPO=../ogygia node router/run.ts --build
OGYGIA_REPO=../ogygia node router/ops.ts
```

They are not part of CI. Their last results are in `results/router-latest.md` and
`results/ops-latest.md`.

## License

MIT. See [LICENSE](LICENSE). The blog benchmark's design is Stanislav Khromov's; see his
[original repository](https://github.com/khromov/interactive-blogs-benchmark).
