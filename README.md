# ogygia benchmarks

How much JavaScript does a long blog post with a few interactive widgets ship, and does that grow
with the length of the post? This repo builds the same page with [ogygia](https://github.com/ogygiajs/ogygia)
and three other setups, then measures each one with Lighthouse.

It is a port of **[Stanislav Khromov's interactive-blogs-benchmark](https://github.com/khromov/interactive-blogs-benchmark)**.
The method, the line-up of islands versus whole-page hydration, and the idea of three posts of
growing length are his. This version runs on current tooling and adds ogygia. Thank you,
[@khromov](https://github.com/khromov).

## What it measures

Every app renders the same three posts (about 8.8k, 23k and 71k words), each with five `Counter`
buttons. The prose is static; the counters are the only interactive parts. For every app and post:

- **JS size**: every script the page loads, raw and brotli.
- **HTML size**: raw and brotli.
- **Lighthouse** (mobile, simulated throttling, performance only): score, LCP, CLS, TBT.
- **JS eval time** (script evaluation + parse/compile on the main thread during the page load, from
  Lighthouse's trace, scaled by its CPU slowdown) and **DOM element count**.

Islands should ship about the same JS on all three posts. Whole-page hydration ships more as the post
grows. Before measuring, a fidelity check makes sure every app rendered the same prose, headings and
five counters, and refuses to publish numbers if not (`results/fidelity.md`).

The posts are synthetic (`generate-posts.ts`), so upstream's article text is not redistributed.

## Frameworks

| id          | approach                       | tooling                            |
| ----------- | ------------------------------ | ---------------------------------- |
| `ogygia`    | Svelte 5 islands               | SvelteKit + ogygia (`OGYGIA_SPEC`) |
| `sveltekit` | Svelte 5, whole-page hydration | SvelteKit                          |
| `astro`     | Svelte 5 islands               | Astro                              |
| `mochi`     | Svelte 5 islands               | [Mochi](https://mochi.fast/), bun  |

Each app lives in `frameworks/<id>` with its own exact version pins and installs on its own (no
workspace, no lockfile). The only thing that changes between runs is which ogygia gets installed.

## Run it locally

You need Node 22.18 or newer, pnpm, bun (for mochi only) and Chrome or Chromium. The scripts are
TypeScript run by plain `node`.

```bash
pnpm install

# build: every app, or only ogygia + sveltekit with --fast
node build-all.ts
node build-all.ts --fast

# pick the ogygia to build: an npm version or dist-tag (default `latest`), or a pkg.pr.new build
OGYGIA_SPEC=0.11.4 node build-all.ts --fast
OGYGIA_SPEC=https://pkg.pr.new/ogygia@<sha7> node build-all.ts --fast

# full runs measure mochi as a running server; start it in another terminal
cd frameworks/mochi && PORT=3335 MOCHI_KEY=dGVzdC1rZXktMzItYnl0ZXMtYmFzZTY0dXJsISEh bun run start

# measure: --passes N reports the median of N Lighthouse runs per page
node benchmark.ts --out results/latest.md --json
node benchmark.ts --fast --passes 5 --out results/scratch/run.md --json

# the PR comment body, from two result files
node compare.ts --pr results/scratch/run.json --base results/latest.json
```

`OGYGIA_SPEC` (or `--spec`) is the one input. For a pkg.pr.new build, `build-all.ts` takes
`ogygia`, `@ogygia/core` and `@ogygia/content` from the same commit. For an npm version, core is
whatever that ogygia depends on, and content is the release that was current at the time
(`OGYGIA_CONTENT_SPEC` overrides it).

Chrome comes from `CHROME_PATH`, else Playwright's Chromium if it is installed, else the system
Chrome. The `MOCHI_KEY` above is a fixed dummy value Mochi needs to start, not a secret.

### Docker

```bash
docker compose up --build
OGYGIA_SPEC=0.11.4 BENCH_FAST=1 docker compose up --build
```

One image with Node, Chromium, pnpm and bun. Results land in `results/` on the host.

## ogygia PRs and main

ogygia's CI sends a `repository_dispatch` here after pkg.pr.new has published a commit. The
[`bench` workflow](.github/workflows/bench.yml) then:

- **`ogygia-pr`**: builds ogygia from `https://pkg.pr.new/ogygia@<sha7>`, runs the fast set
  (ogygia + sveltekit) five times, and compares it with the main baseline. It posts one comment on
  the PR and edits that same comment on later pushes. A newer push cancels a run that is still
  going.
- **`ogygia-main`**: runs every framework and stores the result as the new baseline.
- **Weekly**: the same full run against `ogygia@latest`.
- **By hand** (`workflow_dispatch`): pick fast or full and any spec. The result is an artifact only.

Results are kept on the orphan `results` branch:

- `main/latest.json`: the newest baseline
- `main/<sha>.json`: every run for an ogygia main commit (`main/v<version>.json` for the weekly run)
- `pr/<number>.json`: the newest run for that ogygia PR

The ogygia docs read
`https://raw.githubusercontent.com/ogygiajs/benchmarks/results/main/latest.json`. The JSON is what
`benchmark.ts --json` writes, with a `meta` block (`ogygia`, `spec`, `sha`, `mode`, `passes`,
`runAt`).

A change counts as a regression only when it is worse than the baseline by more than a noise floor.
The floors are defined once, at the top of `compare.ts`. The comment also shows how much the plain
SvelteKit app moved between the two runs, since that app never changes: if it moved a lot, so did
the runner.

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

MIT. See [LICENSE](LICENSE). The benchmark design is Stanislav Khromov's; see his
[original repository](https://github.com/khromov/interactive-blogs-benchmark).
