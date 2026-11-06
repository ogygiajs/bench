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

`abax calibrate prices` times each priced built-in on the plain build with tinybench, at sizes 16,
64, 256, 1,024 and 4,096. Each tinybench iteration makes 64 calls, and the cost of the harness
itself (an empty function through the same loop) is taken off. Timing one call per iteration
mostly timed the two timer reads around it: `Map.prototype.get` came out at 249 steps that way,
and is 24.5 now.

Each built-in's times are fitted as `ns = base + k × f(n)` for `f` in const, n, n log n and n²,
with `base, k ≥ 0`, by relative least squares so small sizes count as much as large ones. The
simplest model within 0.02 R² of the best wins. Then ns become steps through the step time.

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

One known oddity: `Object.keys`, `values`, `entries` and `assign` fit best as n² over 16 to 4,096
keys, because large plain objects are in V8's dictionary mode. ogygia's objects are small, where
the n² term is a few steps.

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
`abax calibrate points` counts every case once and times it `--repeats` times (5 for the
committed sets), each time in a fresh process, and writes a point set. `abax calibrate agree`
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

Sets 4 and 5 are committed in `calibration/data/`, and the weights are fitted on both together.

## Running it

On a quiet machine, from `packages/abax`:

```bash
node src/cli.ts calibrate points --repeats 5 --out a.json   # the corpus; add bench files and --root for more
node src/cli.ts calibrate points --repeats 5 --out b.json
node src/cli.ts calibrate agree a.json b.json               # exit 1 when they disagree
node src/cli.ts calibrate weights --points a.json,b.json    # fit, write weights.json
node src/cli.ts calibrate prices --out prices.new.json      # every built-in, every size
node src/cli.ts calibrate agree prices.json prices.new.json
```

`calibrate prices` takes `--keys Map.prototype.get,JSON.parse` to time a few built-ins.

## Versions and recounts

`prices.json` has a `version` (2 today) and a content hash. Every report records both. When
`abax diff` gets two reports counted with different price files, it does not compare them as they
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
and architecture, and the version and hash of the weights. `abax diff` names any difference
between the two reports at the top of its section and leaves engine health out when Node or V8
differ. Steps are still compared: a count does not depend on the Node version, the machine or
the checkout path (see [how counting works](how-counting-works.md#built-ins)). Layers written
into one report (`abax health --out` an existing report) must come from the same Node; Abax
refuses to mix them.

The real-world check (`suites/ogygia/src/correlate.ts --summarize --prices <file>`) recounts its
stored measurements with any price file, so a new calibration can be judged on the same commits
before it is committed.
