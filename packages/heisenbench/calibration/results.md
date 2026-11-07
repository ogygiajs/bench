# Calibration and the real-world check

Measured on 2026-11-06 on an Apple M4 Max (16 cores, macOS, darwin 27.0.0), Node v26.4.0, V8
14.6.202.34-node.21. The same machine and versions are written into `prices.json` and
`weights.json`. Other work ran on the machine at the same time (load average 2 to 5), which is
why every number here comes with a check that two measurements agree.

## 1. Is the machine quiet enough?

A calibration is only kept when two measurements taken one after the other agree
(`heisenbench calibrate agree`). Each measurement (`heisenbench calibrate points`) counts every case once and
times it 5 times, each time in a fresh process. Two sets are compared case by case:

- **Case-to-case** change (median, after taking out the whole-machine shift): at most **3%**. That
  is the time rule's own floor: a difference the PR comment would never call real.
- **Whole-machine shift** (median ratio): at most **5%**. A shift makes every case faster or slower
  together. It changes no rank and no "time-led" verdict (that needs a 2x gap), so it gets a wider
  bound.
- **Built-in prices**: at most **5%** median. Prices are a ratio of two timings from one run, so a
  shift cancels out of them.

| Sets   | ogygia cases: shape / shift | corpus: shape / shift | built-in prices                              | Verdict                           |
| ------ | --------------------------- | --------------------- | -------------------------------------------- | --------------------------------- |
| 1 vs 2 | 1.7% / +9.2%                | 1.4% / +2.6%          | -                                            | no: the machine slowed down by 9% |
| 2 vs 3 | 0.7% / +0.3%                | 0.9% / -1.0%          | (set 2 had none)                             | points yes                        |
| 3 vs 4 | 1.1% / -4.2%                | 1.1% / -0.1%          | timed two ways (the fix in 2 landed between) | points yes, prices no             |
| 4 vs 5 | **1.2% / +2.5%**            | **0.9% / +0.2%**      | **4.2%**                                     | **agreed**                        |

Sets 4 and 5 are committed in `data/` (`points-*-1.json`, `points-*-2.json`). The weights are
fitted on both of them together.

## 2. Built-in prices

The old calibration timed one call per tinybench iteration. For a fast built-in that mostly timed
the two timer reads around the call: a `Map.get` came out at 249 steps. Now each iteration makes 64
calls and the harness's own cost (an empty function through the same loop) is taken off. `Map.get`
is **24.5** steps now (2.4 ns).

A few prices, in steps (one step = 0.0997 ns on this machine, the median time per step of the
corpus cases that call no built-in):

| Built-in                 | Seed (v1)      | Calibrated (v2)                          |
| ------------------------ | -------------- | ---------------------------------------- |
| `Map.prototype.get`      | 6              | 24.5                                     |
| `Array.prototype.sort`   | 20 + 4 n log n | 66 n log n                               |
| `Array.prototype.map`    | 10 + 2 n       | 150 + 53 n                               |
| `String.prototype.slice` | 6 + 0.25 n     | 17.75 (V8 makes a slice without copying) |
| `JSON.parse`             | 20 + 0.75 n    | 400 + 11 n                               |

Prices are stored as binary fractions (whole numbers from 64 up, quarters from 8, 1/64 below), and
n log n is rounded to 1/64. That keeps counts exact: a recount from units gives the same number as
the runtime's own count, to the bit.

Known oddity: `Object.keys`, `values`, `entries` and `assign` fit best as n² over 16 to 4096 keys.
Large plain objects are in V8's dictionary mode, which is slower per key. ogygia's objects are
small, where the n² term is a few steps.

### Decision: calibrated prices replace the seed prices

The test: across ogygia's 57 bench cases, do steps rank the cases the way their measured time
does? Spearman's rank correlation of steps against p50:

| Prices              |     Set 4 |     Set 5 |
| ------------------- | --------: | --------: |
| seed (v1)           |     0.816 |     0.817 |
| **calibrated (v2)** | **0.843** | **0.842** |

The gain comes from the relative prices of the built-ins, not their overall level: scaling every
calibrated built-in price by 0.5, 0.33 or 0.2 gives 0.847, 0.845 and 0.841. Op prices stay the
seed prices (a step is one simple op). Built-ins are now 83% of an ogygia case's steps (median),
against 35% before.

