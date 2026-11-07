# Layers

Steps are a model of the work the code asks for. Each layer here checks something the model
cannot see, or turns the count into an answer to a different question. Engine health, time, real
bytes and leaks run on the **plain build**: the code as it ships, nothing counted. The plain build
still compiles `.svelte` files and appends the `__heisenbench` export, so the same bench files run on it.

| Layer             | Command                                              | Build    | On PRs                                     | On main and nightly  |
| ----------------- | ---------------------------------------------------- | -------- | ------------------------------------------ | -------------------- |
| Steps             | `heisenbench run`                                    | counting | yes                                        | yes                  |
| Engine health     | `heisenbench health`                                 | plain    | yes                                        | yes                  |
| Growth            | `heisenbench growth`                                 | counting | cases with `scale`                         | cases with `scale`   |
| Recorded growth   | `heisenbench growth --recorded`                      | counting | the changed source files                   | every source file    |
| Price audit       | `heisenbench audit`                                  | both     | no                                         | cases with `scale`   |
| Time              | `heisenbench time`, `heisenbench run --measure time` | plain    | yes                                        | yes                  |
| Real bytes        | `heisenbench run --measure bytes`                    | plain    | no                                         | yes                  |
| Leaks             | `heisenbench run --measure leaks`                    | plain    | no                                         | yes                  |
| Worst-case search | `heisenbench search`                                 | counting | changed cases with a `setup`, 4 min budget | no                   |
| Real-app weight   | `heisenbench weights`, `heisenbench diff --weights`  | counting | ranks the changes                          | produces the weights |
| Real traffic      | `heisenbench weights import`                         | none     | ranks the findings by CPU time per day     | the owner uploads it |
| Coverage          | `heisenbench coverage`                               | counting | no                                         | no                   |
| Gate              | `heisenbench unmeasured`                             | counting | in ogygia's CI                             | no                   |

The examples on this page come from runs on an M4 Max with Node 26.4.0 at Heisenbench `7b3d7a5`: the
quick-start project in the [README](../README.md), the planted cases of `heisenbench verify`, the planted
router PR, and the app benchmark's scenarios.

## Engine health

What V8 did with the code. `heisenbench health` runs each case in a child process without counting, with
`--allow-natives-syntax`, V8's code, inline-cache, deopt and function-event logs, and flags that
make V8 tier up at the same points every time: `--single-threaded`,
`--no-concurrent-recompilation`, `--predictable`, `--no-flush-bytecode`, fixed random and hash
seeds. And flags that keep the garbage collector off the clock: a 1 GB initial old space
(`--initial-old-space-size=1024`), so a normal run has no full collection; a young generation of
one fixed size (16 MB), so young collections follow allocation alone; no incremental marking and
no compaction, so a full collection that does happen is atomic and moves nothing. A collection
decides which closure contexts and maps die and how strings look, and those decide inline-cache
states and some deopts. On V8's own schedule it moves from run to run: before these flags,
ogygia's `store macros` case deopted `walk` ("embedded weak objects cleared") in 2 of 12 runs.

For each case:

1. 20 warm-up runs (`--warmup`). V8 tiers code up on its own.
2. Every function the bench can reach is prepared and marked to optimize on its next call
   (`%PrepareFunctionForOptimization`, `%OptimizeFunctionOnNextCall`). This is the fixed point.
3. One run (the forced optimization), then 3 more (`--runs`).
4. Each function's tier is read with `%GetOptimizationStatus` and decoded into plain words:
   interpreted, baseline, maglev, turbofan, deoptimized.

Every inline cache (a property read or write, a keyed access, a global lookup) gets the worst
state it reached: monomorphic, polymorphic or megamorphic. Deopts come with V8's reason.

