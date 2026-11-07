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

| Layer             | What it answers                                                                    |
| ----------------- | ---------------------------------------------------------------------------------- |
| Steps             | How much work each function and line does. Exact.                                  |
| Engine health     | Did V8 stop optimizing a function, drop its optimized code, or see more shapes?    |
| Time              | How long it takes on the plain build, PR and base taking turns in one process.     |
| Real bytes        | What V8 really allocates per function, next to the count's estimate.               |
| Leaks             | Does the heap keep growing as the case runs again and again, and who holds it?     |
| Growth            | Is the case constant, linear, n log n, quadratic or worse in its input size?       |
| Recorded growth   | Which function grows quadratically on its tests' real inputs, with no growth case? |
| Contracts         | Does each function grow no faster than its `@heisenbench` contract says?           |
| Price audit       | Do steps grow with the input the way time does? If not, which price is wrong?      |
| Worst-case search | Which input costs the most work per unit of input, and how does it grow?           |
| Proof             | Is this faster version the same on every input, and cheaper? (on demand)           |
| Real-app weight   | How often the real apps call this function, so a change can be ranked by cost.     |
| Blame             | Which hunks of the PR made a case slower? Found by recounting it with some undone. |
| Upgrades          | What does a dependency upgrade cost, on which of the package's lines?              |
| Upstream draft    | The upgrade's slowdown as an issue for the package: a repro, the counts, the line. |

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

