# Heisenbench

Heisenbench is a benchmark engine for JavaScript and TypeScript functions. It counts the work each
function does, line by line, and the count is the same on every run, so one run of a PR and one
run of its base are enough to tell which line got slower.

The name is a nod to Heisenberg and the Heisenbug: a benchmark with no uncertainty.

Heisenbench was built for [ogygia](https://github.com/ogygiajs/ogygia) and runs on every ogygia PR. It
lives in this repository as `packages/heisenbench` and is on npm as `heisenbench`.

```bash
npm i -D heisenbench
```

It needs Node 26.4 or newer.

## The problem

Timings are noisy. On the same laptop, in one process, with nothing changed between turns, the
`match_path` case of ogygia's router took between 1.13 ms and 1.21 ms at the median over five
turns: a 7% spread. A change that costs 1% cannot be seen through that.

CI runners are worse. ogygia PR #180 changed CI files and no code that a bench reaches. On both of
its last two pushes, Heisenbench counted every function the same on both sides. The time table in the
same comment called one case slower and three faster on the first push, and two other cases slower
and one other faster on the second. It judges by the rule the app benchmark uses: a case changed
only when every PR timing is on the same side of every base timing (no overlap), and by more than
a floor.

And when a timing does move, it says which benchmark moved, not which line.

## The idea

Count instead of time. A bench-only build rewrites every function so it counts itself: each basic
block (a stretch of code with no branch in or out, so it always runs whole) adds its count and its
price (calls, property reads, comparisons, allocations) to a counter.
Built-ins like `sort`, `split` or `JSON.parse` are priced by the size of their input. The clock,
randomness, timers and IO are made deterministic inside the measuring window. The result is
**steps**: an exact number per function and per line, the same on every run of the same code
with the same input.

Counting cannot see everything the engine does, so Heisenbench adds layers that run the plain build (the
code as it ships, nothing counted) next to the count:

| Layer             | What it answers                                                                 |
| ----------------- | ------------------------------------------------------------------------------- |
| Steps             | How much work each function and line does. Exact.                               |
| Engine health     | Did V8 stop optimizing a function, drop its optimized code, or see more shapes? |
| Time              | How long it takes on the plain build, PR and base taking turns in one process.  |
| Real bytes        | What V8 really allocates per function, next to the count's estimate.            |
| Leaks             | Does the heap keep growing as the case runs again and again, and who holds it?  |
| Growth            | Is the case constant, linear, n log n or quadratic in its input size?           |
| Worst-case search | Which input of the same size costs the most steps?                              |
| Real-app weight   | How often the real apps call this function, so a change can be ranked by cost.  |

[docs/layers.md](docs/layers.md) explains each one.

## An example

Three lines planted in `match_one`, which ogygia's router calls for each route until one matches
the request. The new lines run only when the route's pattern matches (ogygia `c983461` plus one
commit, counted with Heisenbench at `7b3d7a5`):

```ts
let weight = 0;
for (let i = 0; i < c.pattern.length; i++) weight += c.pattern.charCodeAt(i);
if (weight < 0) return null;
```

Heisenbench ran the 2 of 11 bench files that import `packages/router/src/match.ts` and reported:

| Case                                                  | Function                                   |                  Self steps |                             Δ |
| ----------------------------------------------------- | ------------------------------------------ | --------------------------: | ----------------------------: |
| match_path: every request against a 300-route table   | `packages/router/src/match.ts > match_one` | 4,653,739.13 → 4,710,331.13 | +56,592 (+1.2%) ≈ +4,465.4 ns |
| routes().fetch: forty requests across a 100-route API | `packages/router/src/match.ts > match_one` |     187,368.69 → 197,568.69 |   +10,200 (+5.4%) ≈ +803.9 ns |

The "Where" table under it put 55,962 of the 56,592 steps on `packages/router/src/match.ts:140`,
the loop line, and marked the three lines as new code. Engine health added that the two new
property reads on line 140 (`charCodeAt`, `length`) are polymorphic.

The time layer measured the same two trees in the same job and said `≈` (within noise) for both
cases. At the median, `match_path` took between 1.13 and 1.21 ms on the base and between 1.11 and
1.18 ms on the PR. The whole case grew by 1.1% in steps, well inside the 7% the timings moved by
on their own.