With `--check on` (the default) every case runs twice. If the two runs differ, it runs two more
times, and each function or inline cache that differed is marked `unstable` in the report, with
what differed (`tier maglev / turbofan`, `state monomorphic / polymorphic`). The rest of the case
is kept. The diff leaves unstable entries out on both sides and says how many in one line:
`2 functions skipped: V8 not repeatable`. Deopts the collector decides ("embedded weak objects
cleared", "dependent allocation site tenuring changed") are kept in the report but are never
findings. A health child has a 10 minute limit; one that runs past it is that case's error.

A keyed access (`obj[key]`) keeps one property name in its cache. A second name makes it
megamorphic, even when every object has the same shape. Such a site is reported as
`generic (keys of many names, not many shapes)`, so it is not read as "many object shapes". A
site that saw more shapes than a polymorphic cache holds (4) stays `megamorphic`.

A function that is not optimized gets one of three reasons:

| Reason      | What happened                                                              |
| ----------- | -------------------------------------------------------------------------- |
| cold        | It did not run often enough to be optimized. Not a problem.                |
| refused     | It was marked to optimize and V8 did not.                                  |
| deoptimized | It had optimized code and lost it, or a deopt on code that had run hit it. |

```
ok       rank: twenty rows  2/2 optimized, 0 cold, 0 refused or deoptimized, 1 poly/megamorphic site(s)
```

PR against base, these are findings:

- a function that is no longer optimized, unless it is now only cold
- a deopt reason the base did not have
- an inline cache that reached more shapes (monomorphic to polymorphic to megamorphic)
- new code that deopts or is megamorphic

A deopt on code that had never run when the function was optimized (a branch taken for the first
time) is kept in the report but is never a finding: every new branch pays it once. The other
direction (an IC that got better) is listed, never a finding. Sites are matched by their id inside
the function (`property read length #0`), so moved lines never show.

From the planted `match_one` loop in the README:

```md
#### Engine

`match_path: every request against a 300-route table`:

- `packages/router/src/match.ts:140` new property read `charCodeAt` is polymorphic
- `packages/router/src/match.ts:140` new property read `length` is polymorphic
```

`heisenbench verify` plants a shape-order change, an int to double change, a `delete`, and a
megamorphic access, each with a same-line twin that must stay quiet. All are found at the right
function and line.

## Time

How long the plain build takes, measured with tinybench. Per case:

| Metric | What                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------- |
| p50    | Median time of one call. Setup and teardown run outside the timing.                                           |
| p99    | 99th percentile.                                                                                              |
| ops/s  | Calls per second, from tinybench's mean.                                                                      |
| CPU/op | Process CPU (user + system) per call, read over batches of calls whose setups ran before the reading started. |

`heisenbench time` compares two trees. Both are loaded in one process and take turns case by case, and
the side that goes first flips every turn, so warm-up, GC debt and heat land on both sides. The
default is 5 turns, 300 ms timed and 100 ms warm-up per measurement, at least 64 calls.

Each turn loads fresh copies of both trees. One copy of a build keeps the machine code V8 made for
it for every turn, and with it a steady offset: two copies of the same code measured 3 to 8% apart
on a CI runner, every turn of one below every turn of the other, and the rule below called them
changed. A fresh copy per turn draws that offset again, so it shows as spread instead.

A case that looks changed after the 5 turns gets 5 more, on fresh copies, and is judged on all 10.
The log line ends in `(confirmed over 10 rounds)`.

The verdict is the no-overlap rule from `packages/compare`, the same one the app benchmark uses. A
metric changed only when all three hold:

1. every PR turn is on the same side of every base turn (with 5 and 5, that happens by chance once
   in 126 for two builds that perform the same; with 10 and 10, once in 92,378)
2. the medians differ by more than the larger spread of the two sides
3. the change is above the floor: 3% for p50, ops/s and CPU/op, 5% for p99

Cells show the range over the turns, base then PR, with `⚠️` (worse), `better`, or `≈`:

```md
| Case | p50 | p99 | ops/s | CPU/op |
| --- | --- | --- | --- | --- |
| `rank: twenty rows` | ≈ 83–84 ns → 84 ns | ≈ 125–167 ns → 125–167 ns | ≈ 10,425,649/s–11,139,814/s → 10,093,572/s–10,297,023/s | ≈ 88–91 ns → 89–92 ns |
```

That is the quick-start's planted loop: +520 steps, no change in time. When no case moved beyond
noise, as here, the comment says so in one line (`No case got slower or faster beyond noise (1
case, 5 turns each).`) and folds the table away under it.

CPU/op comes from `process.cpuUsage`, which reads the CPU clock in ticks far longer than a short
call. So the calls are read in batches of about 10 ms, each batch's setups done before its reading
starts, for a third of the timed phase. When the calls of all batches together used less than
20 ms of CPU (a cheap call behind a costly setup), the reading is the clock's tick, not the code:
the cell says `· below resolution` and the metric is not judged.

`heisenbench run --measure time` times one tree and puts p50 next to the steps in the report.

### Estimated ns and time-led cases

A report also carries an estimate: the case's operation counts times the fitted ns per operation
from `weights.json` ([calibration.md](calibration.md)). That is the `≈ +21 ns` next to a Δ in the
step table. A case is **time-led** when steps do not predict its time well: its family fitted
below R² 0.9 in calibration, or the measured time is more than 2x off the estimate either way. The
comment lists time-led cases under the step table: for them, trust the time layer.

## Real bytes

What V8 allocates. On the plain build the case is warmed until its code is optimized, then run in
batches under V8's sampling heap profiler, with objects later collected kept in the profile, so
every allocation counts, not only what survives. The child runs without inlining, so a function's
frame holds its own bytes.

The interval starts small (32 B between samples) and doubles until a batch stays under 200,000
samples, judged from a first coarse look at what one call allocates. Without that, a case that
allocates a lot came back with a profile too large for one string and crashed the child. A larger
interval spreads the same estimate over fewer samples; it is not biased.

Bytes are charged the way the estimate counts them. A byte allocated in a built-in or in Node's own
`node:` modules goes to the nearest source function under it, so bytes allocated inside `map` are
charged to the function that called `map`. A byte allocated in a dependency goes to that
dependency's function (`acorn@8.18.0/dist/acorn.mjs > Parser`), which the estimate counts too. A
byte allocated in the bench file or the harness is charged to none of them.

```
bytes   rank: twenty rows  estimated 16 B, real 907.66 B
```

The profile is per function, not per line. It is sampled, so it moves a little between runs: the
same code measured 907.66 B in one run and 928.11 B in the next.

When a function's estimate is at least 32 B and its real bytes are below half of it, the function
**elides** allocations: escape analysis removed objects that never leave it. The gap is put on
the function's allocation sites, largest first. An elided allocation is shown, never called a
regression:

```
bytes   rank: twenty rows  estimated 976 B, real 1006.58 B, 1 elided
```

```md
Allocations the engine elides (estimated, not real bytes; not counted as a regression): `src/rank.ts:9`
```

That is the `heisenbench verify` case: `const w = { len: t.length }` inside the loop of `score`. Per
function, `score` was estimated at 960 B (60 objects of 16 B) and V8 allocated 5.68 B. The case
totals look close only because `rank`'s real bytes (1000.9 B, the growing `out` array) are not
in the estimate: `push` grows the array in place, and the estimate does not follow that.

Elision qualifies the bytes, not the steps. A function whose steps changed is always in the step
table; when its added allocations are elided, its bytes cell says so (`+960 B (elided)`), and the
"Where" rows for those lines do too.

Real bytes above the estimate (backing stores that grow, what unpriced built-ins return) are
reported, never flagged.

## Leaks

Does the retained heap grow with every call? Clean code moves the heap too: V8 compiles and
re-tiers it, fills inline caches and feedback vectors, and two full GCs leave a few KB either way.
Over 1,000 calls that reads as 2 to 20 B a call, up or down. So a leak needs three kinds of
evidence, and clean code can give none of them. In a child with `--expose-gc`:

1. **Above this case's noise.** Three warm-up rounds of 1,000 calls (N), with a run of full GCs
   after the last two (V8 drops the bytecode of functions that sat unused through several GCs,
   such as the ones that loaded the bench file; inside a measured round that is a one-off drop of
   up to 6 MB). Then rounds of N, N, 2N and 4N calls. After each round, two full GCs and the used
   heap, so the heap is read at N, 2N, 4N and 8N calls. The first two rounds do the same work (an
   A/A pair): what their growth differs by is this case's noise. The case's floor is that noise
   spread over the 8N calls, or 4 B per call when larger. Growth per call over the 8N calls must
   reach the floor.
2. **Linear in calls.** A leak keeps about the same bytes per call from the start to 2N, 4N and 8N
   calls: each must be within a factor 2 of the 8N one. The first N calls can read far off (a hash
   table the earlier calls filled may double inside them, or not), so they only need to grow by 4 B
   per call. A backing store that doubles makes a real leak wobble inside these bounds; noise, a
   cache that fills once, or code V8 compiles late does not stay inside them.
3. **Held by a variable of the code under test.** Only then: a heap snapshot, 2 more rounds of N,
   GC, a second snapshot. Objects in the second that are newer than everything in the first were
   made by those rounds and are still held. Each gets its shortest strong retainer chain from the
   GC roots, where compiled code, feedback vectors, inline caches, hidden classes and allocation
   sites hold nothing. Read back from the object, the first variable that a function of a source
   module keeps alive (a module `let` or `const`, or one a closure captured) owns it. Objects no
   such variable owns belong to the engine, the bench file or a dependency, and are never a leak.
   The owned objects are grouped by variable and type. The largest group is a leak when it holds
   at least one object per 4 calls; its variable, the function that uses it, and the declaration
   line are reported.

A leak held only by a global property (`globalThis.x = ...`) has no owning variable and is not
reported. The log line gives the floor next to the growth, and says when a case grew but step 3
found nothing to blame:

```
leaks   rank: twenty rows  LEAKS  3406.76 B/call (floor 11.39)
leaks   transformHost: a route page with twenty islands, server leg  ok  10.83 B/call (floor 5.42)
```

That transformHost case is the kind the old rule flagged on clean code (10.5 B per call in one
full run). Its bytes per call from the start to N, 2N, 4N and 8N calls were 58, 36, 22 and 11: a
cache that fills once, not growth linear in calls. Cases whose first rounds free megabytes get a
high floor (up to about 750 B per call on ogygia main); a leak smaller than that in those cases
is not seen.

The two planted leaks in `heisenbench verify` keep every row: one in a module-level array, one in a
closure cache keyed by the row object.

```md
**Leaks** (retained heap grows with every call):

- `rank: twenty rows`: 3406.76 B per call, 40 (string) per call held by `seen` (`lib.ts:14`, kept growing by `rank`)
- `rank: twenty rows`: 3888.2 B per call, 40 (string) per call held by `cache` (`lib.ts:15`, kept growing by `memo > <anonymous>~8c88e4`)
```

Their twins (only the last row kept; the cache keyed by row id, twenty entries whatever the
calls) are not flagged. On ogygia main, two full runs of all 57 cases flag none.

## Growth

How steps grow with the input. `heisenbench growth` counts each case at 1x, 10x and 100x its input
(`--sizes`) and fits `steps = a + b × f(k)` for constant, log, linear, n log n, quadratic, cubic
and quartic, picking the best fit and the simpler class on a tie. Counts are exact, so three sizes
are enough.

```
ok       rank: twenty rows  linear (exponent 0.999; 897 / 8817 / 88017 steps)
```

Past quartic the class is `polynomial n^p`, with p the best power of `a + b × k^p` (a grid up to
12). Exponential is told from a high power by the local slopes: on four sizes or more, the log-log
slope between neighbouring sizes keeps rising, by half again or more at each of the last two steps
(a polynomial's settles toward its power), and `a + b × e^(ck)` must fit better than every power.

A size at 100x of an exponential input would never finish. Every run has a step cap (`--cap`,
default 10¹⁰ steps; the runtime stops a run past it where it loops). The first size that passes
it is not counted: growth stops there and falls back to a doubling ladder of the sizes below it
(1, 2, 4, 8 …), each under the same cap, and fits those. The line says so:

```
ok       exponential  exponential (exponent 7.999; 89 / 341 / 5381 / 1376261 steps; exceeded the cap at 16x, grown on 1x / 2x / 4x / 8x)
```

Exact steps of one input scaled up never fall. When they do, the scaled input is most likely not
valid input any more (a parser that stops at its first error, a function that refuses a repeated
element): the class is `shrinks` (only down) or `irregular` (down and up), `shrinks: the scaled
input may be invalid`, and a PR is never judged on it. The planted cases of each class (cubic,
quartic, every subset of the input, a function that refuses repeats) are in
`test/growth-classes.test.ts`.

Under each case it says where the steps are at the largest size: each package's share, and the
functions with the most self steps, each with its own curve. ogygia's compiler case on `57882cc`:

```
ok       transformHost: a route page as its island count grows  quadratic (exponent 1.921; 1903230 / 59631955 / 4976398602 steps)
           at 100x: 78% acorn@8.18.0, 14% own code, 6% svelte@5.56.8
           acorn@8.18.0/dist/acorn.mjs > Parser  quadratic (exponent 1.989; 573263 / 39848734 / 3888985404 self steps)
           packages/core/src/compiler/region/transform.ts > FileCompilation > #ast_refs_local > walk  quadratic (exponent 1.991; 85054 / 6995234 / 684590168 self steps)
           svelte@5.56.8/src/compiler/phases/1-parse/state/tag.js > open  quadratic (exponent 1.986; 40853 / 2717845 / 263030825 self steps)
           svelte@5.56.8/src/compiler/phases/1-parse/index.js > Parser > match_regex  quadratic (exponent 1.942; 11680 / 462466 / 40498614 self steps)
           magic-string@1.4.5/dist/index.mjs > MappingsEncoder > drain  linear (exponent 0.994; 102761 / 782582 / 7717161 self steps)
```

Svelte's template parser calls `acorn.parseExpressionAt(source, index, { locations: true })` for
every expression, and acorn's `Parser` constructor splits the whole source up to `index` into
lines: work linear in the position, quadratic over the file. With dependencies left uncounted
(`--deps none`) the same case read 705,683,366 steps at 100x, all of them ogygia's. A class change
in a PR names the function and the shares too.

The input is grown by a generic scaler: arrays and strings repeated k times, `Map` and `Set`
entries repeated with distinct keys, linked chains made k times deeper, plain objects scaled
property by property. Each collection grows once, so the input grows linearly in k. An input that
cannot grow that way (a size given as a number, a structure that must stay valid) declares its
own:

```ts
bench('match_path: every request against a 300-route table', ({ table, paths }) => ..., {
	setup: () => ({ table: compile_all(patterns(30)), paths: requests(30) }),
	scale: (_ctx, k) => ({ table: compile_all(patterns(30 * k)), paths: requests(30) })
});
```

PR against base, a class change (linear to quadratic) is a finding. The same class with more
steps is not: the step table already shows that. A side that `shrinks` or is `irregular` is listed
under "Steps that fell as the input grew", never a finding. CI grows only the cases that declare
`scale` (`--scaled on`).

## Growth from recorded calls

A function nobody wrote a growth case for still has a size curve: the calls its tests make.
`heisenbench growth --recorded <dir>` grows every function a recorded run called, from the
recorder's sample files (the measurement-source gate's recorder, below), no `scale` anywhere.

The recorder sizes each call's arguments (string length, array, `Map` and `Set` entries, object
keys, recursively: an AST counts its nodes; a walk stops after 2²⁰ values per call and 2²¹ per
function per process, so a hot function costs a bounded walk). Besides the first five distinct
inputs, it keeps one input per half octave of the summed size, up to 24, so the samples span the
sizes the run saw. Bench cases are a second source: `heisenbench record <bench files>` runs each
case once with the recorder on, often at sizes no test reaches. Merged, the samples are the same
whatever order the files come in.