### Size terms: prices v3 (2026-11-07)

The price audit flagged `String.prototype.split` on ogygia's growing `transformHost` case: acorn
splits the template up to each expression into lines, and `split` was priced per character
(366 + 18.5 n), while its time follows the parts it cuts. A built-in's price can now have size
terms beside n (`base + k f(n) + Σ kₜ t`, [how-counting-works.md](../docs/how-counting-works.md#built-ins)),
and six built-ins were calibrated again at several input shapes per size, so the fit can tell
characters from parts, matches, callbacks and converted elements apart.

**Two calibrations agree.** `heisenbench calibrate prices --keys <the six>` twice, one after the
other (M4 Max, Node 26.4.0, load average 6 to 9 from other work): `calibrate agree` on the two
files, the six built-ins at 16, 256 and 4,096 and every shape (78 prices): **median |Δ| 1.22%**,
p90 2.31%, worst `Array.from` at 16 with no callback (10.3%, 86 vs 78 steps). Allowed: 5%. The
committed prices are the mean of the two, in ns, quantized as before.

**The step.** The corpus reference read 0.151 to 0.155 ns per step that day, against 0.0997 when
the file was calibrated, while the built-ins that did not change timed as they did then
(`Map.prototype.get` 2.3 ns, priced 24.5 steps = 2.44 ns; `String.prototype.slice` 1.8 ns,
priced 1.77 ns). The reference moved, not the machine's built-ins, so the new prices are in the
file's step, 0.0997 ns: dividing by the day's reading would have made these six 35% cheaper than
the other 51.

| Built-in                      | v2            | v3                                | R² (log) |
| ----------------------------- | ------------- | --------------------------------- | -------: |
| `String.prototype.split`      | 366 + 18.5 n  | 154 + 125 parts                   |    0.984 |
| `String.prototype.replace`    | 294 + 12.5 n  | 242 + 115 matches + 206 callbacks |    0.997 |
| `String.prototype.replaceAll` | 246 + 15 n    | 121 + 135 matches                 |    0.998 |
| `String.prototype.match`      | 363 + 0.516 n | 162 + 0.359 n + 7.375 matches     |    0.938 |
| `Array.prototype.join`        | 33 n          | 59.25 + 2.03 n + 223 items        |    0.951 |
| `Array.from`                  | 98 + 1.09 n   | 107 + 1.20 n + 137 callbacks      |    0.993 |

**Evidence.** Each built-in timed again at 16, 256 and 4,096 at every shape, and each price
divided by the time (1.00x is right; above it the price charges too much):

| Built-in                      | Shapes | v2 price / time | v3 price / time |
| ----------------------------- | -----: | --------------- | --------------- |
| `String.prototype.split`      |      6 | 0.38x to 25.04x | 0.67x to 1.27x  |
| `String.prototype.replace`    |      6 | 0.08x to 11.27x | 0.80x to 1.23x  |
| `String.prototype.replaceAll` |      6 | 0.21x to 12.25x | 0.88x to 1.27x  |
| `String.prototype.match`      |      3 | 0.18x to 2.80x  | 0.54x to 1.27x  |
| `Array.prototype.join`        |      3 | 0.92x to 20.20x | 0.30x to 1.25x  |
| `Array.from`                  |      2 | 0.01x to 1.14x  | 0.82x to 1.25x  |
| `JSON.parse`                  |      3 | 0.33x to 2.24x  | (unchanged)     |
| `JSON.stringify`              |      3 | 0.88x to 1.32x  | (unchanged)     |

`JSON.parse` and `JSON.stringify` keep their v2 prices: within 3x and 1.4x on numbers, small
records and long strings, the evidence does not call for more. Their `values` term is kept in the
units, so the audit can test it. `replaceAll`'s callbacks cost nothing beyond its matches (the fit
puts them at 0). A `/\S/g` replace that matches almost every character (Svelte blanking the code
before a snippet's parameters) times 7.1 ns per match against 11.5 priced, 19.2 with a callback
against 32: 1.6x over, inside the audit's 4x.

**On ogygia** (`01dc5b9`, all 57 cases): 34 cases count differently with v3, 33 of them fewer
steps. The largest moves are the cases built on `replace`, `split` and `join` over long strings:
`frontmatter` 0.10x, `search: strip and excerpt` 0.15x, `absolutize` 0.29x, `lift_document`
0.30x; `fill: the href of every link` 1.43x (a `join` of numbers). The two rows of the real-world
check (section 4) where steps overstated time were `lift_document` and `absolutize`, put down to
`replace` with a callback priced too high on that code: v3 prices them at 0.30x and 0.29x of v2.

**Recounts.** Every report now keeps its size terms (`unit_terms`) and recounts with v3 exactly.
A report from before them has no parts or matches to price: `recount` refuses it and a diff
calls the two reports not comparable, rather than read the old side as cheaper. The stored
reports of the real-world check (section 4) are such reports; it is to be measured again before
it is recounted with v3. `weights.json` is still the fit on v2 prices: it only feeds `≈ ns`.

## 3. Weights (steps to nanoseconds)

Fitted on 250 points (the corpus and ogygia's 57 cases, both agreeing sets): **R² 0.91** on the
log scale. Eight corpus families fit below 0.9 and are marked time-led (trust the time layer for
them): points, objects, closures, sorting, json, maps, spreads, fib.

## 4. The real-world check

`suites/ogygia/src/correlate.ts` takes every commit on ogygia's main since the package split
(2026-11-01) that touches benched source: **29 commits**, each against its parent. Today's bench
files are laid over both trees (a case whose code did not exist yet is left out: 31 to 57 of the 57
cases load on each tree). Steps are counted on both. Time is measured on the plain build for the
bench files whose import graph reaches a changed file, both trees in one process taking turns, 8
rounds each, and judged by the same no-overlap rule PR comments use.

18 commits reached a bench file: **190 case measurements**. Steps are recounted with the v2 prices.

|                        | Time significant | Time same |
| ---------------------- | ---------------: | --------: |
| **Steps changed ≥ 3%** |                2 |         0 |
| **Steps changed < 3%** |                1 |       187 |

- When steps moved by 3% or more, time moved too, in the same direction (2 of 2).
- No false alarm from steps: 0 rows where steps said slower and time saw nothing.
- One time change that steps missed (below).
- Spearman over all 190 rows is -0.12 and over the 10 rows whose steps changed at all, 0.09. Neither
  means much here: 180 rows have exactly zero step change (all tied), and 8 of the 10 changed rows
  moved by under 2%, inside the time noise (median |Δp50| of unchanged rows: 0.5%, p90: 2.5%).
- The formatting commit (`b694a04b`, the whole repository reformatted): 19 cases, nothing changed
  in either steps or time.

### Where they disagree, and why

| Commit                         | Case                                                 | Δsteps |  Δp50 | Why                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ---------------------------------------------------- | -----: | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `a99a49a7` messages get codes  | flags: six flags read for 500 visitors               |     0% |  +11% | Engine, not code: the same code ran (zero step change), and engine health on both trees is the same (same tiers, same inline-cache states). The change only swapped a `console.warn` on a path that never runs for a `warn()` from a new messages module. The new module graph is the likely cause (more heap, other code layout). Heisenbench's step layer cannot see this; the time layer did. |
| `a217b913` content-named files | lift_document: a remote page into the fragment shape |  +134% |  +69% | Built-in pricing: the new work is `String.prototype.replace` with a callback, `JSON.parse`/`stringify` and regex tests. Their calibrated prices overstate them on this code (the weights fit says built-in steps cost a third of a plain step here). With the seed prices the same change was +31% steps: understated instead.                                                                   |
| `a217b913` content-named files | absolutize: a widget body with its island graph      |  +157% | +106% | Same cause, same direction. Seed prices: +115%.                                                                                                                                                                                                                                                                                                                                                  |
| `e229a9a3` eight plugin bugs   | flags: six flags read for 500 visitors               |  +1.9% |  -10% | Below the 3% floor on the steps side; time called it "same" (this case's rounds spread widely).                                                                                                                                                                                                                                                                                                  |

### What this does not show yet

The history is short: the bench files are new, and most of the month's commits changed code the
bench files do not reach. Only 3 rows changed enough to matter. The check is a script
(`node suites/ogygia/src/correlate.ts --from <rev>`) so it can be run again over a longer history,
and `--summarize --prices <file>` recounts the same measurements with any price file.

Raw data: `data/real-world.json` (every row, with base and PR steps, p50 and mean).