The full comment is in [docs/sample-comment.md](docs/sample-comment.md).

## Quick start

You need Node 26.4 or newer. CI runs the tests on Node 26.4.0 and on the newest 26, and counts on
the newest 26. Node 22 does not work: on 22.18, 6 of the 166 tests fail (`using` declarations,
which its V8 does not parse, and engine health).

In a new project:

```bash
npm init -y
npm i -D heisenbench typescript@6
```

TypeScript is optional. `heisenbench dts` needs it, and so does TypeScript that type stripping cannot
run (`enum`, `namespace`, parameter properties). It must be TypeScript 5 or 6: TypeScript 7 is the
native compiler and has no JavaScript API. The other optional peers are `svelte` (for `.svelte`
files) and `playwright` (for the app layer). Heisenbench says which one is missing when a command needs it.

A function to measure, `src/rank.ts`:

```ts
export interface Row {
	id: number;
	tags: string[];
}

function score(row: Row): number {
	let s = 0;
	for (const t of row.tags) {
		s += t.length;
	}
	return s;
}

export function rank(rows: Row[]): number[] {
	const out: number[] = [];
	for (const r of rows) {
		out.push(score(r));
	}
	return out;
}
```

A bench file, `bench/rank.bench.ts`. `setup` builds the input outside the measuring window:

```ts
import { bench } from 'heisenbench/bench';
import { rank } from '../src/rank.ts';

bench('rank: twenty rows', ({ rows }) => rank(rows), {
	setup: () => ({
		rows: Array.from({ length: 20 }, (_, i) => ({ id: i, tags: ['a' + i, 'bb', 'c' + i] }))
	})
});
```

Commit it (a report records the commit it was counted at), and count it:

```bash
git init && echo node_modules > .gitignore
git add . && git commit -m base
npx heisenbench run bench/rank.bench.ts --out base.json
```

```
ok       rank: twenty rows  897 steps
```

Now change the code, here a second loop inside `score`, after the first one:

```ts
for (let i = 0; i < row.tags.length; i++) {
	s += 0;
}
```

Commit, and count again:

```bash
git commit -am pr
npx heisenbench run bench/rank.bench.ts --out pr.json
npx heisenbench diff base.json pr.json --repo .
```

```md
<!-- heisenbench:section -->
### Heisenbench: steps per function

**1** function changed in 1 case(s). Steps are exact counts, not timings.

| Case | Function | Self steps | Δ | Δ allocs | Δ bytes | Δ inclusive |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| rank: twenty rows | `src/rank.ts > score` | 620 → 1,140 | +520 (+83.9%) ≈ +21 ns | 0 | 0 | +520 |

<details><summary>Where</summary>

| Case | | Line | Δ steps | Δ allocs | Δ bytes |
| --- | --- | --- | ---: | ---: | ---: |
| rank: twenty rows | new code | `src/rank.ts:11` | +400 | 0 | 0 |
| rank: twenty rows | new code | `src/rank.ts:12` | +120 | 0 | 0 |

</details>
```

`--repo .` lets the diff read `git diff` between the two reports' commits, so unchanged lines are
matched even when they moved, and changed lines are marked "new code". Without it, lines are
compared by number.

## Bench files

```ts
bench<T>(name: string, fn: (ctx: T) => unknown, options?: {
	setup?: () => T | Promise<T>;     // outside the window, before every run
	teardown?: (ctx: T) => unknown;   // outside the window, after every run
	scale?: (ctx: T, factor: number) => T; // for `heisenbench growth`, when the generic scaler cannot grow ctx
});
```

`fn` may be async. Each case runs three times: once to warm up and record IO, then twice measured.
The two measured counts must match exactly or the case is reported unstable.

### Private functions

The counting build appends one line to every module:

```ts
export const __heisenbench = { score };
```

with every top-level binding the module does not export. A bench file imports private functions
from it:

```ts
import { bench } from 'heisenbench/bench';
import { __heisenbench } from '../src/rank.ts';

bench('score: one row with three tags', ({ row }) => __heisenbench.score(row), {
	setup: () => ({ row: { id: 1, tags: ['a1', 'bb', 'c1'] } })
});
```