Inputs that hold functions are kept too. A function that reads only its own names and the
language's globals is kept as its source (`readFile: () => null`), a Node module or one of its
functions by name (`path`, `fs.readFileSync`). A callback that closes over state is kept as a
stand-in that returns `undefined`: such a sample serves growth only, never the gate's replay. A
stand-in throws past 10,000 calls in one replay (a loop that waits for `removeChild` to empty a
fake node never ends with one), and that sample is left out.

Each sample is replayed on the counting build, once (a curve is many exact points; the two-run
check of a bench case would triple the cost and decide nothing), under a step cap of 5×10⁸, and
the function's inclusive steps are read
against each argument's size in turn. Different inputs of one size cost different steps (a page
with one island and a page with twenty), so the curve is read the robust way: the power is the
slope of log(steps) over log(size), r² says how much of it that line explains, and Kendall's tau
between size and steps per unit of size says whether the work per unit rises. The argument whose
size explains the steps best (highest r²) is the one growth is over. A curve needs four distinct
sizes spanning 4x or more; with less, or when no argument explains the steps, the largest
recorded input is grown instead, one argument at a time, by the generic scaler at 1x, 4x, 16x,
with the cap and the ladder above, and fitted exactly.

A function **grows** (a finding) when its own steps are superlinear, or when a function its calls
spend 5% or more of their steps in at the largest size is: the part that grows fastest is the part
that takes over at sizes no test reached. Superlinear on recorded points means a power of 1.5 or
more, r² of 0.8 or more and a rising work per unit, all with any one call left out (one trivial
call at the smallest size does not make a line steep); on scaled points, quadratic or worse.

