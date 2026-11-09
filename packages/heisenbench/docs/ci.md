# Heisenbench in CI

Heisenbench runs on ogygia's source from this repository. The bench files live in the ogygia repository
next to the code they measure; this repository holds the engine and the job that runs it.

## Where things live

In [ogygiajs/ogygia](https://github.com/ogygiajs/ogygia):

| Path                                      | What                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/<pkg>/bench/*.bench.ts`         | The bench files. 11 files, 57 cases today.                                                                   |
| `internal/heisenbench/package.json`       | The Heisenbench commit ogygia is pinned to (`"heisenbench": { "repo", "ref" }`).                             |
| `internal/heisenbench/src/heisenbench.ts` | Links `node_modules/@bench/heisenbench` to `HEISENBENCH_DIR` when set, else to a clone of the pinned commit. |
| `internal/heisenbench/src/types.ts`       | `pnpm bench:types`: writes `packages/<pkg>/bench/__heisenbench.d.ts` (gitignored) with `heisenbench dts`.    |
| `internal/heisenbench/src/check.ts`       | `pnpm check:bench`: writes the types, then type-checks every bench directory.                                |
| `internal/heisenbench/src/preload.ts`     | Maps `virtual:ogygia/*` and `$app/*` to the unit-test stubs, so modules written for Vite load in Node.       |
| `internal/heisenbench/src/unmeasured.ts`  | `pnpm bench:unmeasured`: the measurement-source gate.                                                        |
| `internal/heisenbench/unmeasured.json`    | Exemptions for the gate.                                                                                     |
| `.github/workflows/heisenbench.yml`       | Asks this repository for a run on every PR, and runs the gate.                                               |

In this repository:

| Path                                | What                                                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `packages/heisenbench`              | The engine.                                                                                                                 |
| `packages/compare`                  | The no-overlap noise rule and the one PR comment with sections.                                                             |
| `suites/ogygia`                     | Checks out ogygia commits, picks bench files, runs Heisenbench, writes the section and JSON.                                |
| `.github/workflows/heisenbench.yml` | The job.                                                                                                                    |
| `.github/workflows/check.yml`       | Tests, lint, format, `heisenbench verify` and 60 fuzzed programs on fixed seeds, on every PR and push to main of this repo. |
| `.github/workflows/fuzz.yml`        | The fuzzer every night at 02:23 UTC on new seeds; repros kept as an artifact.                                               |

## A PR, step by step

1. **ogygia asks.** ogygia's `heisenbench.yml` runs on `opened`, `synchronize`, `reopened` and
   `ready_for_review`. Its `request` job sends a `repository_dispatch` of type `ogygia-heisenbench` here,
   with the PR number, the head commit and the base commit. Drafts, forks and the release PR are
   skipped. Without `BENCH_TOKEN` it skips with a notice; a refused request only warns. Heisenbench builds
   from source, so it does not wait for a published preview.
2. **The run plans.** This repository's `heisenbench.yml` checks the payload in a `plan` job, then the
   `measure` job installs Heisenbench and the suite (`pnpm install --filter '@bench/ogygia...'`) on
   Node 26. A newer push to the same PR cancels the older run. The measure job times out after
   45 minutes.
3. **Checkouts.** `suites/ogygia` clones ogygia once, then makes a tree per commit
   (`trees/<sha12>`): checked out, `pnpm install --frozen-lockfile`, and the bench types written by
   the tree's own `internal/heisenbench/src/types.ts`, with `HEISENBENCH_DIR` pointing at this checkout's
   `packages/heisenbench`. Both trees use the Heisenbench that measures, not the pinned one.
4. **The base.** The PR is measured against the merge base of its head and its base, not the tip
   of the base branch.
5. **Selection.** The changed files between the merge base and the head. For each bench file, its
   static import graph through Node's own resolver (`import.meta.resolve`, so package `exports`
   and workspace links resolve as they will at run time), into `.svelte` script blocks, stopping at
   `node_modules`. A bench file runs when its graph reaches a changed file. A manifest
   (`package.json`, `tsconfig*.json`) is in no graph but decides how the files under it resolve
   (an `exports` or `imports` map), so a changed one runs every bench file whose graph has a file
   under its directory. A change to the root `package.json`, a root `tsconfig*.json`, `.npmrc`,
   `pnpm-lock.yaml`, `pnpm-workspace.yaml` or anything under `internal/heisenbench/` runs them all.
6. **Counting.** Each selected bench file runs in its own processes, on the head tree and the base
   tree at once: `heisenbench run`, `heisenbench health`, and `heisenbench growth --scaled on`. The bench files of a
   tree run side by side, each tree on half the cores. Counts, engine health and growth come out
   the same under any load, so nothing waits for a quiet machine here. Engine health runs each
   case twice on every run, PRs included: only that check can mark a function or inline cache V8
   did not repeat, and a marked one never becomes a finding. One bad file costs only its own
   cases. Each command has a time limit: 15 minutes for `run` and `health`, 5 for `growth`. Each
   runs in a process group of its own, so the limit kills the children Heisenbench starts too (health
   and measure children), and none outlives its command. An exit other than 0 (clean) or 1 (a case
   failed), a signal or the limit is listed as an error for that file, even when the report has
   its part. The per-file reports merge into one report per tree. Before the files ran side by
   side, on a 4-core runner a PR with 11 bench files spent per tree about 2 minutes on engine
   health, 2.4 on growth and 25 seconds on counting, then 5.4 minutes on timing.

   Counting and growth are incremental ([below](#incremental-counting)): a case whose code and
   inputs are the same as in a run the cache holds is reused, not counted, on either tree.

   Counting, growth and the worst-case search count every dependency, Heisenbench's default, and
   blame each under its name and version (`acorn@8.18.0/dist/acorn.mjs > Parser`). Until
   `COUNTED_DEPS` was dropped, only devalue, Svelte and magic-string were counted, and Svelte's
   template parser handed its work to acorn uncounted: it calls `acorn.parseExpressionAt` once per
   expression with the whole file, and acorn's `Parser` constructor splits the file up to that
   point into lines. A compiler fix read 33 times less work while its wall time fell 1.9 times.
   On ogygia `57882cc`, counting every dependency changes 8 of the 57 cases, all compiler and
   markup cases: `transformHost: a route page with twenty islands` goes from 7.9 to 29.2 million
   steps (66% acorn), `de-barrel` from 59 thousand to 3 million (98% rolldown's JavaScript side).
   The growth case `transformHost: a route page as its island count grows` is quadratic with
   acorn's `Parser` the function with the most steps.

   It costs little: on an M4 Max, the 11 files one after another took 10.9 s to count (9.1 s with
   the three packages, 8.3 s with none), and 74.8 s to grow (72.4 s with none). Two checkouts at
   different depths give the same 1,709 functions (1,407 of them in dependencies) and steps for
   the compiler file. Engine health stays on ogygia's own functions (`heisenbench health` leaves
   dependencies out unless `--deps` names them): what V8 does with Svelte's compiler is not
   ogygia's to fix.

7. **The diff.** `diffReports` and `diffSections` with `git diff -M --unified=0` between the merge
   base and the head.
8. **Time.** `heisenbench time` loads both trees in one process and times the selected bench files in
   turns, 5 each, on fresh copies of both trees each turn; a case that looks changed gets 5 more
   (20-minute limit). This is the one step that needs the machine to itself, so it runs alone.
9. **Real-app weight.** The job reads `heisenbench/main/app-weights.json` from the `results` branch (the
   newest main run's, see [Full runs](#full-runs)) and ranks the changed functions by it: the
   change per call times the calls per unit of real work (`rank_changes`). Weights counted on
   another Node, V8, platform or steps-to-ns weights (`envMismatch`) are not used, and neither are
   missing ones: the section says which, in one line. When `heisenbench/main/real-weights.json`
   is there too ([Real traffic](#real-traffic)), the section ranks by real cost instead: every
   changed function and growth finding priced in CPU time per day on that traffic, with its range
   and how much of the profiles mapped. Without the file nothing changes, and a file that does not
   read is set aside.
10. **Worst-case search.** `heisenbench search` on the cases with a changed function that declare an
    input (a static `setup` in the bench file), biggest change first, at most 8, on the PR tree and
    then the base. The whole layer has 4 minutes; each search gets an even share of what is left,
    at most 30 seconds, and the cases the budget does not reach are counted as skipped. A case is
    flagged by Heisenbench's own rule: its worst input costs at least 4 times its typical one, and at
    least twice the base's ratio; or it never finishes and the base does; or its shrunk input grows
    superlinearly and the base's does not ([layers.md](layers.md#worst-case-search)).
11. **Growth from recorded calls** (`suites/ogygia/src/recorded.ts`), for the source files the PR
    changed: the packages are built (`pnpm build:lib`; the node tests import `dist/`), the
    functions of the changed files are the recorder's targets, together with their `dist/` twins
    (the unbundled build keeps each file's functions and names, so a call through `dist/` is
    recorded as its source's), every package's node tests run with `HEISENBENCH_RECORD`, every
    bench case runs once with the recorder on (`heisenbench record`), and `heisenbench growth
    --recorded --modules <changed files>` grows what they recorded. Only findings reach the
    comment, and a PR whose changed files have none says nothing. On an M4 Max, for the one file
    ogygia #186 changed (`packages/core/src/compiler/region/transform.ts`): 8 s to build (Turbo's
    cache warm), 34 s to record (every package's node tests, then the bench cases) and 3 s to
    grow its 25 recorded functions. Recording costs what the tests cost (5.7 s for core's node
    tests with every function recorded, 4.5 s without), so a PR pays about a minute here, a few
    on a CI runner: cheap enough to run on every PR, and only the changed files' functions are
    grown, so the grow step stays seconds. `--recorded off` turns it off, `all` grows everything.
12. **Blame.** For the cases whose steps grew by at least 1% and 1,000 steps, `blameRegressions`
    finds the hunks of the PR that carry the extra steps: it undoes sets of them on scratch copies
    of the PR tree and recounts only those cases, one child per tree, up to 4 side by side (see
    [Blame](layers.md#blame)). The hunks searched are those of the changed files the regressed
    cases' bench files reach (all changed files when the selection ran everything). It runs after
    the time layer, which needs the cores, within 60 recounts and 5 minutes (`--blame-budget`,
    `0` turns it off); past the budget the comment says "narrowed to these hunks". A recount costs
    one `heisenbench run` of the regressed cases (2.1 s for the compiler's transformHost cases on an
    M4 Max), so a regression in one hunk of ten takes about 10 to 30 recounts: well under a minute
    on 4 cores. A PR with no case over the threshold costs nothing here. With the weights step 9
    ranks by, the blamed change gets the same real cost as the ranked findings: CPU time per day on
    the imported traffic, with its range, for the change and per hunk.
13. **Dependency upgrades** (`suites/ogygia/src/upgrade.ts`). When the base and the head count a
    package at different versions (the PR changed the lockfile or a `package.json`, so every bench
    file ran), `upgradeDiff` counts the head's code again with each tree's install, on two
    scratch copies of the head tree, and puts the step change of the cases that count the package
    on the package's own lines ([layers.md](layers.md#dependency-upgrades)). Both trees are
    installed already, so it costs two recounts of the bench files that reach the package, side by
    side: 9 s for the compiler bench file on an M4 Max. `--upgrade off` turns it off. The draft of
    an upstream report (`heisenbench upstream draft`) is not run here: it runs the package's code
    on its own and times it, on demand.
14. **Complexity contracts** (`suites/ogygia/src/contracts.ts`). The source files of each tree that
    hold an `@heisenbench` tag go to `heisenbench contracts`, with what that tree measured: the head
    against its growth cases and its growth from recorded calls, the base against its growth cases
    ([layers.md](layers.md#complexity-contracts)). The comment shows the contracts the PR adds,
    changes or removes, and every one that does not hold on the head; a PR that changes none and
    breaks none gets no part. A PR that ran no bench file has no base tree (it is not installed for
    this alone), so its comment shows only the head's contracts that do not hold. The check reads
    only the tagged files and the growth already counted: about a second.
15. **Store and post.** The measure job uploads `suites/ogygia/out` as an artifact. The `publish`
    job checks it (below), then `result.json` goes to the `results` branch and `section.md`
    becomes the `heisenbench` section of the PR's comment.

### Who can write

Steps 3 to 14 run ogygia's code: its install scripts, Vite, the bench files. So they run in a job
that can write nothing: `contents: read`, no secrets, and `persist-credentials: false`, so no
token is left in `.git/config` for that code to find. The one thing it saves besides the artifact
is the count cache, and only on a main or nightly run, which runs main's code
([Incremental counting](#incremental-counting)).

The `publish` job holds the write token and `BENCH_TOKEN`. It checks out only this repository's
`packages/compare` (no install) and runs nothing from the measure job or from ogygia. It reads the
artifact as data with `packages/compare/src/validate-artifact.ts`: only `result.json` (a
manifest, see [the results branch](#the-results-branch)), the shards it lists and `section.md`,
each a regular file under its size limit, the JSON parsed, its kind, commit, base and PR equal to
what the `plan` job decided, and no section markers in the markdown. A shard is read only by the
name the manifest gives it, which is its sha256 (no paths), at most at the size the manifest
gives it, and must hash to its name; `shards/` may hold nothing the manifest does not list; a
manifest lists at most 1,024 shards, each at most 40 MiB, adding up to at most 200 MiB. Paths
come from the plan, never from the artifact. When the measure job failed, or the artifact does not
pass, the publish job still rewrites the PR's section with a line saying so.

The app benchmark's `bench.yml` has the same three jobs.

### Incremental counting

`heisenbench run` and `heisenbench growth` run with `--cache "$RUNNER_TEMP/heisenbench-cache"`
([how it works](how-counting-works.md#counting-only-what-changed)). A case is counted only when
something its counts are a function of changed: a function it runs, a file it reads, the prices,
Heisenbench, Node. The rest come from the cache, marked reused.

- **Where the cache lives.** An Actions cache, restored at the start of the measure job from the
  newest `heisenbench-counts-main-*` and, on a main or nightly run, saved after it under
  `heisenbench-counts-main-<run id>`. The directory is content-addressed, so what a run counts is
  added to what it restored; the suite drops entries no run used for 14 days (`CACHE_DAYS`).
- **Who writes it.** Only main and nightly runs save, and they run main's own code. A PR run
  restores and adds to its copy, but never saves: nothing a PR's code wrote is read by another run.
  A PR still reuses main's counts of its merge base (its base tree) and of every head case whose
  code the PR did not touch.
- **The check.** On each tree, one bench file picked at random (`--cache-verify`, `CACHE_VERIFY`)
  counts one reused case again, and grows one again: two of each a PR run. A difference fails
  that case with "a cache bug" and the first difference, in the comment like any failed case.
- **The comment** says per side how many cases were reused and counted, and, collapsed, why each
  of the PR's counted cases was not reused (`packages/router/src/match.ts changed`).
- **When everything is counted again.** The key holds Heisenbench's own source, so a push to this
  repository that changes `packages/heisenbench/src` makes the next run count every case once.
  So does a new Node on the runner, a new price file, or a change to ogygia's preload.
- **What stays as it was.** Engine health and the time layer are measurements of V8 and of the
  clock, not counts: they run on every selected bench file, as before. On a full run, so do real
  bytes, leaks and the price audit's timing.

A case that only the PR has is listed under "New cases", one only the base has under "Removed
cases". A bench file that does not load on one side is listed under "Did not run" with the error.

## Full runs

- **A push to ogygia's main.** After ogygia publishes the commit, its `pkg-pr-new.yml` sends
  `ogygia-main`. That runs the app benchmark and Heisenbench.
- **Nightly**, at 03:41 UTC, on ogygia's main head.
- **By hand.** `workflow_dispatch` with `sha`, and optionally `base_sha` for a PR-style run and
  `pr` plus `comment_repo` to post the section to a PR. A manual run is kept as an artifact only.

A full run takes every bench file of one commit through `run`, `health`, `growth` and `audit`,
with every plain-build layer on `run` (`--measure all`: time, real bytes, leaks), and writes one
summary table: steps, allocations, estimated and real bytes, p50 and leaks per case. It has 120
minutes. `audit` reuses the steps `growth` counted at every size (the same `--out`), times the
cases that declare `scale` at those sizes, and the suite judges every file's cases together
(`mergeAudits`). The summary gets a "Prices" part only when a price is suspect
([layers.md](layers.md#price-audit)).

PRs do not run the audit. An ogygia PR cannot change a price (prices live in this repository), and
the audit took 480 to 504 s for ogygia's 11 bench files on an M4 Max (5 rounds at 1x, 10x and
100x, with its own growth count), half of what a whole PR run takes on a 4-core runner (15 min),
and a CI runner is slower. A price that new ogygia code exposes is found on the next main push.

A full run then grows every function of every source file from recorded calls (step 11 above,
with every source file a target), and the summary lists what grows quadratically or worse. On ogygia main
`01dc5b9` (M4 Max): 4,868 functions recorded, 1,299 grown (the rest had fewer than two samples,
are closures or class methods, or their module does not load outside Vite), 1,116 of them decided,
in 60 s of recording and 152 s of growing (6.2×10⁹ counted steps). Two recordings gave the same
findings, and growing the same records twice the same report. Then every complexity contract is
checked against the growth cases and those recorded calls, and the summary lists them all.

The nightly run also searches every case that declares an input for its worst input
(`--search all`, [layers.md](layers.md#worst-case-search)): one `heisenbench search` process per
bench file on the head, within 30 minutes in all (`--search-budget`), and the summary lists only
the findings. A main push does not. On ogygia main `01dc5b9` the 57 cases of its 11 bench files
took 698 s on an M4 Max (729 s on a second run, with the same findings), more than half of it in
`compiler.bench.ts` (381 s). That is more than the whole audit (480 to 504 s) and too much for every push; once
a night it fits in the 30 minutes on a runner up to 2.5 times slower, and the measure job's limit
is 150 minutes for the nightly run instead of 120. A file the budget does not reach is counted in
the summary line.

### The mutation score

The nightly run then tests the benchmarks themselves (`--mutate all`,
[layers.md](layers.md#mutation-score)): every function of `packages/<pkg>/src` gets injected
slowdowns, and each one a case runs is recounted with them on scratch copies of the tree, with the
recorded calls of step 11 (a quadratic mutant that growth from recorded calls flags is caught) and
main's app weights (the missed functions are ranked by them). The summary gets the score per
package and operator and the top missed functions, each with a case that would catch it; the
artifact has `mutation/mutation.json` with every function. It has its own budget of 75 minutes
(`--mutate-budget`, seconds), so the nightly measure job's limit is 240 minutes.

On ogygia main `b46798f` it mutated all 631 functions a case runs in 20 minutes on an M4 Max
(2,428 recounts, 105 CPU-minutes; [layers.md](layers.md#mutation-score) has the scores). The suite
gives it every core (it is the run's last layer), so on a 4-core runner, about 2.5 times slower
per core, that is about 65 minutes, close to its budget. A run whose budget ends first reports the
functions it did not reach as skipped, and says so (a wall-time budget, so which ones depends on
the runner's speed; the next night reuses nothing, since each run has fresh scratch copies).

It does not run on PRs or main pushes. The score is about the benchmarks, not about a change: a
PR's changed function is caught or missed whatever the PR did, and a new function no case runs is
already the gate's job ([The gate on ogygia](#the-gate-on-ogygia)). `heisenbench mutate --modules`
can score only some modules, if a PR ever wants it.

A main or nightly run also counts the real apps, in an `app-weights` job beside the full run
(read-only like it, 60 minutes): it waits for the commit's pkg.pr.new build, builds the ogygia app
of the blog and of every scenario (`build-all.ts --only ogygia`) on Node 22, as the app benchmark
does, counts every scenario with `suites/apps/heisenbench/run.ts` on Node 26, the Node PR counts are
taken on, and turns the app report into weights with `suites/ogygia/src/app-weights.ts`: the same
file `heisenbench weights` writes, labelled with the commit and stamped with the Node and V8 that counted
it. A `publish-weights` job checks the artifact (schema, the commit) and stores it on the
`results` branch. A manual run with `app_weights` counts them too and keeps them as an artifact
only.

### Slow creep across main

A PR that adds 1% is easy to wave through; five of them are 5%. So a main or nightly run also
reads main's earlier full runs from the `results` branch (`heisenbench/main/<sha>.json`, a
blobless clone, so only the runs it reads are fetched), puts them in ogygia's first-parent order
with this run as the newest, at most 60 runs, and runs each case's steps through Heisenbench's
change-point model (`@bench/heisenbench/trend`). The summary gets one line per creeping case:

```
- ⚠️ steps of `<case>` started rising at `<sha>` (+5.1% over 9 commits, in 5 rises; still rising)
```

and one line naming the commits where cases took a step instead (2% or more in one commit, which
that PR's own comment and blame already showed). It is report-only: no count, verdict or gate
changes.

The model. Steps are exact, so a series moves only when a commit changes the code a case runs:
what looks like noise is real code churn. The series is the log of the steps (a rise is a ratio)
cut into flat and sloped pieces by exact penalized least squares, the objective PELT solves,
computed by optimal partitioning since a series is a few hundred points at most. A cut costs
β = 2·ln n and a slope γ = ln n (the Bayesian information criterion: each number the fit uses
must buy back ln n of fit), with misfit in units of σ = 0.5%. One commit that moves the steps by
2% or more is a step, never part of a creep. Inside each run of rising pieces the creep is the
span, from a small rise to a small rise, whose sum beats churn the most; it is reported when that
sum is 2% or more, comes from 3 commits or more, and is at least 4.5 churn deviations
(sum / (churn · √moves), where churn is the root mean square of the case's small moves outside
every rising stretch, never below 0.1%). The span is the best of about n²/2, so the bar sits well
above the usual 2 or 3. Every number is an option of `detect_trend`.

On simulated series (`packages/heisenbench/test/trend.test.ts`, 40 commits each): churn alone
(0.2%, 0.5% or 1% on every commit, or 0.6% on one commit in five) shows a creep in 2 of 800
series; eight 1% rises on 0.3% churn are found at their first commit for 173 of 200 seeds and
within one commit for 194. The model takes 118 ms for 57 cases of 300 commits each. `heisenbench verify --layers trend` checks the
planted series: a flat series and a single step say no creep, five 1% PRs among flat commits are
found at the first of them, and a creep then a revert, a creep on churn and two separate creeps
come out as planted.

A change of the counter (a newer Heisenbench, or another Node) can move steps too. The model does
not guess which moves were the counter's; each step and creep says when the counter changed with
it. A run that was not given a history (`--history`) says nothing; a history that is not there,
or a single run so far, is one line.

### History blame

Creep says when a case's total moved; `heisenbench history` says which line and which commit
([layers.md](layers.md#history-blame)). It reads the same full runs of main from the `results`
branch (`--reports <results checkout>/heisenbench`). Those were counted by whichever Heisenbench
was pinned then, with each commit's own bench files, so most of their changes come out marked
"counter changed", and a case a later PR added has no history before it. The commits they lack,
or all of them counted again with one Heisenbench and one set of bench files, come from
`suites/ogygia/src/history.ts`:

```bash
node suites/ogygia/src/history.ts --repo <ogygia clone> [--to main] [--max 20] [--bench <rev>] \
  --cache <dir> --out <runs> [--history <results branch>] [--work dir]
```

It counts the newest `--max` first-parent commits up to `--to` with the bench files of `--bench`
(default `--to`) laid over each tree, `heisenbench run` only, with `--cache`: a commit that changed
nothing a case runs reuses every case. Each commit writes `<runs>/<sha>.json` in the results
branch's shape (`meta`, `head`); one counted by the same Heisenbench with the same bench files is
not counted again, nor one the results branch holds from the same Heisenbench. On an M4 Max, 20
commits of ogygia took 179 s, 887 of 1,083 cases reused. Then:

```bash
heisenbench history packages/core/src/compiler/flags.ts:line_at --reports <runs> --repo <ogygia clone>
```

Every main push has its own concurrency group, and the nightly run has another, so no full run
cancels or replaces another (GitHub keeps only one waiting run per group, so a shared group would
drop pushes). Full runs can overlap; `heisenbench/main/latest.json` and `heisenbench/main/app-weights.json` move
only to a commit that is not behind the one they hold.

## The comment

Each ogygia PR has one benchmark comment, found by the marker on its first line:

```md
<!-- ogygia-benchmarks -->
### ogygia benchmarks

<!-- section:heisenbench -->
...
<!-- /section:heisenbench -->

<!-- section:apps -->
...
<!-- /section:apps -->
```

`node packages/compare/src/upsert-comment.ts --repo <owner/name> --pr <n> --section heisenbench --file section.md`
finds the comment (or creates it), replaces only the named section, and keeps the others. It
only takes a comment written by the token's own login: the login `GET /user` returns, or
`github-actions[bot]` for a token that endpoint refuses. A GitHub App token comments as
`<app>[bot]`, so pass `--bot-login` (or set the `BENCH_BOT_LOGIN` repository variable). A marker
pasted into anyone else's comment is ignored. A body longer than GitHub's 65,536 characters is cut
before it is sent: each section gets a fair share of the room, and a cut section ends with a note
that links the run. `heisenbench` comes before `apps`. A comment from before sections reads as one `apps`
section and is migrated on the first upsert. If the Heisenbench run fails, the publish job still rewrites
its section with a line saying the run failed and a link, so a PR never shows counts for an older
commit as if they were current.

The `heisenbench` section, in order:

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
4. **Where.** Collapsed: the case and the lines the change sits on, with Δ steps, allocations and
   bytes, and "new code" for lines inside a changed hunk. A line that changed the same way in
   several cases is one row. Under it, for the changed cases that count a dependency, self steps
   by package: which package's steps changed, and its share of the case (`acorn@8.18.0`, 66%).
   Then **Which change made it slower**, when a case regressed: per cause, the cases, their growth
   and the hunks it comes from (`+10.5% in transformHost: … comes from these 3 changes:
   packages/core/src/compiler/region/transform.ts L1035–1049, L1058–1073 and L2143–2153`), whether
   the hunks interact, and collapsed, each hunk's diff with 3 lines around it and the functions and
   lines its steps are in.
5. **Leaks, elided allocations, time-led cases**, when there are any.
6. **Engine.** New deopts, lost optimizations, inline caches that got worse, per case and line.
   Cases where V8 did not do the same thing twice are listed as unstable.
7. **Growth.** Cases whose curve class changed, and a collapsed list of the ones that kept it.
8. **Worst-case search.** One line: how many cases were searched in how much of the budget, and
   one more line for each flagged case, with its worst input.
9. **Time.** The time table for every case of the selected files. When no case got slower or
   faster beyond noise, one line says so and the table is collapsed under it.
10. **Complexity contracts**, after growth from recorded calls: the contracts the PR adds, changes
    or removes, and each one that does not hold, with the class measured, the sizes and the lines.

Every list is capped (20 bench files, 10 files that did not run, 15 engine and growth findings)
with a count of the rest, which are in `result.json`. Names and errors are escaped for markdown
tables.

[sample-comment.md](sample-comment.md) is a complete one, from a real run.

## The results branch

Every run is kept on the orphan `results` branch of this repository, next to the app benchmark's
files, under `heisenbench/`:

| Path                                                  | What                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| `heisenbench/pr/<number>.json`                        | The newest run of that PR.                                 |
| `heisenbench/commit/<sha>.json`                       | The newest run of that ogygia commit, PR or main.          |
| `heisenbench/main/<sha>.json`                         | A full run of a main commit.                               |
| `heisenbench/main/latest.json`                        | The newest full run.                                       |
| `heisenbench/shards/<sha256>.json`                    | The shards every run file above lists, shared by them all. |
| `heisenbench/main/app-weights.json`                   | Real-app weights of the newest main run: what PRs rank by. |
| `heisenbench/main/app-weights/<sha>.json`             | Real-app weights of that main commit.                      |
| `heisenbench/main/real-weights.json`                  | Weights of real traffic, uploaded by the owner (optional). |
| `heisenbench/registry/receipts/<name>/<version>.json` | A release's receipt ([receipts.md](receipts.md)).          |
| `heisenbench/registry/index.html`                     | The registry page, made from those receipts.               |

Each run file is a `result.json` (`schema: "ogygia-heisenbench/1"`): `meta` (kind, PR, commits, the Heisenbench
commit that counted, the Node version, the run URL, the layers measured), `selection`, the `head`
and `base` reports, the `diff`, load errors, the time comparison and, for a PR, the weight ranking
and the search. The two reports leave out each function's blocks and the engine sites that are
monomorphic and stable (`detail` says so; `suites/ogygia/src/stored.ts`): together they are more
than half a report and nothing that reads a run file back uses them. The run's artifact keeps the
whole reports (`head/`, `base/`).

A run file is written in shards (`packages/compare/src/shards.ts`). The file itself is a small
manifest: `format: "heisenbench-shards/1"`, copies of `schema` and `meta`, and the list of shards,
each with its `name` (`<sha256>.json`), `sha256`, `bytes`, what it holds (`of`) and its bench
file (`group`) and `part`. The first shard is the body: the result with the reports' `cases` and
`engine.cases` empty. The others hold those cases, one bench file's run of them each, in order
(`head.cases`, `head.engine`, `base.cases`, `base.engine`); a bench file over 40 MiB is cut into
parts. A shard is named by its content, so a bench file whose counts did not change is the same
shard on both sides of a PR and from one run to the next, and every run file shares
`heisenbench/shards/`: an unchanged shard is stored once. Every reader goes through `load_result`
of the same file: the publish check, the trend over main (`trend.ts`), the history backfill and
`heisenbench history --reports` (which skips `shards/` and reads each manifest with its shards).
A run file without `format` is one from before shards and reads as it always did.

A weights file is `heisenbench-app-weights/1` plus `node` and `env`. The publish job only adds files
under `heisenbench/`, and retries its push with a rebase when another run pushed first.

## Real traffic

No job makes the real-traffic weights: they come from the production servers, which this
repository cannot see. The owner makes them and puts them on the results branch:

1. Record profiles of production servers: `.cpuprofile` files (`node --cpu-prof`, or the inspector
   over a window of traffic), or ogygia profiler reports (`/__profiler`, "Record the live server",
   saved as `.json` or `.ogp`). Note how many requests each `.cpuprofile` covered; ogygia's reports
   say it themselves.
2. In a checkout of the build that served them (same commit, built the same way, with server
   source maps), import them. Nothing about a request is kept, only function ids and numbers
   ([layers.md](layers.md#real-traffic)):

   ```bash
   heisenbench weights import profiles/* --requests <n> --root . --path-map /srv/app=. --out real-weights.json
   ```

3. Check the coverage line it prints (the share of sampled time that mapped to counted functions),
   then commit the file to the `results` branch as `heisenbench/main/real-weights.json`:

   ```bash
   git clone --branch results --single-branch --depth 1 https://github.com/ogygiajs/bench.git results
   cp real-weights.json results/heisenbench/main/real-weights.json
   git -C results add heisenbench/main/real-weights.json
   git -C results commit -m "heisenbench: real traffic weights" && git -C results push
   ```

Every PR run after that reads it (`--real-weights`). Replace it when the traffic changes; delete
it to go back to ranking by app weight. A run never fails on it: without the file the section is
as before, and an unreadable one is set aside with a note.

## Running it locally

```bash
# a PR-style run: head against base (a clone of ogygia, or a local checkout's path as --repo)
node suites/ogygia/src/cli.ts --sha <head> --base <base> --out suites/ogygia/out

# a full run of one commit, every layer
node suites/ogygia/src/cli.ts --sha <commit> --out suites/ogygia/out

cat suites/ogygia/out/section.md
```

Options: `--repo` (default the ogygia repository on GitHub), `--work` (clones and trees, default
`.work`, reused across runs), `--cache <dir>` (incremental counting; `--cache-verify <n>` bench
files per tree count one reused case again, default 1), `--measure time,bytes,leaks|all|none`, `--time off`,
`--weights app-weights.json` (rank a PR by those weights), `--real-weights real-weights.json` (and by
real cost on that traffic), `--requests-per-day <n>`, `--search changed|all|off` (default
`changed` for a PR, `off` for a full run; the nightly run passes `all`), `--search-budget
<seconds>` (default 240 for a PR, 1800 for a full run, `0` turns the search off), `--history <dir>`
(a full run: the `results` branch, a checkout or a blobless clone, for the trend over main),
`--mutate all|<n>|off` (a full run: the mutation score of every function a case runs, or of a
sample of n; default off, the nightly run passes `all`), `--mutate-budget <seconds>` (default
4500). The trend alone, on the runs the history already holds:
`node suites/ogygia/src/trend-cli.ts --repo <ogygia clone> --history <dir>`. On an M4 Max,
the planted router PR (2 bench files on both trees, then timed) took 62 seconds with both trees
already installed.

## The gate on ogygia

The measurement-source gate runs in ogygia's own CI, as the `unmeasured` job of its `heisenbench.yml`, on
every non-draft PR. Locally: `pnpm build:lib`, then `pnpm bench:unmeasured`.

`internal/heisenbench/src/unmeasured.ts`:

1. Counts every bench file (`heisenbench run`): the functions a bench runs.
2. Lists every function of `packages/<pkg>/src` (`heisenbench inventory`) and the ones no bench ran.
3. Runs each package's node tests with `HEISENBENCH_RECORD` set, so the recorder plugin in the test
   config records the inputs and outputs of those functions.
4. Replays what they recorded (`heisenbench replay`): the output must come back the same.
5. Lists the base commit's functions from git and runs the gate (`heisenbench unmeasured`) with the
   exemptions in `internal/heisenbench/unmeasured.json`.

It writes `.heisenbench/unmeasured/gate.md` (also the job summary) and `gate.json`, and exits 1 when the
PR adds a function with no measurement source, or when any function with a complexity contract
has none (the inventory lists the contracts; no change to ogygia's script needed). The numbers
from PR #180 are in [layers.md](layers.md#the-measurement-source-gate).

The contracts themselves are checked in this repository's run (step 14) and shown in the comment.
To make a broken contract a failing check in ogygia's own CI too, a job would run
`heisenbench growth <bench files> --scaled on --out r.json` and then
`heisenbench contracts --list <tagged files> --reports r.json`, which exits 1 when one does not
hold; this PR does not change ogygia's workflows.
