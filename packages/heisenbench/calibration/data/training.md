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

## Regenerate

From the repository root, on as quiet a machine as you have:

```bash
W=/tmp/hb-training   # clones, trees and the measured groups; a stopped run resumes
caffeinate -dims node suites/ogygia/src/training.ts measure --planted --history \
  --from 3bff2999bf36c9fb9ae1cf3b7a9c04613cf0bd78 --to 01dc5b99c13cba0e30a96b0ff765865096a76dca \
  --work $W
node suites/ogygia/src/training.ts assemble --work $W --version 1
```

`measure` takes `--repeats 7` and `--time-ms 150` (the timing), `--batch 24` (planted pairs per
group), `--max 40` (newest commits), `--bench <rev>` (whose bench files, default `--to`),
`--filter text` (planted ids) and `--counts-only` (no health, no timing: the counts file alone).
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