ogygia at `57882cc`, with the `scale` of `transformHost: a route page as its island count grows`
removed: its tests and bench cases called `transformHost` 280 times, on sources of 157 to 7,956
characters. The largest come from the bench cases' own inputs (a page of three and of twenty
islands, `heisenbench record`); the tests' sources stop at 1,309 characters.

```
GROWS    packages/core/src/compiler/region/transform.ts > transformHost grows n log n in argument 0 (string length); its steps in acorn@8.18.0/dist/acorn.mjs > Parser grow n^2.52 (cubic) (62% at the largest size), packages/core/src/compiler/region/transform.ts > FileCompilation > #ast_refs_local > walk grow n^2.23 (quadratic) (11% at the largest size); seen in 280 recorded calls, sizes 196..8,096; 9 replayed, sizes 157..7,956
```

On ogygia main (`01dc5b9`, the walk made one pass) the same function grows only through acorn's
`Parser`, a dependency; `#ast_refs_local > walk` is gone from the findings.

`--md` writes only the findings, grouped by the function whose steps grow: one quadratic parser
under twenty entry points is one item. The report section is `recorded_growth`. The planted case
(a quadratic function driven by its second argument, a linear one, and two recorded over too
narrow a range, no `scale` anywhere) is `test/recorded-growth.test.ts`.

