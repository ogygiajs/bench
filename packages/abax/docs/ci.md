# Abax in CI

Abax runs on ogygia's source from this repository. The bench files live in the ogygia repository
next to the code they measure; this repository holds the engine and the job that runs it.

## Where things live

In [ogygiajs/ogygia](https://github.com/ogygiajs/ogygia):

| Path                              | What                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/<pkg>/bench/*.bench.ts` | The bench files. 11 files, 57 cases today.                                                             |
| `internal/abax/package.json`      | The Abax commit ogygia is pinned to (`"abax": { "repo", "ref" }`).                                     |
| `internal/abax/src/abax.ts`       | Links `node_modules/@bench/abax` to `ABAX_DIR` when set, else to a clone of the pinned commit.         |
| `internal/abax/src/types.ts`      | `pnpm bench:types`: writes `packages/<pkg>/bench/__abax.d.ts` (gitignored) with `abax dts`.            |
| `internal/abax/src/check.ts`      | `pnpm check:bench`: writes the types, then type-checks every bench directory.                          |
| `internal/abax/src/preload.ts`    | Maps `virtual:ogygia/*` and `$app/*` to the unit-test stubs, so modules written for Vite load in Node. |
| `internal/abax/src/unmeasured.ts` | `pnpm bench:unmeasured`: the measurement-source gate.                                                  |
| `internal/abax/unmeasured.json`   | Exemptions for the gate.                                                                               |
| `.github/workflows/abax.yml`      | Asks this repository for a run on every PR, and runs the gate.                                         |

In this repository:

| Path                          | What                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/abax`               | The engine.                                                                                                          |
| `packages/compare`            | The no-overlap noise rule and the one PR comment with sections.                                                      |
| `suites/ogygia`               | Checks out ogygia commits, picks bench files, runs Abax, writes the section and JSON.                                |
| `.github/workflows/abax.yml`  | The job.                                                                                                             |
| `.github/workflows/check.yml` | Tests, lint, format, `abax verify` and 60 fuzzed programs on fixed seeds, on every PR and push to main of this repo. |
| `.github/workflows/fuzz.yml`  | The fuzzer every night at 02:23 UTC on new seeds; repros kept as an artifact.                                        |

## A PR, step by step

1. **ogygia asks.** ogygia's `abax.yml` runs on `opened`, `synchronize`, `reopened` and
   `ready_for_review`. Its `request` job sends a `repository_dispatch` of type `ogygia-abax` here,
   with the PR number, the head commit and the base commit. Drafts, forks and the release PR are
   skipped. Without `BENCH_TOKEN` it skips with a notice; a refused request only warns. Abax builds
   from source, so it does not wait for a published preview.
2. **The run plans.** This repository's `abax.yml` checks the payload in a `plan` job, then the
   `measure` job installs Abax and the suite (`pnpm install --filter '@bench/ogygia...'`) on
   Node 26. A newer push to the same PR cancels the older run. The measure job times out after
   45 minutes.
3. **Checkouts.** `suites/ogygia` clones ogygia once, then makes a tree per commit
   (`trees/<sha12>`): checked out, `pnpm install --frozen-lockfile`, and the bench types written by
   the tree's own `internal/abax/src/types.ts`, with `ABAX_DIR` pointing at this checkout's
   `packages/abax`. Both trees use the Abax that measures, not the pinned one.
4. **The base.** The PR is measured against the merge base of its head and its base, not the tip
   of the base branch.
5. **Selection.** The changed files between the merge base and the head. For each bench file, its
   static import graph through Node's own resolver (`import.meta.resolve`, so package `exports`
   and workspace links resolve as they will at run time), into `.svelte` script blocks, stopping at
   `node_modules`. A bench file runs when its graph reaches a changed file. A manifest
   (`package.json`, `tsconfig*.json`) is in no graph but decides how the files under it resolve
   (an `exports` or `imports` map), so a changed one runs every bench file whose graph has a file
   under its directory. A change to the root `package.json`, a root `tsconfig*.json`, `.npmrc`,
   `pnpm-lock.yaml`, `pnpm-workspace.yaml` or anything under `internal/abax/` runs them all.
6. **Counting.** Each selected bench file runs in its own processes, on the head tree and the base
   tree at once: `abax run`, `abax health`, and `abax growth --scaled on`. The bench files of a
   tree run side by side, each tree on half the cores. Counts, engine health and growth come out
   the same under any load, so nothing waits for a quiet machine here. Engine health runs each
   case twice on every run, PRs included: only that check can mark a function or inline cache V8
   did not repeat, and a marked one never becomes a finding. One bad file costs only its own
   cases. Each command has a time limit: 15 minutes for `run` and `health`, 5 for `growth`. Each
   runs in a process group of its own, so the limit kills the children Abax starts too (health
   and measure children), and none outlives its command. An exit other than 0 (clean) or 1 (a case
   failed), a signal or the limit is listed as an error for that file, even when the report has
   its part. The per-file reports merge into one report per tree. Before the files ran side by
   side, on a 4-core runner a PR with 11 bench files spent per tree about 2 minutes on engine
   health, 2.4 on growth and 25 seconds on counting, then 5.4 minutes on timing.
7. **The diff.** `diffReports` and `diffSections` with `git diff -M --unified=0` between the merge
   base and the head.
8. **Time.** `abax time` loads both trees in one process and times the selected bench files in
   turns, 5 each, on fresh copies of both trees each turn; a case that looks changed gets 5 more
   (20-minute limit). This is the one step that needs the machine to itself, so it runs alone.
9. **Real-app weight.** The job reads `abax/main/app-weights.json` from the `results` branch (the
   newest main run's, see [Full runs](#full-runs)) and ranks the changed functions by it: the
   change per call times the calls per unit of real work (`rank_changes`). Weights counted on
   another Node, V8, platform or steps-to-ns weights (`envMismatch`) are not used, and neither are
   missing ones: the section says which, in one line.
10. **Worst-case search.** `abax search` on the cases with a changed function that declare an
    input (a static `setup` in the bench file), biggest change first, at most 8, on the PR tree and
    then the base. The whole layer has 4 minutes; each search gets an even share of what is left,
    at most 30 seconds, and the cases the budget does not reach are counted as skipped. A case is
    flagged by Abax's own rule: its worst input costs at least 4 times its typical one, and at
    least twice the base's ratio.
11. **Store and post.** The measure job uploads `suites/ogygia/out` as an artifact. The `publish`
    job checks it (below), then `result.json` goes to the `results` branch and `section.md`
    becomes the `abax` section of the PR's comment.

### Who can write

Steps 3 to 10 run ogygia's code: its install scripts, Vite, the bench files. So they run in a job
that can write nothing: `contents: read`, no secrets, and `persist-credentials: false`, so no
token is left in `.git/config` for that code to find.

The `publish` job holds the write token and `BENCH_TOKEN`. It checks out only this repository's
`packages/compare` (no install) and runs nothing from the measure job or from ogygia. It reads the
artifact as data with `packages/compare/src/validate-artifact.ts`: only `result.json` and
`section.md`, each a regular file under its size limit, the JSON parsed, its kind, commit, base
and PR equal to what the `plan` job decided, and no section markers in the markdown. Paths come
from the plan, never from the artifact. When the measure job failed, or the artifact does not
pass, the publish job still rewrites the PR's section with a line saying so.

The app benchmark's `bench.yml` has the same three jobs.

A case that only the PR has is listed under "New cases", one only the base has under "Removed
cases". A bench file that does not load on one side is listed under "Did not run" with the error.

## Full runs

- **A push to ogygia's main.** After ogygia publishes the commit, its `pkg-pr-new.yml` sends
  `ogygia-main`. That runs the app benchmark and Abax.
- **Nightly**, at 03:41 UTC, on ogygia's main head.
- **By hand.** `workflow_dispatch` with `sha`, and optionally `base_sha` for a PR-style run and
  `pr` plus `comment_repo` to post the section to a PR. A manual run is kept as an artifact only.

A full run takes every bench file of one commit through `run`, `health` and `growth`, with every
plain-build layer on `run` (`--measure all`: time, real bytes, leaks), and writes one summary
table: steps, allocations, estimated and real bytes, p50 and leaks per case. It has 120 minutes.

A main or nightly run also counts the real apps, in an `app-weights` job beside the full run
(read-only like it, 60 minutes): it waits for the commit's pkg.pr.new build, builds the ogygia app
of the blog and of every scenario (`build-all.ts --only ogygia`) on Node 22, as the app benchmark
does, counts every scenario with `suites/apps/abax/run.ts` on Node 26, the Node PR counts are
taken on, and turns the app report into weights with `suites/ogygia/src/app-weights.ts`: the same
file `abax weights` writes, labelled with the commit and stamped with the Node and V8 that counted
it. A `publish-weights` job checks the artifact (schema, the commit) and stores it on the
`results` branch. A manual run with `app_weights` counts them too and keeps them as an artifact
only.

Every main push has its own concurrency group, and the nightly run has another, so no full run
cancels or replaces another (GitHub keeps only one waiting run per group, so a shared group would
drop pushes). Full runs can overlap; `abax/main/latest.json` and `abax/main/app-weights.json` move
only to a commit that is not behind the one they hold.

## The comment

Each ogygia PR has one benchmark comment, found by the marker on its first line:

```md
<!-- ogygia-benchmarks -->
### ogygia benchmarks

<!-- section:abax -->
...
<!-- /section:abax -->

<!-- section:apps -->
...
<!-- /section:apps -->
```

`node packages/compare/src/upsert-comment.ts --repo <owner/name> --pr <n> --section abax --file section.md`
finds the comment (or creates it), replaces only the named section, and keeps the others. It
only takes a comment written by the token's own login: the login `GET /user` returns, or
`github-actions[bot]` for a token that endpoint refuses. A GitHub App token comments as
`<app>[bot]`, so pass `--bot-login` (or set the `BENCH_BOT_LOGIN` repository variable). A marker
pasted into anyone else's comment is ignored. A body longer than GitHub's 65,536 characters is cut
before it is sent: each section gets a fair share of the room, and a cut section ends with a note
that links the run. `abax` comes before `apps`. A comment from before sections reads as one `apps`
section and is migrated on the first upsert. If the Abax run fails, the publish job still rewrites
its section with a line saying the run failed and a link, so a PR never shows counts for an older
commit as if they were current.

The `abax` section, in order:

1. **The header.** Which commits, how many bench files reach the PR's changes, and a link to the
   run. One line when PR and base were counted in different environments. A collapsed list of
   the bench files that ran and the changed file each one reaches, and the files that did not run
   (a command that crashed or timed out, a file that did not load), each with its error's first
   line.
2. **Real-app weight.** The changed functions that cost the app scenarios most per unit of real
   work, at most 5 rows: Δ per call, heavy, warm or cold path, and the steps (and estimated ns)
   per unit. Or one line saying why nothing is ranked.
3. **Steps per function.** One row per changed function per case: self steps base to PR, the Δ
   with its percent and the estimated ns, Δ allocations, Δ bytes, Δ inclusive steps.
4. **Where.** Collapsed: the lines the change sits on, with Δ steps, allocations and bytes, and
   "new code" for lines inside a changed hunk.
5. **Leaks, elided allocations, time-led cases**, when there are any.
6. **Engine.** New deopts, lost optimizations, inline caches that got worse, per case and line.
   Cases where V8 did not do the same thing twice are listed as unstable.
7. **Growth.** Cases whose curve class changed, and a collapsed list of the ones that kept it.
8. **Worst-case search.** One line: how many cases were searched in how much of the budget, and
   one more line for each flagged case, with its worst input.
9. **Time.** The time table for every case of the selected files.

Every list is capped (20 bench files, 10 files that did not run, 15 engine and growth findings)
with a count of the rest, which are in `result.json`. Names and errors are escaped for markdown
tables.

[sample-comment.md](sample-comment.md) is a complete one, from a real run.

## The results branch

Every run is kept on the orphan `results` branch of this repository, next to the app benchmark's
files, under `abax/`:

| Path                               | What                                                       |
| ---------------------------------- | ---------------------------------------------------------- |
| `abax/pr/<number>.json`            | The newest run of that PR.                                 |
| `abax/commit/<sha>.json`           | The newest run of that ogygia commit, PR or main.          |
| `abax/main/<sha>.json`             | A full run of a main commit.                               |
| `abax/main/latest.json`            | The newest full run.                                       |
| `abax/main/app-weights.json`       | Real-app weights of the newest main run: what PRs rank by. |
| `abax/main/app-weights/<sha>.json` | Real-app weights of that main commit.                      |

Each run file is a `result.json` (`schema: "ogygia-abax/1"`): `meta` (kind, PR, commits, the Abax
commit that counted, the Node version, the run URL, the layers measured), `selection`, the `head`
and `base` reports, the `diff`, load errors, the time comparison and, for a PR, the weight ranking
and the search. A weights file is `abax-app-weights/1` plus `node` and `env`. The publish job only adds files
under `abax/`, and retries its push with a rebase when another run pushed first.

## Running it locally

```bash
# a PR-style run: head against base (a clone of ogygia, or a local checkout's path as --repo)
node suites/ogygia/src/cli.ts --sha <head> --base <base> --out suites/ogygia/out

# a full run of one commit, every layer
node suites/ogygia/src/cli.ts --sha <commit> --out suites/ogygia/out

cat suites/ogygia/out/section.md
```

Options: `--repo` (default the ogygia repository on GitHub), `--work` (clones and trees, default
`.work`, reused across runs), `--measure time,bytes,leaks|all|none`, `--time off`,
`--weights app-weights.json` (rank a PR by those weights), `--search-budget <seconds>` (default
240, `0` turns the search off). On an M4 Max,
the planted router PR (2 bench files on both trees, then timed) took 62 seconds with both trees
already installed.

## The gate on ogygia

The measurement-source gate runs in ogygia's own CI, as the `unmeasured` job of its `abax.yml`, on
every non-draft PR. Locally: `pnpm build:lib`, then `pnpm bench:unmeasured`.

`internal/abax/src/unmeasured.ts`:

1. Counts every bench file (`abax run`): the functions a bench runs.
2. Lists every function of `packages/<pkg>/src` (`abax inventory`) and the ones no bench ran.
3. Runs each package's node tests with `ABAX_RECORD` set, so the recorder plugin in the test
   config records the inputs and outputs of those functions.
4. Replays what they recorded (`abax replay`): the output must come back the same.
5. Lists the base commit's functions from git and runs the gate (`abax unmeasured`) with the
   exemptions in `internal/abax/unmeasured.json`.

It writes `.abax/unmeasured/gate.md` (also the job summary) and `gate.json`, and exits 1 when the
PR adds a function with no measurement source. The numbers from PR #180 are in
[layers.md](layers.md#the-measurement-source-gate).
