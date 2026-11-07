# Training data: step changes and their measured time

Labeled pairs for the statistical models that turn exact counts into bets about time ("+4% steps,
80% chance it shows on the clock"). Each pair is one bench case on two sides of a change: what
the change did to the counts, and what it did to the time, beyond noise or not.

Two files per version, joined by `id`:

| File                       | What                                                    | Same on every run  |
| -------------------------- | ------------------------------------------------------- | ------------------ |
| `training-counts-<v>.json` | counts, engine health and input size of both sides      | yes, byte for byte |
| `training-times-<v>.json`  | every timing sample, the noise rule's verdict, the load | no                 |

## Where the pairs come from

- **planted**: slowdowns, speedups and harmless edits built from Heisenbench's answer keys
  (`test/time-key`, `test/answer-key`, `test/engine-key`, `test/growth-key`) and one helper per
  kind of work, each at two or three input sizes (`suites/ogygia/src/planted.ts`).
- **history**: ogygia's first-parent commits that touch a bench package's source, each against
  its parent, with one fixed set of bench files laid over both sides (as the real-world check in
  `suites/ogygia/src/correlate.ts` does). Only the cases of bench files whose import graph
  reaches a changed file.

Both sides are counted (`heisenbench run`), checked by engine health (`heisenbench health`) and
sized; then timed on the plain build, both sides in one process taking turns, fresh copies every
round, with confirming rounds for a case that looks changed (`heisenbench time`, the PR comment's
time layer). A group (a batch of planted pairs, or one commit) is one timing run.

## Version 1 (2026-11-07)

475 timed pairs: 211 planted, 264 from 17 ogygia commits (30 touched a bench package's source;
13 changed nothing a bench file reaches). Apple M4 Max, Node 26.4.0, 7 rounds of 150 ms a side.

| Pairs                | Count | Time beyond noise (slower / faster) |
| -------------------- | ----: | ----------------------------------: |
| planted slower       |   101 |                              55 / 0 |
| planted faster       |    56 |                              0 / 19 |
| planted same         |    54 |  2 / 0 (engine twins that add work) |
| history, steps moved |    21 |                               0 / 0 |
| history, steps same  |   243 |                               0 / 0 |

By the size of the step change, the share beyond noise: none of 293 pairs with no step change, 0
of 53 under 3%, 9 of 38 at 3 to 10%, 15 of 30 at 10 to 30%, 28 of 35 at 30 to 100%, 24 of 26 at
100% or more.

**The machine was busy.** Other jobs ran the whole time: the 1-minute load average was 7 to 20 on
16 cores while a group was timed (mean 12), and groups that went above 20 were timed again. The
labels are what the noise rule said under that load, not smoothed: it is cautious, so a busy
machine hides real changes rather than inventing them. Two ogygia changes plainly visible in the
samples were judged `same` (a 9.6% step cut timed 24% faster, and a 158% step rise timed 49%
slower, both with overlapping samples). Re-judge from the samples, or filter on `load`, as a
model needs. Version 2 is the quieter run.

## Version 2 (2026-11-07)

The same 475 pairs (the same planted pairs, the same 19 ogygia commits with the same bench
files), timed on a fresh GitHub-hosted runner where nothing else ran: the hand-run workflow
[`training-data.yml`](../../../../.github/workflows/training-data.yml) (`version 2`, the default
`from` and `to`, `--retime-above 3`), one job of 78 minutes, 42 of them timing. AMD EPYC (4
cores), Linux, Node 26.13.0, 7 rounds of 150 ms a side, Heisenbench at `30b05cf`. The two
`feel.json` and `ranges.json` models are trained on it.

**Load.** The 1-minute load average was 1.3 to 6.8 while a group was timed (mean 2.9 over the
28 groups; version 1: 7 to 20, mean 12.2). On 4 cores much of it is the timing's own work: a
group is counted and checked by `heisenbench health` just before it is timed, four child
processes at a time, and the 1-minute average carries that over. In 24 of the 28 groups the
highest load is the first sample, and it falls all through the timing (planted-02: 6.8 at the
start, 3.4 a minute in).

**No group was timed again.** `--retime-above` is read when `measure` finds a group already on
disk from an earlier run (`done_before` in `training.ts`): it is how a stopped or busy run is
redone. The workflow starts from an empty work directory and runs `measure` once, so every group
was timed once, though 23 of the 28 went above 3. Read the load as recorded; to re-time on a
runner, run `measure` a second time over the same `--work`.

| Pairs                | Count | v1: beyond noise (slower / faster) | v2: beyond noise (slower / faster) |
| -------------------- | ----: | ---------------------------------: | ---------------------------------: |
| planted slower       |   101 |                             55 / 0 |                             54 / 0 |
| planted faster       |    56 |                             0 / 19 |                             0 / 32 |
| planted same         |    54 |                              2 / 0 |                              3 / 0 |
| history, steps moved |    21 |                              0 / 0 |                              2 / 1 |
| history, steps same  |   243 |                              0 / 0 |                              0 / 0 |

The three "planted same" pairs that timed slower are engine twins that add work (`planted_for`
is `engine`): `engine-int-double-twin` at both sizes and `engine-shape-order-twin-n50`.

By the size of the step change, the share beyond noise:

| Step change   | v1: beyond noise | v2: beyond noise |
| ------------- | ---------------: | ---------------: |
| none          |         0 of 289 |         0 of 289 |
| under 3%      |          0 of 57 |          2 of 57 |
| 3 to 10%      |          9 of 38 |         23 of 36 |
| 10 to 30%     |         15 of 30 |         15 of 32 |
| 30 to 100%    |         28 of 35 |         26 of 35 |
| 100% or more  |         24 of 26 |         26 of 26 |
| history moved |          0 of 21 |          3 of 21 |

(The by-size counts of version 1 above, 293 and 53, sort a pair by its rounded `steps_pct`; this
table sorts by whether the steps moved at all, so a few pairs of tiny changes move from "none" to
"under 3%".)

The quiet machine shows most of its gain in small changes (3 to 10%: 9 to 23) and speedups (19
to 32 planted faster). The two ogygia changes version 1 judged `same` though the samples showed
them now are beyond noise: the `transformHost` step cut (server leg 19% faster) and the
`federation` wire rise (`absolutize` +155% steps, 58% slower; `lift_document` +107%, 47% slower).

**The counts changed too, though the code did not.** Version 1 was counted with prices v2,
version 2 with prices v3 (#33): `split` is priced by its parts, `replace`, `replaceAll` and
`match` by their matches and callbacks, `join` by the elements it turns into text, `Array.from`
by its `mapFn` calls, where prices v2 priced each by its input size alone. 171 of
the 475 pairs have other steps, all of it in those built-ins (`steps_by_kind` of the rest is the
same). Two rows:

- `markdown.bench.ts > frontmatter: a 120-page docs site`: 32,664,166 steps in v1, 3,277,869 in
  v2. Its `replace` calls went from 28,977,780 steps to 215,640: few matches on long strings,
  which v2 priced by the string's length.
- `compiler.bench.ts > transformHost ... client leg` at `01dc5b99c13c`: 29.2M to 26.4M steps
  (-9.6%) in v1, 22.0M to 19.2M (-12.7%) in v2. The cut itself is the same 2.8M steps, but the
  case around it is smaller (`split` 18.4M to 2.7M steps, `join` 144K to 20K, `replace` 1.3M up
  to 10.0M), so the pair moves from "3 to 10%" to "10 to 30%" (it and its server leg are the
  only pairs to change bucket).

Engine health is the runner's, not the laptop's, so it differs in 149 rows (another V8 and CPU
optimize at other moments), and allocations or calls in 27 (the runner's Node 26.13 against
26.4).

**Caveats.**

- **One machine type.** Every label is a 4-core cloud runner's verdict. A faster or slower core,
  another V8, another number of cores can see other changes.
- **Absolute times are the runner's.** The ns in `training-times-2.json` are not the laptop's:
  the same case can differ by a factor (the `weights.json` baseline, calibrated on the laptop, is
  off by 0.83 in log at the median here against 0.66 on version 1). A model of time trained on
  version 2 predicts a runner like this one, which is what most PR comments are made on.
- **A shared runner is not a quiet laptop.** Load near the core count is the bench's own
  processes, but a cloud core can still be shared with other tenants. The noise rule's verdicts
  are what it said there.
- The two versions' counts differ by the prices (above): do not join their rows on `id` for
  steps, only for labels.

## Regenerate

On a fresh runner, as version 2 was: run the `training-data` workflow by hand (Actions, "Run
workflow", with the version to write) and commit the two files of its `training-data-<version>`
artifact here. Then retrain both models on it (`docs/feel-odds.md`, "Retraining";
`docs/calibration.md`, "Ranges").

Or locally, from the repository root, on as quiet a machine as you have:

```bash
W=/tmp/hb-training   # clones, trees and the measured groups; a stopped run resumes
caffeinate -dims node suites/ogygia/src/training.ts measure --planted --history \
  --from 3bff2999bf36c9fb9ae1cf3b7a9c04613cf0bd78 --to 01dc5b99c13cba0e30a96b0ff765865096a76dca \
  --work $W
node suites/ogygia/src/training.ts assemble --work $W --version 1
```

`measure` takes `--repeats 7` and `--time-ms 150` (the timing), `--batch 24` (planted pairs per
group), `--max 40` (newest commits), `--bench <rev>` (whose bench files, default `--to`),
`--filter text` (planted ids), `--counts-only` (no health, no timing: the counts file alone) and
`--retime-above <load>` (measure again the groups whose load average went above it) and
`--max-load <load>` (before timing a group, wait up to `--max-wait-min 60` minutes for the load
average to drop to it).
`caffeinate` is macOS; leave it out elsewhere.

## Counts file

```text
schema    "heisenbench-training-counts/1"
prices    { version, hash } of the prices.json the steps are priced with
inputs    planted: { templates, pairs }; history: { repo, from, to, bench, commits }
rows      one per pair, sorted by id
```

A row:

| Field                         | Meaning                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `id`                          | `planted/<pair>`, or `history/<commit12>/<bench file> > <case>`                         |
| `source`                      | `planted` or `history`                                                                  |
| `file`, `name`                | the bench file and case                                                                 |
| `template`, `variant`         | planted: which template, which change (`x1.05`, `extra-loop`, `undo-delete`...)         |
| `planted`                     | planted: the change's direction by construction, `slower`, `faster` or `same`           |
| `planted_for`                 | what `planted` is about: `steps`, or `engine` (an engine twin may add steps)            |
| `size`                        | planted: the template's size knob (rows, loop length, items)                            |
| `commit`, `parent`, `subject` | history: the commit and its first parent                                                |
| `base`, `pr`                  | each side (below)                                                                       |
| `delta`                       | PR minus base: `steps`, `steps_pct`, `allocations`, `bytes`, `calls`, `steps_by_kind`   |
| `engine`                      | `base`, `pr` (below), and `worse` / `better`: engine findings by kind; null if none ran |

A side:

| Field           | Meaning                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `steps`         | the case's steps per call                                                                                                                                     |
| `allocations`   | allocation sites run; `bytes` their estimated bytes                                                                                                           |
| `calls`         | function calls                                                                                                                                                |
| `stable`        | both counted runs agreed (always true; false would be a counting bug)                                                                                         |
| `steps_by_kind` | steps per op kind (`call`), dynamic price (`dyn.string_char`) or built-in (`bi.JSON.parse`); sums to `steps`. An op kind's steps over its price are its units |
| `builtin_calls` | calls per built-in                                                                                                                                            |
| `input_size`    | the size of what setup returns (strings, elements, entries, keys; the growth layer's measure)                                                                 |

Engine health of a side, over the case's functions and inline-cache sites: `functions`; per tier
`interpreted`, `baseline`, `maglev`, `turbofan`; `inlined`; `deoptimized` (had optimized code and
lost it); `refused` (forced to optimize, V8 did not); `deopts` (events); `sites`, `polymorphic`,
`megamorphic`; `unstable` (functions and sites V8 did not repeat, left out of the rest).

## Times file

```text
schema         "heisenbench-training-times/1"
date           when the first group was timed
machine        cpu, cores, os, node, v8
heisenbench    the bench repo commit that measured
repeats        rounds per side before confirming; time_ms: the timed phase per sample
sample_fields  ["p50_ns", "mean_ns", "p99_ns", "cpu_ns", "samples"]: the order of a sample
groups         one per timing run: id, kind, started, seconds, load, series, error
rows           one per timed pair, sorted by id
```

`load` is the 1-minute load average (`os.loadavg()`) while the group was timed: `start`, `end`,
`min`, `max`, `mean`; `series` is `[seconds since start, load]` every 5 seconds. Filter on it.

A row: `id` (the counts row), `group`, `rounds` (per side, confirming rounds included),
`confirmed` (rounds run more because a metric looked changed), `order` (who went first each
round), `base` and `pr` (one sample per round), `verdicts` (per metric: `base` and `pr` medians,
`diff_pct`, `regressed`, `improved`), and the label: `label` is the p50 verdict of the
no-overlap noise rule, the one the PR comment shows (`slower`, `faster`, `same`), and
`beyond_noise` is `label !== "same"`.
