# Calibration

Two files turn counts into numbers that track time: `prices.json` (what each operation and each
built-in costs, in steps) and `weights.json` (what each kind of step costs, in ns). Both were
calibrated on one machine on 2026-11-06 and both are versioned. The measurements, the checks and
the decisions are in [calibration/results.md](../calibration/results.md); this page explains the
method.

## What a step is

Operation prices are not calibrated. They stay the seed prices: a step is one simple operation (a
property read, a comparison, an assignment), a call is 4, `new` is 6, and so on
([how-counting-works.md](how-counting-works.md#prices)). Keeping them fixed keeps a step easy to
reason about.

The time one step takes on the calibration machine is the median ns per step of the corpus cases
that call no built-in: **0.0997 ns** on the M4 Max, Node 26.4.0. That number turns built-in
timings into steps.

## Built-in prices

`heisenbench calibrate prices` times each priced built-in on the plain build with tinybench, at sizes 16,
64, 256, 1,024 and 4,096. Each tinybench iteration makes 64 calls, and the cost of the harness
itself (an empty function through the same loop) is taken off. Timing one call per iteration
mostly timed the two timer reads around it: `Map.prototype.get` came out at 249 steps that way,
and is 24.5 now.

Each built-in's times are fitted as `ns = base + k × f(n)` for `f` in const, n, n log n and n²,
with `base, k ≥ 0`, by relative least squares so small sizes count as much as large ones. The
simplest model within 0.02 R² of the best wins. Then ns become steps through the step time.

A built-in with size terms ([how-counting-works.md](how-counting-works.md#built-ins)) is timed
at several shapes per size: `split` on the same characters with a separator every 2, 8, 32 and
256 of them, and with a line break regex every 8 and 64; `replace` with a few matches or many,
replaced by a string and by a callback; `join` on numbers and on strings of 8 and 64 characters.
Each size term the shapes vary is one more column, `ns = base + k × f(n) + Σ kₜ × t`, fitted the
same way; a term the fit puts at 0 stays out of the price. R² is taken on the log scale, as the
fit is relative: on the raw scale the largest calls are all of R², and a `join` priced by its
numbers alone, 30x too low on a join of long strings, scored 0.998.

| Built-in                 | Seed (v1)      | Calibrated (v2) |
| ------------------------ | -------------- | --------------- |
| `Map.prototype.get`      | 6              | 24.5            |
| `Array.prototype.sort`   | 20 + 4 n log n | 66 n log n      |
| `Array.prototype.map`    | 10 + 2 n       | 150 + 53 n      |
| `String.prototype.slice` | 6 + 0.25 n     | 17.75           |
| `JSON.parse`             | 20 + 0.75 n    | 400 + 11 n      |

`String.prototype.slice` is constant because V8 makes a slice without copying.

Prices are stored as binary fractions: whole numbers from 64 up, quarters from 8, 1/64 below, and
n log n is rounded to 1/64. Sums of binary fractions are exact in a `Float64Array`, so a recount
from units gives the same number as the runtime's own count, to the bit. That is why counts can
end in `.13` and still compare exactly.

A built-in can be held to the curves its work has (`models` in `calibrate/inputs.ts`).
`Object.keys`, `values`, `entries` and `assign` do one pass over the keys, but over 16 to 4,096
keys they fit n² best: V8 keeps an object of a few dozen keys as a dictionary, about ten times
slower per key, and that step reads as a curve. They are held to const and n, with the keys past
the first 32 as a size term of their own (`wide_keys`), so a wide object costs a linear price
with the dictionary's slope (prices v4).

### Why calibrated prices replaced the seed prices

Across ogygia's 57 bench cases, do steps rank the cases the way their measured time does?
Spearman's rank correlation of steps against p50, on two measurement sets:

| Prices          | Set 4 | Set 5 |
| --------------- | ----: | ----: |
| seed (v1)       | 0.816 | 0.817 |
| calibrated (v2) | 0.843 | 0.842 |

The gain comes from the built-ins' prices relative to each other, not their level: scaling every
calibrated price by 0.5, 0.33 or 0.2 gives 0.847, 0.845 and 0.841. With v2, built-ins are 83% of
an ogygia case's steps at the median, against 35% with v1.

## Weights: steps to ns

`weights.json` gives the ns per unit of each operation kind, plus one weight for built-in steps,
one for dynamic costs, and one per call of the case itself. They come from a corpus: the small
functions in `calibration/corpus.ts`, each leaning on a few operation kinds, plus ogygia's own 57
cases. Each case is counted once and timed on the plain build; its operation counts are the
features and its mean ns per call is the target. The fit is non-negative least squares (no
operation may take negative time), with rows scaled by 1/ns so a 50 ns case weighs as much as a
50 µs one.

The current fit: 250 points, **R² 0.91** on the log scale.

Read the weights as a whole. Kinds that always move together in the corpus can trade cost between
them, and several end at 0 (`prop_read` and `arith`, for two) while their cost sits in other
weights. Two fits that agree in what they predict can disagree in single weights, which is why
`agree` compares predictions, not weights.

The fit is also checked per family: corpus cases named `<family> @<size>` are one family measured
at several sizes. A family whose R² is below 0.9 is **time-led**: steps do not predict its time
well, and the comment says to trust the time layer for it. Eight corpus families are time-led
today: points, objects, closures, sorting, json, maps, spreads, fib.

## Is the machine quiet enough?

A calibration is kept only when two measurements taken one after the other agree.
`heisenbench calibrate points` counts every case once and times it `--repeats` times (5 for the
committed sets), each time in a fresh process, and writes a point set. `heisenbench calibrate agree`
compares two:

| Check                                                                   | Allowed |
| ----------------------------------------------------------------------- | ------: |
| case-to-case change, median, after the whole-machine shift is taken out |      3% |
| whole-machine shift (every case faster or slower together)              |      5% |
| built-in prices, median, at sizes 16, 256, 4,096 (two price files)      |      5% |

3% is the time rule's own floor, a difference the PR comment would never call real. A shift
changes no rank and no time-led verdict (that needs a 2x gap), so it gets a wider bound.

The record from 2026-11-06, with other work running on the machine (load average 2 to 5):

| Sets   | ogygia cases: shape / shift | corpus: shape / shift | built-in prices | Verdict                   |
| ------ | --------------------------- | --------------------- | --------------- | ------------------------- |
| 1 vs 2 | 1.7% / +9.2%                | 1.4% / +2.6%          | -               | no: the machine slowed 9% |
| 2 vs 3 | 0.7% / +0.3%                | 0.9% / -1.0%          | -               | points yes                |
| 3 vs 4 | 1.1% / -4.2%                | 1.1% / -0.1%          | timed two ways  | points yes, prices no     |
| 4 vs 5 | 1.2% / +2.5%                | 0.9% / +0.2%          | 4.2%            | agreed                    |

Sets 4 and 5 are committed in `calibration/data/` (`points-corpus-1.json` and `-2.json`,
`points-ogygia-1.json` and `-2.json`), and the weights are fitted on both together.

## Running it

On a quiet machine, from `packages/heisenbench`:

```bash
node src/cli.ts calibrate points --repeats 5 --out a.json   # the corpus; add bench files and --root for more
node src/cli.ts calibrate points --repeats 5 --out b.json
node src/cli.ts calibrate agree a.json b.json               # exit 1 when they disagree
node src/cli.ts calibrate weights --points a.json,b.json    # fit, write weights.json
node src/cli.ts calibrate prices --out prices.new.json      # every built-in, every size
node src/cli.ts calibrate agree prices.json prices.new.json
```

`calibrate prices` takes `--keys Map.prototype.get,JSON.parse` to time a few built-ins.

## The price audit

Calibration sets prices on a corpus, one built-in or one kind of code at a time. The audit
(`heisenbench audit`, [layers.md](layers.md#price-audit)) checks them on the code they price, on
every main and nightly run: does each kind of step grow with the input the way time does?

**The points.** Each case that declares `scale`, at 1x, 10x and 100x. At each size: its units
(what ran, before pricing), from the growth layer, grouped into kinds (each op kind, each dynamic
price, each built-in with its size terms) and priced with the current `prices.json`; and the time
of its median call on the plain build. Timing runs in 5 rounds, each round in a fresh process that
times every case at every size, so the sizes of one round share the process's luck. Within a
round each size is timed in three slices taken in turns (1x, 10x, 100x, 1x, ...) and keeps its
median slice.

**Why the median call, in slices.** The audit runs on shared CI runners. A process on a busy
machine waits for a core for whole scheduler slices, and the mean of a slice of calls takes those
waits in: on 16 cores running 48 other processes, one round read 1x at 782 ns and 2,945 ns in two
slices. One call rarely spans such a wait, so the median call does not see it, and a burst that
still bends one slice of one size is outvoted by the other two. With the mean of one slice per
size, the CLI answer key (`test/audit-key.test.ts`) missed the planted join price in 1 of 20 runs
beside 16 busy processes (`yes > /dev/null`, on the 16-core M4 Max). With median slices of median
calls both audit test files passed 20 runs of 20 beside 16 (load average 25 to 38) and 20 of 20
beside 48 (load average up to 96), where median slices of the mean still missed the price in 15
of 20. The median call leaves out GC pauses rarer than every other call, at every size alike.

**The fit.** The same fit calibration uses for weights (`fit_relative` on `nnls`, rows scaled by
1/ns so each size weighs the same), per case and per round, with competing models of time:

| Model    | Time                                  | Means                                                 |
| -------- | ------------------------------------- | ----------------------------------------------------- |
| steps    | `t × steps`                           | the prices are right                                  |
| constant | `c + t × steps`                       | a cost per call that steps do not see                 |
| engine   | `t × steps^g`, g from 0.9 to 1.3      | the engine slows a little per step as input grows     |
| kind k   | `t × (steps − steps_k) + b × steps_k` | kind k costs b/t times what its price says            |
| term k.n | `t × steps + b × units_k.n`           | built-in k costs something per n its price leaves out |

Only kinds that grow apart from the rest of their case are tested: the ratio of their steps to the
rest's must change by 1.25x or more from 1x to 100x. A kind that grows with the rest fits time
exactly as well with any price, so growth says nothing about it.

**The rule.** A round blames a kind when the steps model misses time by 15% or more (RMS of the
relative errors over the sizes), the kind's model leaves at most 10% of that squared error and at
most half of what the constant and engine models leave, and the kind's factor is beyond 4x either
way. Several kinds can explain one round: when the rest of a case grows like time, any single
kind of the rest explains it too, by making every other kind free. So the explanation is the one
that changes the case's steps the least (a price of 0 on a kind with 90% of the steps changes 90%
of them; a 1000x factor on a kind with 0.1% changes them 100 times over), and factors that make
everything else free are not explanations at all. It is a finding only when every round blames
the same kind, the time layer's no-overlap idea: one noisy round cannot make it.

One kind of round has no say: a round no model explains (the steps miss its time, and so do every
kind, the per-call constant and the engine), which is what one size timed slow by a burst of other
work looks like. It abstains instead of clearing the case; the rounds left must still be most of
them, at least two, and all blame the same kind. A round that blames another kind, or that a
constant or the engine explains, still clears it (`test/audit.test.ts`: a planted price is found
with one round bent 1.9x at 10x; two bent rounds out of three, or three fair rounds each bent at
a different size, find nothing).

A second kind that explains any round nearly as well (its change within 1.5x of the best's)
makes the case **ambiguous**: no finding, and the candidates are listed in the JSON. A finding
names one price or none.

**Why these numbers.** On today's prices, 22 of ogygia's 29 audited cases miss time by less than
15%; the old join pricing missed by 46% to 77%. 4x is a price far off, not a calibration that
drifted (the old join price was off 50x to 10,000x). The engine model stops at 1.3, yet it still
removes 90% of the miss on `match_path`, whose time grows with exponent 1.35 to 1.49 on linear
steps (the route table outgrows the caches at 100x). On 300 synthetic cases with every price
right, 3% to 10% timing noise and random mixes of linear, n log n and quadratic work, it finds
nothing; a planted per-character join price and a planted size-blind `splice` are found
(`test/audit.test.ts`). `test/audit-key.test.ts` runs the CLI on a page built with `+=`: quiet
with today's prices, `dyn.string_char` on the page and nothing on its control with the old ones.

**What it cannot see.** A price off by a constant factor on a kind that always grows with the rest
of its case. A time that grows faster than every kind's steps (`match_path`) is put down to the
engine, so a missing size term on such a case is not named. Only cases with a scaler are audited.

## Versions and recounts

`prices.json` has a `version` (2 today) and a content hash. Every report records both. When
`heisenbench diff` gets two reports counted with different price files, it does not compare them as they
are: each report also keeps its **units**, what ran before it was priced (operations executed,
built-in calls and the sum of their sizes as n, n log n and n², dynamic sizes). The diff prices
both reports again with the current `prices.json` and compares those. A stored result from an
older price file stays comparable with a new run.

The recount is exact for self steps, lines, blocks, built-in entries and totals. Inclusive steps
are a running total the runtime keeps and cannot be split back into units, so a recounted report
keeps the old ones, says so (`prices.recounted_from`), and the diff ignores them.

`weights.json` records the price version and hash it was fitted with, the Node version and the
machine. Weights only feed the `≈ ns` estimates and the time-led verdict; they never change a
count.

Every report also records where it was counted (`env`): the Node and V8 versions, the platform
and architecture, and the version and hash of the weights. `heisenbench diff` names any difference
between the two reports at the top of its section and leaves engine health out when Node or V8
differ. Steps are still compared: a count does not depend on the Node version, the machine or
the checkout path (see [how counting works](how-counting-works.md#built-ins)). Layers written
into one report (`heisenbench health --out` an existing report) must come from the same Node; Heisenbench
refuses to mix them.

The real-world check (`suites/ogygia/src/correlate.ts --summarize --prices <file>`) recounts its
stored measurements with any price file, so a new calibration can be judged on the same commits
before it is committed.

## Training data

ogygia's history is too short to learn from: a few dozen commits, and a handful whose steps
changed. `suites/ogygia/src/training.ts` adds planted pairs (slowdowns, speedups and harmless
edits built from the answer keys, at a few sizes) to the replayed history and measures both the
same way: counts, engine health and input size of each side, then both sides timed in turns and
judged by the time layer's noise rule. The labeled pairs (step change, and whether time changed
beyond noise) are in `calibration/data/training-counts-<v>.json` (exact, the same bytes on every
run) and `training-times-<v>.json` (every sample and the machine's load while it was timed).
[calibration/data/training.md](../calibration/data/training.md) has the fields and the command
that regenerates them. Nothing in a count or the gate reads them.

The odds next to a changed case in the PR comment ("73%: odds it shows on the clock") are a model
fitted on them: [feel-odds.md](feel-odds.md). `heisenbench feel train` fits it again from a
dataset version (2 by default, timed on a quiet runner).

## Ranges: steps to ms, with a range

`ranges.json` turns counts into a time with a range: `1.2 ms, likely 0.9 to 1.6`. It is trained
on the training data above and shown next to the weights' estimate wherever ms are estimated:
the `≈ ns` of a changed function in the step table, the per-unit impact and the real cost of the
ranked findings, the real cost of a blamed change, the case estimate in a report, and the time
the audit measured at the largest size. It is extra text. Pass or fail, what is shown, the
ranking and the time-led verdict all stay on the steps and on `weights.json`, which stays the
explainable baseline.

**The model** has two parts, both in `src/ranges/`:

- a linear part, the same non-negative fit as `weights.json` (ns per op kind, per built-in step,
  per dynamic step, per call), refitted on the training data;
- three ensembles of 120 boosted trees of depth 3, one per quantile (10%, 50%, 90%), each
  predicting how far off the linear part is (log of measured over linear) from what the code is
  made of: its share of steps in each group of kinds (calls, property access, arithmetic,
  control, allocation, string ops, loops, dynamic sizes, string, regexp, array, Map/Set, JSON,
  Object and other built-ins), its steps, built-in calls, calls, allocations and bytes, its input
  size, its engine health (share of functions in TurboFan, unoptimized, inlined; deopts;
  polymorphic and megamorphic sites) and the Node major version.

A report's units say nothing of engine health or input size, so that is how the model is asked
almost everywhere (a function's change, a case's estimate, the audit). Trained on fully measured
rows alone, it held only 68% of held-out times when asked from counts alone. So every training row
is there twice at half its weight, as measured and from counts alone, and the trees learn both
(a feature that is not known goes down the side most training rows went). On versions 1 and 2
the engine and input-size features add nothing held out (the two "model" rows below); they are
kept for data where they will.

The trees use the quantile (pinball) loss: each tree fits the loss's gradient by least squares,
and each leaf takes the q-quantile of what is left to explain in it. Rows are weighted by
`10 / load` (the quieter groups count more) and by one over the number of times the same code was
timed (an unchanged case at every commit counts once in all). On version 2 (load 2 to 4 on 4
cores) the load weights still help a little: weighed alike, the held-out median log error is
0.053 against 0.046.

**Trained on version 2 alone**, the quiet runner (4-core AMD EPYC, Node 26.13). The times it
predicts are that runner's, which is what most PR comments are made on; a laptop core can be
faster. Version 1 (the busy laptop) and version 2 time the same code on two machines, and the
model has no feature that tells them apart, so training on both blurs the level. Held out by
change on the v2 sides (a change's v1 sides left out with it):

| Trained on | Median abs error | Median log error | Inside 10-90% | Median width | Changes: median error | Changes: inside |
| ---------- | ---------------: | ---------------: | ------------: | -----------: | --------------------: | --------------: |
| v2 alone   |           9.5 µs |            0.046 |           86% |        1.63x |                   36% |             83% |
| v1 and v2  |          12.1 µs |            0.057 |           91% |        1.90x |                   32% |             89% |

Both together hold a few more held-out times, by widening every range; the estimates
themselves are a quarter further off. Held out by code, both together are no better (median log
error 0.636 against 0.639) and their range is 52x wide against 29x.

**The range is checked on data it never saw.** The trees alone give ranges that are too narrow
on new code. So the range is widened by conformalized quantile regression: the model is trained
again with one fold of groups left out at a time, every left-out side scores how far outside its
range it fell (asked both ways, as measured and from counts alone), and both ends move by the
score that 85% of them stay under. 85%, not 80%, because
code at a new commit is a little further from the training data than the folds are from each
other; at 80% the held-out coverage was 80 to 82% depending on the seed.

**A change** (PR minus base) costs what an average step of the code it lives in costs: the
estimate of the side with more steps, without the cost of the call itself, over its steps. Its
range is wider, and its own: the same folds give how far the held-out changes (the pairs whose
time moved beyond noise) were off, and the range is the estimate times and over the miss that
85% of them stayed under (6.1x today). The cost of the call itself is taken off the model's
estimate, not the linear part's: on version 2 the linear part puts 32 ns on a call and 0 ns on
branches and compares, so for code made of those it is the call's cost alone, and a change of
them came out as 0 ns. The linear part of the changed units, as the weights price a change,
missed by 75% at the median on version 1, because the fit puts 0 ns on several op kinds; the
difference of the two sides' estimates let a change that crosses one split of a tree move the
whole call's time.

**Held out by change** (a commit of the history, or a planted change with all its sizes and its
undo, is never on both sides), from [calibration/ranges.md](../calibration/ranges.md):

| Estimate                                 | Median abs error | Median log error | Mean log error | Inside 10-90% | Median width |
| ---------------------------------------- | ---------------: | ---------------: | -------------: | ------------: | -----------: |
| `weights.json` (today)                   |         100.7 µs |            0.828 |          1.136 |           57% |         5.5x |
| linear part alone, refitted (NNLS)       |          30.0 µs |            0.216 |          0.489 |           75% |         3.3x |
| model, from counts (as reports use it)   |           9.5 µs |            0.046 |          0.233 |           86% |         1.6x |
| model, with engine health and input size |           9.5 µs |            0.046 |          0.232 |           87% |         1.6x |

On version 1 the same rows were 59.8 µs, 41.3 µs, 16.3 µs and 17.1 µs (median log error 0.655,
0.314, 0.077, 0.081; inside 58%, 74%, 85%, 87%). The quiet runner's times are tighter, so the
model's estimate and its range both close in (2.2x wide on v1). `weights.json` was calibrated on
the laptop, so on the runner's clock it is further off than before.

For changes (92 pairs whose time moved beyond noise): median error 36% against 86% for the
weights and 29% for the refitted linear part, the right sign every time, 83% inside a range 13x
wide at the median (v1: 43%, 80%, 27x). The linear part's estimate of a change is closer, but
its range holds only 58% and it has the wrong sign 4% of the time. For a whole call, the groups
below 80%, by the kind that holds most of the steps: control flow 72%, Map/Set 67% (12 sides,
log error 1.7: still the kind the model misses most); by input size, 10K to 100K at 78%.

Held out by code (a bench file of the history, or a planted template, never on both sides: 16
groups) the model does worse than on version 1: median log error 0.639 against 0.528 for the
linear part and 0.828 for the weights (v1: 0.412, 0.547, 0.655), median abs error 130 µs against
91 µs and 101 µs, and its range has to be 29x wide to hold 87%. On code unlike all of the
training data, the range says little, and on version 2 the plain linear fit is the better guess
of the level. That is the limit of the data: 211 planted pairs and 19 commits of one project.

**Determinism.** Training draws rows with a seeded generator and rounds every number it keeps to
7 significant digits; the same data and seed give the same `ranges.json`, byte for byte (a test
retrains it and compares). The file is 75 KB (22 KB gzipped) and records the data version and the
hash of its two files, the prices it was trained with (a different price file turns it off) and
the Node version.

**Retrain** from `packages/heisenbench`:

```bash
node src/cli.ts calibrate ranges                                   # ranges.json from training data 2
node src/cli.ts calibrate ranges --md calibration/ranges.md        # and the held-out evaluation
node src/cli.ts calibrate ranges --data-version 1 --out /tmp/r1.json --md /tmp/r1.md   # the busy laptop's data
```

Run it again over the committed file: it says `(unchanged)` and leaves the bytes as they are,
which is the check that the committed model is what the data gives.

`--seed` sets the seed, `--data` another data directory, `--out` another model file. The model's
version goes up when what it predicts changes.