Limits: only top-level functions replay (a class method or a closure is seen through its
caller's parts); a sample a test built with state the replay lacks throws and is left out; the
generic scaler cannot grow a source text into a valid larger one, so a compiler's curve comes from
the sizes its tests and bench cases pass it.

## Price audit

Steps are only as good as the prices. Until `80ffd77`, every join (`s += x`, `a + b`, a template
literal) was charged per character of its whole result, so a loop that builds a page cost n²
characters, and three ogygia cases (`esi_rewrite`, `stitch_html`, the region round trip) looked
quadratic while V8 ran them in linear time with cons strings. A person found it by reading code.
`heisenbench audit` finds that kind of price on its own.

For every case with a scaler it takes the steps the growth layer counted at 1x, 10x and 100x,
split by kind (an op kind such as `call`, a dynamic cost such as `dyn.string_char`, a built-in
such as `bi.Array.prototype.sort`), and times the plain build at the same sizes: 5 rounds, each
in a fresh process. Then, per case and per round, it fits time over the sizes with competing
models: the steps as they are; the steps plus a cost per call; the steps with an engine that gets
a little slower per step as the input grows; and, for each kind that grows apart from the rest of
the case, the steps with that one kind's price free (and, for a built-in, with a size term its
price model leaves out). A kind is a **price suspect** when, in every round:

1. the steps miss the time by 15% or more (RMS over the sizes),
2. freeing that kind's price removes 90% of the miss, and at least half of what a per-call cost or
   a slower engine would,
3. of all the kinds that explain the round, it is the one that changes the case's steps the least,
   no other kind explains it nearly as well, and even it needs its price off by more than 4x
   either way.