TypeScript does not know about `__heisenbench`. `heisenbench dts` writes the types, from the TS checker:

```bash
npx heisenbench dts src/rank.ts --out bench/__heisenbench.d.ts
```

```ts
// Generated by heisenbench: types of the `__heisenbench` export (private bindings) of each module.
export {};

declare module '../src/rank.ts' {
	namespace __heisenbench_private {
		export function score(row: Row): number;
	}
	export const __heisenbench: {
		score: typeof __heisenbench_private.score;
	};
}
```

With that file in the project, `tsc` checks the bench file like any other. ogygia regenerates it
before every run and keeps it out of git. Class `#private` methods are measured through their
public callers.

### What a bench file can load

- TypeScript. Types are stripped, as Node does it. A module that stripping cannot run (`enum`,
  `namespace`, parameter properties) is compiled with the project's TypeScript, and its lines map
  back through the compiler's source map.
- A bench file that throws, does not parse or defines no cases is reported on its own; the other
  files still run.
- `.svelte` components and `.svelte.ts` modules, compiled with the project's own Svelte (server
  output). Lines map back to the `.svelte` source.
- Dependencies are counted like your own code, and reported under their package name and
  version: `acorn@8.18.0/dist/acorn.mjs > Parser`. Work a dependency does for your code is your
  code's work: ogygia's compiler case read 33 times less work after a fix while its wall time
  dropped 1.9 times, because Svelte's template parser, which calls acorn once per expression
  with the whole file, was not counted. Counted, the case grown to 100 times its input is 78%
  acorn (see [growth](docs/layers.md#growth)). `--deps none` counts
  your code alone, `--deps devalue,svelte` only those packages. CommonJS dependencies run as
  they are (the transform is for ES modules), and Node's built-in modules are never counted:
  the built-ins they reach are priced where counted code calls them.

## CLI

`heisenbench --help` prints every command with its flags. Each command reads bench files or reports and
writes JSON; `diff` and a few others also write markdown.

| Command                                                                                | What it does                                                                                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `heisenbench run <bench files>`                                                        | Count every case. `--measure time,bytes,leaks` (or `all`) adds the plain-build layers to the same report.          |
| `heisenbench diff <base.json> <pr.json>`                                               | The markdown section: changed functions, lines, engine and growth changes. `--time`, `--weights` add their tables. |
| `heisenbench dts <source files> --out <file>`                                          | Types for `__heisenbench`.                                                                                         |
| `heisenbench health <bench files>`                                                     | Engine health section: tiers, deopts, inline-cache states.                                                         |
| `heisenbench growth <bench files>`                                                     | Steps at 1x, 10x, 100x the input and the fitted curve class.                                                       |
| `heisenbench search <bench files>`                                                     | Mutates the input and keeps what costs more steps; reports the worst input found.                                  |
| `heisenbench time <bench files> --base <dir> --pr <dir>`                               | Times both trees in one process, in turns, and judges them by the no-overlap rule.                                 |
| `heisenbench weights <app reports>` / `heisenbench coverage <app reports> --app <dir>` | Real-app weights per function; which functions the app scenarios reached.                                          |
| `heisenbench inventory`, `heisenbench replay`, `heisenbench unmeasured`                | The measurement-source gate: every function, what measures it, and a failure for new ones that nothing measures.   |
| `heisenbench calibrate prices\|points\|agree\|weights`                                 | Fit built-in prices and step-to-time weights on a quiet machine, and check that two calibrations agree.            |
| `heisenbench verify`                                                                   | Run every planted case of every layer and check Heisenbench flags exactly the planted ones.                        |

`health`, `growth` and `search` write their section into the report given by `--out`, so one JSON
file per commit holds everything `diff` needs.

`calibrate` and `verify` run only in a clone of this repository. The npm package does not ship
the calibration corpus or the planted cases, and from npm both commands say so and stop.

Exit codes: 0 when everything ran, 1 when a case, a bench file or a layer failed (the report
says which), 2 when the command line is wrong. Errors are one line; `--debug` adds the stack.
Ctrl-C stops the run and every process it started.

## The PR comment

Every ogygia PR gets one benchmark comment, found by `<!-- ogygia-benchmarks -->`. Heisenbench owns the
`heisenbench` section and the app benchmark owns `apps`. Each rewrites only its own section, so Heisenbench can
post first (it counts from source and needs no published preview) and the app benchmark fills its
part when it finishes.

For a PR, Heisenbench checks out the PR commit and the commit it branched from, finds the bench files
whose import graph reaches a changed file, and on both trees counts them, checks engine health and
grows the cases that declare a scaler. Then it times both trees in one process. A push to ogygia's
main and a nightly run count every bench file with every layer. Results go to the `results` branch
of this repository under `heisenbench/`. [docs/ci.md](docs/ci.md) has the details, and
[docs/sample-comment.md](docs/sample-comment.md) is a real comment.

The step table shows any change, down to one step: counts do not need a noise floor. The time table
uses one.

## Reading the numbers

**A step** is one simple operation: a property read, a comparison, an assignment, an arithmetic
op. A call costs 4, `new` 6, an `await` 20. A block's price is the sum of its operations. In `score`
above, the block before the loop costs 10 (an assignment, a property read and starting a `for..of`
at 8) and the loop body costs 7. Twenty rows of three tags: 20 × 10 + 60 × 7 = 620 steps.

**Built-ins** are priced by the size they work on, from a calibration on one machine.
`Map.prototype.get` is 24.5 steps; `Array.prototype.sort` is 66 n log n. Prices are binary
fractions, so a count can have a fraction: the `.13` in the example above is `.125`, rounded for
display. Counts are still exact.

**The ns next to a Δ** (`≈ +21 ns`) is an estimate: the change in each kind of operation times its
fitted cost in ns. It is not a measurement. Only the time layer measures.

**The same code with the same input always counts the same.** Inside the measuring window:

- `Date`, `performance.now` and `process.hrtime` read a clock that starts at 2024-01-01 and moves
  1 ms per read.
- `Math.random` and `crypto` randomness come from one seeded generator.
- Timers run on a fake loop, in due-time order.
- File reads and `fetch` are recorded in the warm-up run and replayed. Anything else that touches
  the network or writes a file throws.
- Every run gets fresh module state, so a cache filled by one run does not make the next one fast.
- `process.cwd()` is `/heisenbench/root` (the run root), so code that slices or compares the working
  directory counts the same in every checkout. Files under it still read.

**What changes the count:**

- The code that runs, and how often each block runs.
- The sizes passed to priced built-ins.
- The price file. A report records the price version it was counted with. When two reports differ,
  `heisenbench diff` recounts both with the current prices from the units each report keeps, and compares
  those.

**What does not:** the machine, the Node version, the checkout path (a dependency is named
`name@version` wherever it is installed), and code Heisenbench does not count. A priced built-in
is charged only when counted code calls it directly. Built-ins that Node's own JavaScript (or a
dependency left out with `--deps`) calls are free, whatever counted code called into them.
ogygia `86e537b` counted in two checkouts at different depths, and under Node 26.4.0 and
26.13.0: all 57 cases and 934 functions gave the same steps.

A report records Node, V8, the platform and the weights it was counted with. `heisenbench diff` says so
at the top when two reports differ in any of them, and leaves engine health out: what V8 does is
only comparable on one V8.

## Limits

- **Steps are not time.** In the quick start, the second loop added 58% to the case's steps. The
  time layer measured between 83 and 84 ns before and 84 ns after: `≈`. The engine made that loop nearly free.
  Steps say what the code asks for; how cheap the engine makes it is the time layer's job.
- **Engine effects only the time layer sees.** ogygia commit `a99a49a` replaced a `console.warn`
  on a path that never runs. Steps did not change and engine health was the same on both trees,
  yet the case it touches got 11% slower at the median, likely from the new module graph. Heisenbench's
  step layer cannot see this.
- **Built-in prices are curves fitted on one machine** (an M4 Max, Node 26.4). On ogygia commit
  `a217b913` they overstated new `replace`, `JSON` and regex work: +134% steps against +69% time.
  The seed prices understated the same change (+31%).
- **Built-ins without a price cost one call.** `Array.prototype.push` is 4 steps whatever it does.
- **Regular expressions are priced by input length.** A pattern that backtracks badly costs no more
  steps than one that does not, and the worst-case search does not find it.
- **The byte estimate misses what grows in place.** It covers allocations written in counted code
  and what priced built-ins return (`split`, `slice`, `map`, `JSON.parse`). The backing store
  that `push` grows is not in it. In the quick start, `rank` is estimated at 16 B and V8 allocates
  907.66 B, most of it the `out` array growing.
- **Real bytes are per function, not per line.**
- **Built-ins called in ways the transform cannot see are free.** A priced built-in costs steps
  when counted code calls it by name (`xs.slice(1)`, `structuredClone(v)`, `Array.prototype.map.call(xs, f)`).
  Through a computed name (`xs['slice']()`) or a variable holding the function
  (`const s = String.prototype.slice; s.call(x)`), it costs one call.
- **Paths a module builds from `import.meta.url` are real paths.** Only the working directory is
  virtual. A function that slices a path made from `import.meta.url` still counts more in a deeper
  checkout.
- **Engine health repeats what V8 repeats.** On ogygia's 57 cases, three rounds of `heisenbench health`
  gave the same report every time. A function or inline cache that differs between runs is marked
  unstable and never becomes a finding; the comment says how many were skipped. That is not proof
  against a PR that only moves allocation: young collections then land at other points, and a
  string method's inline cache can see another string shape. A case that allocates past 1 GB of
  old space also gets a full collection, at a point its own allocation sets.
- **Coverage is low today.** ogygia's gate on PR #180: 1,524 of 8,234 functions (18.5%) have a
  measurement source, 555 through a bench and 969 through unit-test inputs that replay. The counted
  app scenarios reach 619 of `@ogygia/core`'s 3,434 functions (18%).
- **Not every layer runs on PRs.** PRs get steps, engine health, growth and time. Real bytes and
  leaks run on main and nightly. The worst-case search runs on a PR only for changed cases that
  declare a `setup`, within a 4 minute budget.

## How it compares

- **tinybench, mitata** time a function many times and report statistics. They are what Heisenbench's
  time layer uses (tinybench) and the right tool for "how fast is this". They inherit the
  machine's noise and do not say which line moved.
- **CodSpeed** runs benchmarks in CI under CPU simulation (Valgrind) or on quiet machines, and
  reports per benchmark. For JavaScript, instruction counting includes the engine: the JIT, the GC
  and the interpreter all count, and they move when the code does not.
- **Valgrind's Cachegrind, `perf stat` instruction counts** are the practice of
  [rustc-perf](https://github.com/rust-lang/rustc-perf) (instructions as the main metric for the
  Rust compiler) and of SQLite (performance work measured in Cachegrind cycles). That works well for
  compiled code, where instructions map to source. For JS they count V8's work, not the script's.
- **Heisenbench** counts at the source level instead: blocks and built-in calls of your code, so the count
  maps to a line and does not move when V8 changes its mind. The cost is that it is a model. The
  layers above exist because the model misses things.

## Proof

### `heisenbench verify`

Planted cases for every layer: slowdowns that must be flagged at the line they were planted on,
and no-ops (renames, comments, reordering, formatting, same-line twins) that must stay quiet.
CI runs it on every pull request and every push to main of this repository. Output on an M4 Max,
Node 26.4.0:

```
Heisenbench verify: 34 of 34 planted cases pass
pass  steps/comments             no-op    nothing flagged
pass  steps/extra-allocation     planted  flagged lines 17 (+240 steps)
pass  steps/extra-loop           planted  flagged lines 11,12 (+520 steps)
pass  steps/formatting           no-op    nothing flagged
pass  steps/quadratic-helper     planted  flagged lines 6,20 (+1720 steps)
pass  steps/rename               no-op    nothing flagged
pass  steps/reorder              no-op    nothing flagged
pass  elision/elided-allocation  planted  elided at lines 9 (est 960 B, real 4 B)
pass  leak/leak                  planted  leak of `seen` at lib.ts:14
pass  leak/leak-closure          planted  leak of `cache` at lib.ts:15
pass  leak/leak-closure-twin     no-op    no leak
pass  leak/leak-twin             no-op    no leak
pass  engine/comments            no-op    nothing flagged
pass  engine/delete              planted  deopt in make_items:7, deopt in total:15, inline cache in total:18
pass  engine/delete-twin         no-op    nothing flagged
pass  engine/int-double          planted  deopt in make_items:7, deopt in total:15
pass  engine/int-double-twin     no-op    nothing flagged
pass  engine/megamorphic         planted  inline cache in label_len:34
pass  engine/megamorphic-twin    no-op    nothing flagged
pass  engine/rename              no-op    nothing flagged
pass  engine/shape-order         planted  deopt in total:18, inline cache in total:18
pass  engine/shape-order-twin    no-op    nothing flagged
pass  growth/constant-factor     no-op    no class change
pass  growth/quadratic           planted  rank: linear -> quadratic
pass  search/order               planted  worst/typical 10.64, flagged
pass  search/count               planted  worst/typical 4.61, flagged
pass  search/total               no-op    worst/typical 1.00, not flagged
pass  app/cold-large             planted  configure: cold, shown (+774 steps/call)
pass  app/cold-small             planted  configure: cold, suppressed (+5 steps/call)
pass  app/hot-noop               no-op    nothing ranked
pass  app/hot-small              planted  render_part: heavy, shown (+4 steps/call, 14 calls/request)
pass  time/comments              no-op    work same (p50 0%, steps =), steady same (p50 0%, steps =)
pass  time/faster                planted  work faster (p50 -76%, steps down), steady same (p50 0%, steps =)
pass  time/slowdown              planted  work slower (p50 +305%, steps up), steady same (p50 0%, steps =)
```

The planted cases are in `test/*-key/`. Each is a base file and a changed copy with an
`expect.json` that names the planted lines.

### The real-world check

Do step changes track time changes on real commits? 29 commits of ogygia's main since
2026-11-01, each against its parent; 18 of them reached a bench file, for 190 case measurements.
Steps counted on both trees; time measured on the plain build, both trees taking turns, 8 rounds,
judged by the PR comment's rule.

|                        | Time significant | Time same |
| ---------------------- | ---------------: | --------: |
| **Steps changed ≥ 3%** |                2 |         0 |
| **Steps changed < 3%** |                1 |       187 |

When steps moved by 3% or more, time moved the same way (2 of 2). Steps raised no false alarm. The
one time change steps missed is the `a99a49a` engine effect above. The history is short: only 3
rows changed enough to matter. [calibration/results.md](calibration/results.md) has every row and
how the machine was checked for quiet first.

### The fuzzer

In a clone of this repository, `pnpm --filter heisenbench fuzz -- --seed N --runs M --time T` generates programs from a seed and
checks the counting build against things it does not control:

- **Semantics.** The counted program logs the same values, in the same order, and returns or
  throws the same as the plain one.
- **Counts.** Every block's count and every function's calls equal V8's own precise coverage of
  the same code; every allocation site's count equals V8's count at the allocation.
- **Call graph.** Every caller to callee edge equals one read from V8 stack traces.
- **Determinism.** A second count on fresh module state, and a count in another process, give the
  same report.
- **Diff.** Rewrites that change nothing (comments, renames, reordering, indentation) report
  nothing; a planted cost is reported on its line with the right delta.
- **Source maps.** Lines map back through the TypeScript transpiler and the Svelte compiler.
- **Robustness.** The transform takes every file of a corpus (ogygia and its dependencies); huge
  counts, deep recursion and loops that never end are handled.

A failing program is cut down to the smallest one that still fails. CI runs 60 programs on fixed
seeds for every PR of this repository, and a nightly job runs for longer on new seeds. One local
run: 160,000 programs, 392,728 executions, 18,070,739 block counts and 6,085,991 allocation sites
compared with V8, 3,997 reports compared across processes, all 61 syntax node types the transform
handles, and 369 corpus files. What it found is fixed, each with a test in
`test/fuzz-regressions.test.ts`.

## More

- [How counting works](docs/how-counting-works.md): the transform, prices, built-ins, determinism,
  source maps, the shadow call stack, allocations and the byte model.
- [Layers](docs/layers.md): engine health, time, real bytes, leaks, growth, search, app weights,
  coverage and the gate.
- [CI](docs/ci.md): the ogygia suite, the workflows, the comment, the results branch.
- [Calibration](docs/calibration.md): prices, weights, the quietness check, recounts, versions.
