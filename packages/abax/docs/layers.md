# Layers

Steps are a model of the work the code asks for. Each layer here checks something the model
cannot see, or turns the count into an answer to a different question. Engine health, time, real
bytes and leaks run on the **plain build**: the code as it ships, nothing counted. The plain build
still compiles `.svelte` files and appends the `__abax` export, so the same bench files run on it.

| Layer             | Command                                | Build    | On PRs                                     | On main and nightly  |
| ----------------- | -------------------------------------- | -------- | ------------------------------------------ | -------------------- |
| Steps             | `abax run`                             | counting | yes                                        | yes                  |
| Engine health     | `abax health`                          | plain    | yes                                        | yes                  |
| Growth            | `abax growth`                          | counting | cases with `scale`                         | cases with `scale`   |
| Time              | `abax time`, `abax run --measure time` | plain    | yes                                        | yes                  |
| Real bytes        | `abax run --measure bytes`             | plain    | no                                         | yes                  |
| Leaks             | `abax run --measure leaks`             | plain    | no                                         | yes                  |
| Worst-case search | `abax search`                          | counting | changed cases with a `setup`, 4 min budget | no                   |
| Real-app weight   | `abax weights`, `abax diff --weights`  | counting | ranks the changes                          | produces the weights |
| Coverage          | `abax coverage`                        | counting | no                                         | no                   |
| Gate              | `abax unmeasured`                      | counting | in ogygia's CI                             | no                   |

The examples on this page come from runs on an M4 Max with Node 26.4.0 at Abax `7b3d7a5`: the
quick-start project in the [README](../README.md), the planted cases of `abax verify`, the planted
router PR, and the app benchmark's scenarios.

## Engine health

What V8 did with the code. `abax health` runs each case in a child process without counting, with
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

`abax verify` plants a shape-order change, an int to double change, a `delete`, and a
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

`abax time` compares two trees. Both are loaded in one process and take turns case by case, and
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

`abax run --measure time` times one tree and puts p50 next to the steps in the report.

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
charged to the function that called `map`. A byte allocated in a dependency, the bench file or the
harness is charged to none of them: a dependency is not counted, so its allocations are not in the
estimate either.

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

That is the `abax verify` case: `const w = { len: t.length }` inside the loop of `score`. Per
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

The two planted leaks in `abax verify` keep every row: one in a module-level array, one in a
closure cache keyed by the row object.

```md
**Leaks** (retained heap grows with every call):

- `rank: twenty rows`: 3406.76 B per call, 40 (string) per call held by `seen` (`lib.ts:14`, kept growing by `rank`)
- `rank: twenty rows`: 3888.2 B per call, 40 (string) per call held by `cache` (`lib.ts:15`, kept growing by `memo > <anonymous>`)
```

Their twins (only the last row kept; the cache keyed by row id, twenty entries whatever the
calls) are not flagged. On ogygia main, two full runs of all 57 cases flag none.

## Growth

How steps grow with the input. `abax growth` counts each case at 1x, 10x and 100x its input
(`--sizes`) and fits `steps = a + b × f(k)` for constant, log, linear, n log n and quadratic,
picking the best fit and the simpler class on a tie. Counts are exact, so three sizes are enough.

```
ok       rank: twenty rows  linear (exponent 0.999; 897 / 8817 / 88017 steps)
```

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
steps is not: the step table already shows that. CI grows only the cases that declare `scale`
(`--scaled on`).

## Worst-case search

Which input of the same size costs the most steps? `abax search` starts from the case's own input,
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
twice the base's ratio. In `abax verify`, the search finds an input that costs 10.64x the typical
steps for `xs.slice().sort()` and 4.61x for `text.split(pat)`, and nothing for a plain summing
loop (1.00x).

Built-ins are priced by input size, so a regular expression that backtracks badly costs no more
steps than one that does not. This search does not find catastrophic regexes.

## Real-app weight

A change of 40 steps per call matters if the function runs 10,000 times per request, and not if
it runs once at startup. `suites/apps/abax` runs the app benchmark's scenarios on a counted build
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
each, and the same counts in all three. `abax weights` turns that into calls and steps per unit of
real work for 1,065 functions:

```
dashboard server request: 10,672,202 steps per unit
docs page load: 109,268 steps per unit
shop interaction: 57,859 steps per unit
```

`abax diff --weights app-weights.json` ranks the changed functions by what they cost per unit:
the change per call times the calls per unit. Whether a change is shown is decided in one place:

| Path  | When                                              | Shown when                         |
| ----- | ------------------------------------------------- | ---------------------------------- |
| heavy | ≥ 100 calls per unit, or ≥ 1% of the unit's steps | always                             |
| warm  | runs in some unit                                 | impact ≥ 0.01% of the unit's steps |
| cold  | no scenario runs it                               | ≥ 50 steps per call                |

From `abax verify`: a hot function that gained 4 steps per call is shown (14 calls per request), a
cold one that gained 5 steps is suppressed, a cold one that gained 774 steps is shown.

On ogygia, main pushes and the nightly run count every app scenario and store the weights on the
results branch (`abax/main/app-weights.json`). A PR run reads the latest of them and ranks its
changed functions by real-app weight in a short table above the step table. When the weights are
missing or come from another environment, the comment says so in one line and does not rank.
[ci.md](ci.md) has the details.

## Coverage of the app scenarios

`abax coverage` lists every function of the installed ogygia packages and whether a counted
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
entry) and the result. `abax replay` calls each function again with a copy of each sample:

| Result         | Meaning                                                               |
| -------------- | --------------------------------------------------------------------- |
| reproduced     | every sample gave the same output: the inputs explain the output      |
| hidden state   | some output differs: the function reads state its inputs do not carry |
| not cloneable  | inputs or output cannot be structured-cloned                          |
| not replayable | no handle to call it again (a nested closure, a class method)         |
| not recorded   | async, a generator, or an arrow with destructured parameters          |
| never ran      | nothing called it                                                     |

`abax unmeasured` fails only on **new** functions with no source: functions the PR's tree has and
the base's does not. Functions unmeasured before are listed, not failed, so the gate can be
turned on for a codebase that is far from covered. An exemption names a function and a reason:

```json
{ "exempt": [{ "id": "src/rank.ts > total", "reason": "a one-line sum over rank" }] }
```

An exemption covers that function and every function nested in it: the closure inside it
(`src/rank.ts > total > reduce:0`) is exempt with it. `"nested": false` exempts the function
alone.

A file the PR moved keeps its functions' history when the gate gets the git range
(`--repo dir --base sha --head sha`): its unmeasured functions stay old, not new. A new file the
transform cannot read fails the gate, since its functions are unknown.

On ogygia PR #180 (CI run 42288359583): 1,524 of 8,234 functions (18.5%) had a measurement
source, 555 through a bench and 969 through recorded test inputs. Of the rest, 2,822 never ran,
2,563 were not replayable, 676 not recorded, 523 not cloneable and 126 had hidden state. No new
function was unmeasured, so the gate passed. [ci.md](ci.md#the-gate-on-ogygia) shows how ogygia
runs it.