That is the Node Heisenbench runs on, not the Node your library supports. A library tested on
Node 20 or 24 counts its benches in a separate CI job on Node 26, and the counts are as valid: a
count depends on the code and its input, not on the Node version (two Node 26 releases gave the
same steps for all of ogygia's cases, see [Reading the numbers](#reading-the-numbers)).

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

| Case | Steps | Δ | Odds it shows on the clock |
| --- | ---: | ---: | ---: |
| rank: twenty rows | 897 → 1,417 | +520 (+58.0%) | 57% |

<sub>Odds it shows on the clock: how likely the time layer is to see this step change beyond noise, guessed from 475 timed changes (dataset v1). They were timed on a busy machine, so the odds lean low. Pass or fail never uses them.</sub>

By function:

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

The first table is the case as a whole (58% more steps); the second is each changed function's
own steps (84% more in `score`). When no function changed, the section says so and then shows the
PR's own counts: the ten heaviest cases, the function and line with the most steps in each, their
growth class when the report has a growth section, and every case that grows faster than linear.
A bench file that did not load on one side is listed under "Did not run" with its error, and its
cases are left out of "New cases" and "Removed cases".

A repository's first PR, the one that adds the bench files, has a base with none. Count the PR's
bench files on the base's code for it:

```bash
npx heisenbench run bench/*.bench.ts --source-from "$(git merge-base origin/main HEAD)" --out base.json
```

Every counted file the base commit has is read as it is there (from git; the working tree is not
touched), and what only the PR has, like the bench files, from disk.

## Bench files

```ts
bench<T>(name: string, fn: (ctx: T) => unknown, options?: {
	setup?: () => T | Promise<T>;     // outside the window, before every run
	teardown?: (ctx: T) => unknown;   // outside the window, after every run
	scale?: (ctx: T, factor: number) => T; // for `heisenbench growth`, when the generic scaler cannot grow ctx
	grammar?: GrammarOption; // for `heisenbench search`: 'html', 'markdown', 'url', 'js', 'json', 'text', or { 'page.body': 'html' }
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

### Complexity contracts

A function can say how fast it may grow, in its doc comment:

```ts
/** @heisenbench linear in rows */
export function rank(rows: Row[]): number[] {
```

`heisenbench growth` keeps the curve of every contracted function a growth case runs, and
`heisenbench contracts src/*.ts --reports report.json` holds each contract against it: the declared
class or a cheaper one needs 90% odds, or the check fails with the class it measured, the exponent,
the sizes and the lines with the most steps at the largest size. A contract nothing measures fails
too. [layers.md](docs/layers.md#complexity-contracts) has the details.

### What a bench file can load

- TypeScript. Types are stripped, as Node does it. A module that stripping cannot run (`enum`,
  `namespace`, parameter properties) is compiled with the project's TypeScript, and its lines map
  back through the compiler's source map.
- Relative imports the way TypeScript projects write them. When Node cannot find one, the source
  file it names is tried: `./clone.js` loads `clone.ts` (`.mjs` loads `.mts`), and `./core` with
  no extension loads `core.ts`, `core.mts`, `core.js`, `core.mjs`, `core/index.ts` or
  `core/index.js`. Packages in `node_modules` resolve the way they ship.
- A type imported without `type` (`import { Rule, apply } from './rules.js'`, where `Rule` is an
  `export type`). Node's type stripping keeps that import and the module would not link ("does
  not provide an export named 'Rule'"); a named import that nothing in the module reads is
  dropped instead, as `tsc` does. The module it names still loads.
- Anything else Node cannot load by itself (path aliases, modules only a bundler serves, globals
  the code expects) through a preload: `--import <file>` (below).
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
  your code alone, `--deps devalue,svelte` only those packages. CommonJS dependencies are
  counted the same way (`typescript@6.0.3/lib/typescript.js > <anonymous>~2726fa > createScanner
  > scan`, inside the bundle's wrapper function), and Node's
  > built-in modules are never counted: the built-ins they reach are priced where counted code
  > calls them.

## CLI

`heisenbench --help` prints every command with its flags. Each command reads bench files or reports and
writes JSON; `diff` and a few others also write markdown.

| Command                                                                                | What it does                                                                                                                                   |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `heisenbench run <bench files>`                                                        | Count every case. `--measure time,bytes,leaks` (or `all`) adds the plain-build layers to the same report.                                      |
| `heisenbench run <bench files> --cache <dir>`                                          | Count only the cases whose code or inputs changed; reuse the rest. `--cache-verify n` counts n reused ones again.                              |
| `heisenbench diff <base.json> <pr.json>`                                               | The markdown section: changed functions, lines, engine and growth changes. `--time`, `--weights` add their tables.                             |
| `heisenbench blame <base.json> <pr.json> --root <dir>`                                 | The smallest set of the PR's hunks that makes each regressed case slower, by recounting trees with hunks undone.                               |
| `heisenbench upgrade <base.json> <pr.json> --root <dir> --base-root <dir>`             | The PR's code counted with each side's install: what its dependency upgrades cost, on the package's own lines.                                 |
| `heisenbench upstream draft <upgrade.json>`                                            | An issue for the upgraded package's maintainers: a standalone repro timed on both versions, the counts, the line.                              |
| `heisenbench dts <source files> --out <file>`                                          | Types for `__heisenbench`.                                                                                                                     |
| `heisenbench receipt <bench files> --package <tarball \| name@version>`                | A release's receipt: the published tarball counted in a scratch tree, each case in a process of its own, with everything the counts depend on. |
| `heisenbench verify-receipt <receipt.json> <tarball>`                                  | Counts the tarball again the way the receipt was made: `matches`, or the first case that differs.                                              |
| `heisenbench registry <receipts> --out index.html`                                     | A static page comparing receipts: each package across versions, and packages with each other.                                                  |
| `heisenbench health <bench files>`                                                     | Engine health section: tiers, deopts, inline-cache states.                                                                                     |
| `heisenbench growth <bench files>`                                                     | Steps at 1x, 10x, 100x the input, the fitted curve class and the odds of each shape.                                                           |
| `heisenbench growth --recorded <dir>`                                                  | Growth of every function a recorded test run called, over its real input sizes: no `scale` needed.                                             |
| `heisenbench record <bench files> --targets <file>`                                    | Every bench case run once with the input recorder on: more recorded calls, at bench sizes.                                                     |
| `heisenbench contracts <source files> --reports <a.json,b.json>`                       | Each `@heisenbench` complexity contract held against the growth the reports measured; exit 1 when one fails.                                   |
| `heisenbench search <bench files>`                                                     | Edits the input by its grammar toward the most steps per unit; shrinks, grows 1x to 8x, blames lines.                                          |
| `heisenbench prove <module> <function> --candidate <file>`                             | Accepts a faster version only when it behaves the same on every input and costs fewer steps.                                                   |
| `heisenbench time <bench files> --base <dir> --pr <dir>`                               | Times both trees in one process, in turns, and judges them by the no-overlap rule.                                                             |
| `heisenbench audit <bench files>`                                                      | Times the cases at every growth size; names a price whose steps grow unlike the time.                                                          |
| `heisenbench weights <app reports>` / `heisenbench coverage <app reports> --app <dir>` | Real-app weights per function; which functions the app scenarios reached.                                                                      |
| `heisenbench weights import <profiles>`                                                | Weights of real traffic from production profiles; `diff --weights` then ranks findings by CPU time per day.                                    |
| `heisenbench inventory`, `heisenbench replay`, `heisenbench unmeasured`                | The measurement-source gate: every function, what measures it, and a failure for new ones that nothing measures.                               |
| `heisenbench calibrate prices\|points\|agree\|weights`                                 | Fit built-in prices and step-to-time weights on a quiet machine, and check that two calibrations agree.                                        |
| `heisenbench verify`                                                                   | Run every planted case of every layer and check Heisenbench flags exactly the planted ones.                                                    |
| `heisenbench feel train\|check`                                                        | Fit the odds a step change shows on the clock; `check` fits `feel.json` again, byte for byte.                                                  |

`health`, `growth`, `search`, `audit` and `contracts` write their section into the report given by `--out`, so
one JSON file per commit holds everything `diff` needs.

### Counting only what changed

Counts are the same on every run, so a case whose code and inputs did not change need not be
counted again. With `--cache <dir>`, `run` and `growth` key each case by a hash of what it ran and
read: the functions it entered in every module (comments and the bodies of functions it never
entered left out), the files it read, the prices, Heisenbench itself and Node. A case whose key is
in the cache is reused, its lines moved to where the code is now; the rest are counted and added.

The quick start's two cases, after a second loop is added to `rank` (which `score`'s case does
not run):

```
counting rank: twenty rows: src/rank.ts changed
ok       rank: twenty rows  1081 steps
reused   score: one row with three tags  31 steps
cache    1 reused, 1 counted
```

On ogygia's 62 cases (M4 Max, the 12 bench files one after another): 15.0 s to count them all,
2.9 s with a warm cache (Node starting 12 times; no file loads), 4.0 s after a change to the
router's `match_one` (the 2 cases that run it counted again). A comment-only change counts
nothing. `--cache-verify n` counts n reused cases again and fails the case, as a cache bug, if
the recount differs. [How counting works](docs/how-counting-works.md#counting-only-what-changed)
has the key, part by part, and what it assumes.

`calibrate`, `verify` and `feel` run only in a clone of this repository. The npm package does not
ship the calibration corpus, the training dataset or the planted cases, and from npm these
commands say so and stop. It does ship the fitted `feel.json`.

Every command that loads bench files (`run`, `health`, `growth`, `search`, `audit`, `time`,
`blame`, `record`, `prove`) takes `--import <file>[,<file>]`: a preload imported before the
bench files, in that process and in every process it starts (engine health, time, real bytes
and leak children, blame's recounts). A preload that registers a resolve hook
([`module.registerHooks`](https://nodejs.org/api/module.html#customization-hooks)) maps the
imports only a bundler knows, like ogygia's `virtual:ogygia/*` and `$app/*`:

```ts
// bench/preload.ts
import { registerHooks } from 'node:module';

registerHooks({
	resolve(specifier, context, next) {
		if (specifier.startsWith('~/')) {
			return next(new URL(`../src/${specifier.slice(2)}`, import.meta.url).href, context);
		}
		return next(specifier, context);
	}
});
```

```bash
npx heisenbench run bench/*.bench.ts --import bench/preload.ts
```

It is the same as `NODE_OPTIONS=--import=./bench/preload.ts`, which works too.

Exit codes: 0 when everything ran, 1 when a case, a bench file or a layer failed (the report
says which), 2 when the command line is wrong. Errors are one line; `--debug` adds the stack.
A case or a bench file that throws keeps where it threw: the line says `(at helper
(src/lib.ts:7:34))`, the report keeps the frames of the code under test (`error_stack` of the
case, `stack` of a load error), and `--debug` prints them all. Ctrl-C stops the run and every
process it started.

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

Another repository gets the same comparison on its PRs from one workflow file:
[docs/ci-any-repo.md](docs/ci-any-repo.md) has it, about 80 lines, with the first PR and the
read-only and comment jobs handled.

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

**The odds it shows on the clock** (`57%` above) are a bet from a small model fitted on timed
changes: of step changes like this one, how many the time layer saw beyond noise. They were
timed on a busy machine, so they lean low, and pass or fail never uses them.
[docs/feel-odds.md](docs/feel-odds.md) has the model, its held-out scores and what the busy
machine means.

**The model next to the ns** (`model +18 ns, likely +2.3 to +150`) is a second estimate with a range,
from small boosted trees trained on measured changes (`ranges.json`,
[docs/calibration.md](docs/calibration.md#ranges-steps-to-ms-with-a-range)): on held-out commits,
80% or more of measured times fell inside the range. It never changes a verdict.

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
  steps than one that does not in `heisenbench run`. Only the worst-case search counts
  backtracking, on a model of V8's matcher; lookbehind, `\p{}` and the `v` flag are left to V8.
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
- **A real cost rests on the bench's input looking like the traffic's.** A planted O(n) pass in
  an O(1) function, priced from a sampled profile alone, read 43 times what the planted build
  then measured. With the app scenarios' call counts as a second way, the two ways disagreed
  1,756x and said so, and their range held the measured cost
  ([layers.md](docs/layers.md#real-traffic)).
- **Not every layer runs on PRs.** PRs get steps, engine health, growth and time. Real bytes,
  leaks and the price audit run on main and nightly. The worst-case search runs on a PR only for
  changed cases that declare a `setup`, within a 4 minute budget, and nightly on every case. Blame
  runs on a PR only for cases whose steps grew by 1% and 1,000 steps or more, within 60 recounts
  and 5 minutes.
- **Blame sees hunks, not their meaning.** It names the smallest set of hunks that carries the
  extra steps. Hunks that only load together (a renamed function and its callers) come out as one
  set; a regression from a dependency or the lockfile is said to be outside the hunks, since every
  candidate tree shares the head's `node_modules`. `heisenbench upgrade` answers that one: it counts
  the PR's code with the base's install and with its own.
- **An upgrade is placed on lines, not on the upstream commit.** It names the package's function
  and lines between the two installed versions; which release or commit between them made the
  change is left to the package's own history.
- **An upstream draft needs a call a stranger can make.** The function the project called must be
  exported, and its recorded arguments must rebuild as source (strings, numbers, arrays, plain
  objects, Map, Set, Date, RegExp). Otherwise `--entry` and `--input` say what to call and with
  what.

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
Heisenbench verify: 36 of 36 planted cases pass
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
pass  contract/broken            planted  broken: measured quadratic, most steps on lib.ts:22
pass  contract/holds             no-op    holds
pass  search/order               planted  worst/typical 11.24, flagged
pass  search/count               planted  worst/typical 8.11, flagged
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
- [Layers](docs/layers.md): engine health, time, real bytes, leaks, growth, search, proofs of a
  faster version, app weights, coverage and the gate.
- [CI](docs/ci.md): the ogygia suite, the workflows, the comment, the results branch.
- [CI for any repo](docs/ci-any-repo.md): one workflow that counts a PR and its base and posts
  the diff.
- [Calibration](docs/calibration.md): prices, weights, the quietness check, recounts, versions.
- [Odds it shows on the clock](docs/feel-odds.md): the model behind the odds next to a step
  change, its held-out scores, and why a busy machine makes them lean low.
- [Release receipts](docs/receipts.md): a release's counts that anyone can check by counting
  again, and the registry page that compares them.