[calibration.md](calibration.md#the-price-audit) has the method in full. A suspect names the kind,
the curve its steps grow on against the curve time grows on, between the two largest sizes, and
the factor that would make them agree.

With the old join pricing put back (a price file with `"cons_min": null`, through
`HEISENBENCH_PRICES`), on ogygia `01dc5b9`, all 11 bench files (29 cases with a scaler, every
dependency counted), M4 Max, Node 26.4.0, it finds the three cases a person had found by reading
code:

```
SUSPECT  liftRegions + restoreRegions: the round trip around a foreign renderer  steps 1.419, time 1.008 (misfit 0.464; dyn.string_char at 0.0183x)
SUSPECT  esi_rewrite: edge holes into ESI includes  steps 1.973, time 1.014 (misfit 0.761; dyn.string_char at 0.000668x)
SUSPECT  stitch_html: splice fifty rendered holes into the page  steps 1.986, time 1.009 (misfit 0.765; dyn.string_char at 0.000242x)
price suspect: dyn.string_char: steps grow quadratic in stitch_html: splice fifty rendered holes into the page (exponent 2.00), time grows linear (1.01) (and 2 more case(s)); the price likely charges work the engine does not do (time matches at 0.00067x its steps)
```

With the prices in this repository it finds one price, the same in every run, and it is real:

```
SUSPECT  transformHost: a route page as its island count grows  steps 1.907, time 1.698 (misfit 0.427; bi.String.prototype.split at 0.109x)
price suspect: bi.String.prototype.split: steps grow quadratic in transformHost: a route page as its island count grows (exponent 1.99), time grows quadratic (1.70); the price likely charges work the engine does not do (time matches at 0.11x its steps)
```

The split is acorn's (counted since dependencies are counted by default):
`this.input.slice(0, this.lineStart).split(lineBreak).length`, once per expression Svelte parses,
on a prefix of the template that grows with it. `split` is priced per character (366 + 18.5 n),
but what it costs follows the parts it makes. Timed on its own on 40,000 characters of code with a
line break every 23, it took 0.45x its price; on 48,000 characters with a separator every 4, 2.3x.
The audit saw acorn's long lines at 0.1x. A price per part would fix it; that is a calibration
change and is left for one.

The old pricing flags these four cases in both of its runs, and today's prices flag only
`split` in both of theirs (and nothing at all in four earlier runs that counted only devalue,
Svelte and magic-string). 22 cases miss time by less than 15%. Of the other seven, none is a
suspect in any run:

| Case                                     | Steps exponent | Time exponent | Why no suspect                                   |
| ---------------------------------------- | -------------: | ------------: | ------------------------------------------------ |
| `match_path` (300-route table)           |           1.00 |   1.35 – 1.51 | engine: time per step grows with the table       |
| `decode_mappings`                        |           1.00 |   1.17 – 1.25 | engine                                           |
| `page seed: the devalue lane`            |           1.01 |   1.16 – 1.20 | engine, or too little of it is one kind's        |
| `seed refs: ... its own blocks`          |           1.00 |   1.09 – 1.15 | engine, or below the bar                         |
| `signed hop`                             |           1.00 |   0.83 – 0.87 | constant: a fixed cost per call steps do not see |
| `document tail`                          |           0.97 |   0.99 – 1.04 | ambiguous (25 kinds explain it), or engine       |
| `flags: six flags read for 500 visitors` |           1.01 |   0.76 – 1.18 | no single price explains it                      |

A case whose time follows a per-call constant (an `await` that costs microseconds) or grows a
little faster than its steps (a working set that leaves the cache at 100x) is reported as
`constant` or `engine` in the log and the JSON, never as a suspect. The audit checks growth, so a
kind that is mispriced by a constant factor and always grows with the rest of its case cannot be
told apart from it; that is what `heisenbench calibrate prices` measures, one built-in at a time.

The report gets an `audit` section: every case's exponents, misfit and suspect, the findings, and
the points (units and times per size) so several bench files can be judged together. The comment
gets a "Prices" part only when a price is suspect. On `stitch.bench.ts` with the old join pricing
(`run`, `growth` and `audit` into one report, so the lines come from the counted report):

```md
#### Prices

Steps and time disagree on how these prices grow (3 case(s) audited at 1, 10, 100x, 5 rounds each). The counts are exact; the price they use may not be.

- **price suspect: `dyn.string_char`**: it charges work the engine does not do; time matches at 0.000046x its steps
  - `esi_rewrite: edge holes into ESI includes`: its steps grow quadratic (exponent 2.00), the case's time linear (1.00)
  - `stitch_html: splice fifty rendered holes into the page`: its steps grow quadratic (exponent 2.00), the case's time linear (1.01)
  - most of it at `packages/postrender/src/stitch.ts:139`, `packages/postrender/src/stitch.ts:82`, `packages/postrender/src/stitch.ts:79`
```

The whole suite took 480 to 504 s per audit on the M4 Max, counting the three sizes itself; in CI
`growth` has counted them already.

It runs on main and nightly, not on PRs ([ci.md](ci.md#full-runs)).

## Worst-case search

Which input of the same size costs the most steps? `heisenbench search` starts from the case's own input,
changes one place in it at a time, and keeps a change when it costs at least as many steps. A
change is a string edit (repeat a character, special characters, reverse), an array edit
(reverse, sort, shuffle, rotate, make every element the same), a number moved to an edge (0, -1,
NaN, half; never bigger, so a size given as a number cannot grow the work), or extra nesting. It restarts from the worst input found after 40 tries without
progress. It stops at 300 evaluations, 2×10⁸ counted steps or 30 s, whichever comes first; the
first two are deterministic.

The step budget also caps each input: an input that would run past what is left of it is stopped
inside the loop or call that keeps going, not after it. Such a case is reported as a runaway (an
input that does not finish), and the search stops there.

```
ok       rank: twenty rows  worst 897 vs typical 897 steps (1x, 300 inputs, stopped by evals)
```

A PR case is flagged when its worst input costs at least 4 times its typical one and at least
twice the base's ratio. In `heisenbench verify`, the search finds an input that costs 10.64x the typical
steps for `xs.slice().sort()` and 4.61x for `text.split(pat)`, and nothing for a plain summing
loop (1.00x).

Built-ins are priced by input size, so a regular expression that backtracks badly costs no more
steps than one that does not. This search does not find catastrophic regexes.

## Real-app weight

A change of 40 steps per call matters if the function runs 10,000 times per request, and not if
it runs once at startup. `suites/apps/heisenbench` runs the app benchmark's scenarios on a counted build
of ogygia and Svelte: the server counted per request inside the deterministic window, and the
pages counted per load and per interaction in Chromium under virtual time, with frames, timers and
observers on a fixed clock. The page's requests are answered one at a time, in the order it made
them, and the page handles each response before the next one goes out; the harness grants time only
when no request is left. Every phase runs twice and must count the same.

Without the wait between responses, the real clock decided which one the page handled first. On
a CI runner, the shop's `home` step morphed the header's server islands either before or after the
navigation took the focused link off the page, and ogygia's `clear_aria_hidden_over_focus`
counted 104 steps on one run and 92 on the other. With 0 to 8 ms of random delay added to each
response, the harness without the wait found an unstable phase in 3 of 3 shop runs, and the
harness with it found none in 3.

Three runs in a row on this machine: 5 scenarios, 42 phases, every phase the same on both runs of
each, and the same counts in all three. `heisenbench weights` turns that into calls and steps per unit of
real work for 1,065 functions:

```
dashboard server request: 10,672,202 steps per unit
docs page load: 109,268 steps per unit
shop interaction: 57,859 steps per unit
```

`heisenbench diff --weights app-weights.json` ranks the changed functions by what they cost per unit:
the change per call times the calls per unit. Whether a change is shown is decided in one place:

| Path  | When                                              | Shown when                         |
| ----- | ------------------------------------------------- | ---------------------------------- |
| heavy | ≥ 100 calls per unit, or ≥ 1% of the unit's steps | always                             |
| warm  | runs in some unit                                 | impact ≥ 0.01% of the unit's steps |
| cold  | no scenario runs it                               | ≥ 50 steps per call                |

From `heisenbench verify`: a hot function that gained 4 steps per call is shown (14 calls per request), a
cold one that gained 5 steps is suppressed, a cold one that gained 774 steps is shown.

On ogygia, main pushes and the nightly run count every app scenario and store the weights on the
results branch (`heisenbench/main/app-weights.json`). A PR run reads the latest of them and ranks its
changed functions by real-app weight in a short table above the step table. When the weights are
missing or come from another environment, the comment says so in one line and does not rank.
[ci.md](ci.md) has the details.

## Real traffic

The app scenarios are five synthetic apps. A real site calls its functions at other rates, on
other inputs. `heisenbench weights import` turns profiles of production servers into weights of
real traffic, and `heisenbench diff --weights app-weights.json,real-weights.json` then ranks every
finding by what it costs that traffic in CPU time per day:

```bash
heisenbench weights import prod/*.cpuprofile --requests 200 --root . --out real-weights.json
heisenbench diff base.json pr.json --weights app-weights.json,real-weights.json --requests-per-day 1000000
```

### Importing

Three formats, any mix, any number of files:

| Format                  | What it gives                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `.cpuprofile`           | V8's sampled profile (`node --cpu-prof`, the inspector). Self time per function, total time once per stack. Give `--requests`.         |
| ogygia profiler report  | A report dump (`.json`, or `.ogp` opened with `--secret` or `OGYGIA_PROFILER_SECRET`), or the curated report JSON (its hot functions). |
| `heisenbench-traffic/1` | A JSON anyone can write, below.                                                                                                        |

```json
{
	"schema": "heisenbench-traffic/1",
	"requests": 1200,
	"window_ms": 600000,
	"start": "2026-11-01T00:00:00Z",
	"end": "2026-11-01T00:10:00Z",
	"functions": [
		{ "id": "packages/core/src/router/match.ts > match", "self_ms": 120.5, "total_ms": 300, "calls": 4800, "samples": 241 },
		{ "url": "file:///srv/app/build/server/chunks/x.js", "name": "", "line": 1, "col": 4120, "self_ms": 3.2 }
	]
}
```

A function is named by its Heisenbench id, or by a frame (`url`, `name`, `line` 1-based, `col`
0-based) to map here. `calls` are optional (counted calls make a second way to price a change,
below); give `samples` when the times are sampled, so the range can carry their error.

A frame becomes the id a bench gives the function. Its file is read on the importing machine
(`--path-map /srv/app=./app` for a path recorded elsewhere, `--root` for what ids are relative
to). A built file is taken back through its source map (a `sourceMappingURL` comment, inline or a
file, or `<file>.map`) to the file it was built from, read from the map's `sourcesContent` or from
disk. That file goes through the counting transform, and the frame's function is the innermost one
around its position. V8 reports a function at the `(` of its parameters, which a minified map
seldom marks, so the first mapped token at or after it is used. Anonymous functions get their
place (`Cart > cheapest > sort:0`): weights are kept per place, as app weights are. Run the import
against the build the profile ran: a rebuilt chunk maps its positions somewhere else.

Nothing about a request is read or kept: no URL, header, cookie or body. The file holds only
function ids, times, samples, counted calls, the number of requests and the recording window.
The frames that did not map are listed by function name and file, with how much self time they
had and why (`engine`, `node internals`, `no file here`, `not in the source map`).

The weights file is an app weights file (`heisenbench-app-weights/1`) with one unit, `real request`:
per function its self and total ns per request, its samples, and its calls per request when they
were counted. Profiles are summed in the order of their contents' hashes and every number is
rounded the same way, so the same profiles give the same bytes in any order.

### The cost

For each finding, CPU time per day is the extra ns per call × real calls per request × requests
per day. The extra ns per call comes from the steps-to-ns weights on the change's units (or, for
a growth curve, which has no units, steps × the prices' `step_ns`); there is no other conversion.
Requests per day are `--requests-per-day`, or the profiles' requests over their window.

There are two ways to get the calls, and each holds under its own assumption:

| Way      | Cost                                               | Range                                                                                                                              | Assumes                                                              |
| -------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| per call | Δns per call × calls per request                   | the fit's absolute miss on its calibration points: 0.83x to 4.57x (p10–p90)                                                        | the traffic's input costs per call what the bench's does             |
| by time  | real ns per request × Δns ÷ the base's ns per call | the fit's miss on one estimate over another of the same code: 0.80x to 1.25x, times the sampling's 90% interval (± 1.645/√samples) | the change takes the same share of the function's time on real input |

The calls of the per-call way are the profile's (V8 precise coverage, in an ogygia profiler report),
or else the median calls per server request of the app scenarios. The fit's spreads are measured on
the 250 calibration points and kept in `weights.json` (`fit.spread`). With one way, that one. With
both: when their ranges overlap, the narrower; when they do not, the estimate is their geometric
mean, the range spans both, and the comment says how far apart they are.

A growth case whose class changed is priced by its function with the most self steps, at the
bench's own input, by time. A function that grows from recorded calls has no base to compare: the
comment says what it takes on the traffic now, from the measured time alone.

The comment ranks by real cost when real-traffic weights are given, else by app weight, else by
steps per call, and says which. A finding the traffic does not run is ranked after the ones it
does, by its app weight.

### On ogygia

ogygia `01dc5b9`, `apps/palaestra` built with source maps and served by `vite preview`, the server
profiled with the inspector (500 µs sampling) over 200 requests after a warm-up: 50 each to
`/heavy`, `/nest-matrix`, `/snippet-islands` and `/shapes`.

```
263 functions from 1 profile(s), 200 requests over 9400 ms -> real-weights.json
95.8% of sampled self time mapped to counted functions (5373.7 of 5609.7 ms); top unmatched: (garbage collector) (native):0 (90.0 ms, engine), runMicrotasks (native):0 (15.9 ms, no file), encodeUtf8String (native):0 (11.0 ms, no file)
```

The import took 1.1 s. Two regressions were planted on a branch: `locate` (once per document)
lowercases the whole document to find `</head>` and `</body>`, and the compiler's `strip_bom` makes
a line-by-line pass over every source. Counted with `markup.bench.ts` and `compiler.bench.ts`:
`strip_bom` +315.8K steps per call, `locate` +137.3K. By steps, `strip_bom` is first. With main's
app weights and the real traffic, at 1M requests per day:

| Function                                                 | Δ per call    | Real cost                                                                                                                                      |
| -------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/server/document-assembly.ts > locate` | +137.3K steps | 1 call/request (app scenarios) or 201 µs/request of real time × 37: 1756x apart → ≈ 3 CPU-minutes/day (range 3.6 CPU-seconds to 3.2 CPU-hours) |
| `packages/core/src/compiler/bom.ts > strip_bom`          | +315.8K steps | not in the imported traffic                                                                                                                    |

The planted build, served and profiled the same way, measured `locate` at 376.0 µs per request
(115 samples) against 201.2 µs (64 samples): +175 µs per request, 2.9 CPU-minutes a day at 1M
requests. The two ways disagree because the bench's document is small and `locate` was O(1)
(`indexOf` near the front, `lastIndexOf` near the back) while the planted pass is O(n). Per call
assumes the traffic's documents are the bench's size (4.3 µs, 40 times too low); by time assumes
the change grows like `locate`'s own time, which on the traffic is mostly V8 flattening the
document string (7.5 ms, 43 times too high). With the real traffic alone (no app weights), only the
by-time way is there and its range does not hold the measured cost. That is the limit: a real cost
is as good as the bench's input is like the traffic's, and a second way is what shows when it is not.

The same profile imported twice, and again after rebuilding the base, gave the same file
(sha256 `245a1915…`), and the same diff gave the same ranking. The unit tests
(`test/real-weights.test.ts`) plant a profile with a known split of self time, a minified bundle
with a source map whose positions V8 reported, anonymous callbacks and a constructor, ogygia
profiler dumps plain and encrypted, and the cost of both ways.

## Coverage of the app scenarios

`heisenbench coverage` lists every function of the installed ogygia packages and whether a counted
scenario reached it. From the run above (ogygia 0.12.3, as installed in the app benchmark):

| Package           | Functions | Reached | Reached % | % of loaded modules | Loaded, not run | Not loaded |
| ----------------- | --------: | ------: | --------: | ------------------: | --------------: | ---------: |
| `@ogygia/content` |      1505 |       0 |    **0%** |                  0% |               0 |       1505 |
| `@ogygia/core`    |      3434 |     619 |   **18%** |               41.8% |             862 |       1953 |
| `ogygia`          |         2 |       0 |    **0%** |                  0% |               0 |          2 |
| all               |      4941 |     619 | **12.5%** |               41.8% |             862 |       3460 |

The modules no scenario loaded are led by insights (`page-insights.js`, 337 functions), the
beacon, and the compiler and Vite plugin, which run at build time. No scenario uses
`@ogygia/content` yet.

The function list comes from every package installed in any of the `--app` directories
(`--app a,b,c`), so give it every scenario app: a package only the blog app installs, like
`@ogygia/content`, is still listed, as not loaded when no scenario ran it.

## The measurement-source gate

Every function should have something that measures it. A function is **measured** when a bench
case ran it, or when ogygia's unit tests ran it with the input recorder on and its recorded inputs
replay to the same output (then those inputs are a measurement source of their own).

The recorder is a Vite plugin (`src/coverage/plugin.ts`) wired into the test runner's config. For each function no bench reached, it records arguments and `this` (cloned at
entry) and the result. `heisenbench replay` calls each function again with a copy of each sample:

| Result         | Meaning                                                               |
| -------------- | --------------------------------------------------------------------- |
| reproduced     | every sample gave the same output: the inputs explain the output      |
| hidden state   | some output differs: the function reads state its inputs do not carry |
| not cloneable  | inputs or output cannot be structured-cloned                          |
| not replayable | no handle to call it again (a nested closure, a class method)         |
| not recorded   | async, a generator, or an arrow with destructured parameters          |
| never ran      | nothing called it                                                     |

`heisenbench unmeasured` fails only on **new** functions with no source: functions the PR's tree has and
the base's does not. Functions unmeasured before are listed, not failed, so the gate can be
turned on for a codebase that is far from covered. An exemption names a function and a reason:

```json
{ "exempt": [{ "id": "src/rank.ts > total", "reason": "a one-line sum over rank" }] }
```

An exemption covers that function and every function nested in it: the closure inside it
(`src/rank.ts > total > reduce:0~3fa9c2`) is exempt with it. `"nested": false` exempts the function
alone. An exemption may also name a place without the shape hash (`src/rank.ts > total > reduce:0`):
it covers every callback there, through edits to their code
([how-counting-works.md](how-counting-works.md#identity)).

A function whose own code changed has a new shape hash in the same place. The gate counts it as
old: in each place, every base function the PR no longer has stands for one PR function there the
base did not have. A callback added before an old one does not rename the old one, so only the
added one is new.

A file the PR moved keeps its functions' history when the gate gets the git range
(`--repo dir --base sha --head sha`): its unmeasured functions stay old, not new. A new file the
transform cannot read fails the gate, since its functions are unknown.

On ogygia PR #180 (CI run 42288359583): 1,524 of 8,234 functions (18.5%) had a measurement
source, 555 through a bench and 969 through recorded test inputs. Of the rest, 2,822 never ran,
2,563 were not replayable, 676 not recorded, 523 not cloneable and 126 had hidden state. No new
function was unmeasured, so the gate passed. [ci.md](ci.md#the-gate-on-ogygia) shows how ogygia
runs it.
