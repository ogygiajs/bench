# How counting works

Heisenbench measures a bench case on a counting build: every module the case loads is rewritten so each
function counts its own work as it runs. This page covers the rewrite, how work is priced, what
keeps the count the same from run to run, and how the count is mapped back to source lines.

## The rewrite

`heisenbench run` registers a module loader (`module.registerHooks`) and imports the bench file. Every
module loaded after that goes through the transform: oxc-parser reads it, magic-string edits it,
and the edits keep a source map. That includes the dependencies in `node_modules`, ES modules and
CommonJS alike (`--deps none` or `--deps a,b` narrows it); it never includes Heisenbench's own
modules, Node's built-in modules, or what Heisenbench itself `require`s (the Svelte or TypeScript
compiler it compiles with) and everything that loads. The same transform is also a Vite, Rolldown and Rollup plugin
(`heisenbench/plugin`), used for the counted app builds.

### CommonJS

`module.registerHooks` runs for `require` as well as `import`, so a CommonJS file goes through the
same load hook. A file Node names no format for (a `require`d `.js`) is CommonJS when it is `.cjs`
or its nearest package.json is not `"type": "module"`. It is parsed as CommonJS (sloppy mode, a
`return` at the top) and instrumented the same way, with three differences: it takes its counters
from the runtime (`Runtime.counters(specifier, meta)`, registered once per file) instead of
importing a counter module, it names itself by `__filename` where an ES module says
`import.meta.url` (the call sites that check their caller, V8 reports a CommonJS frame by path),
and it gets no `__heisenbench` export. Node finds the named exports of a CommonJS module that an ES
module imports by reading its source; the counters go inside function bodies, so the getters
TypeScript writes for a re-export (`Object.defineProperty(exports, "x", { get: function () {...} })`)
still read as exports. A file that does not parse as CommonJS (an ES module in a `.js` with no
package type, which Node detects by its syntax) is left to Node.

Node caches a CommonJS file by its path, whatever query the module that imports it carries, so a
fresh module graph per run (below) would share it. Each new graph first drops the CommonJS files
the bench graph loaded from `require.cache`, and they are evaluated again with module state of
their own (`test/deps.test.ts`: a package's module-level call counter keeps two identical runs
equal; with `--state shared` they differ).

This module:

```ts
function score(row: Row): number {
	let s = 0;
	for (const t of row.tags) {
		s += t.length;
	}
	return s;
}
```

comes out as (types left in, as the transform sees TS before Node strips it):

```js
function score(row: Row): number {const $a$r=$a$R.enter($a$f+1);try{$a$c[1]++,$a$s[0]+=10;
	let s = 0;
	for (const t of row.tags) {$a$c[2]++,$a$s[0]+=7;
		s += t.length;
	}
	$a$c[3]++;return s;
}finally{$a$R.exit($a$r)}}
```

- `$a$c` is the module's `Float64Array` of block counts. `$a$c[2]++` runs every time the loop body
  starts.
- `$a$s[0] += 7` adds the block's price to a running total, used for inclusive steps.
- `R.enter` and `R.exit` push and pop the function on a shadow call stack.
- The counters come from a small virtual module per file (`heisenbench:module/<hash>`), imported first,
  so a function called early through an import cycle still finds them.

Nothing is inserted on a line of its own, so line numbers do not move.

### Blocks

A block is straight-line code: once it starts, all of it runs. Each of these starts a block:

- a function body, a loop body, each branch of `if`, each `case` of a `switch`, `catch` and
  `finally`
- the code after a loop or a branch
- the right side of `&&`, `||` and `??`, and each side of `?:`
- the part after `?.` (counted through `R.opt`)
- a default parameter value

From a real module:

```js
export function label(user: { name?: string } | null, fallback = ($a$c[2]++,'anon')): string {...
	const name = $a$R.opt($a$c,3,1,user)?.name ?? ($a$c[4]++,fallback);
	return name.length > 0 && ($a$c[5]++,$a$s[0]+=1,name !== 'root') ? ($a$c[6]++,$a$s[0]+=6,$a$R.str($a$d,2,`@${name}`)) : ($a$c[7]++,fallback);
```

Every function is counted: exported or not, nested, arrow, method, getter, class field
initializer. Module-level code is a function too, named `<top>`.

### import.meta.env

Code written for Vite reads `import.meta.env.DEV` (and `PROD`, `MODE`, `SSR`, `BASE_URL`). Vite
replaces those statically, its `define`, so `if (import.meta.env.DEV) {...}` is dead code the
shipped bundle drops; Node has no `import.meta.env`, and the same line throws in a bench. So every
build Heisenbench loads code with (the counting build, the plain build of the time, bytes and leak
layers, the engine-health child, the recorder) defines it the same way, before anything else sees
the code (`src/transform/env.ts`):

- a read (`import.meta.env.DEV`, `import.meta.env?.SSR`, `import.meta.env['MODE']`) becomes its
  literal (`false`), padded with spaces so no line or column moves. A literal costs nothing, so
  the read counts what a constant counts. A key the env does not have reads `undefined`, as in
  Vite.
- `import.meta.env` anywhere else (`const { DEV } = import.meta.env`, a computed key, a write) is
  the whole env as an object literal, as Vite 8 writes it. That is longer than what it replaces,
  so the rewrite's source map is chained to the module's.

Dependencies in `node_modules` get it too: `vite build` defines every module it bundles, packages
included. A module without `import.meta.env` is left byte for byte as it was, so its count does not
change.

The env models a production client build:
`{ BASE_URL: '/', DEV: false, MODE: 'production', PROD: true, SSR: false }`. A project changes it
with one key in its package.json, merged over that default; the nearest package.json above a file
that sets it is the one the file reads (`SSR: true` for server code, `VITE_*` keys the code reads):

```json
{ "heisenbench": { "importMetaEnv": { "SSR": true, "VITE_API_URL": "/api" } } }
```

Values are strings, numbers, booleans or `null`. A module reads the env once, when it loads, so it
is one per project, not one per case. The env is part of a cached case's key.

## Prices

A block's price is fixed when the module is transformed: the sum of the operations in it, each at
the price in `prices.json`.

| Operation                  | Steps | Operation                        | Steps |
| -------------------------- | ----: | -------------------------------- | ----: |
| property read              |     1 | call                             |     4 |
| property write             |     2 | `new`                            |     6 |
| arithmetic, comparison     |     1 | template literal                 |     2 |
| logical, branch, unary     |     1 | string concatenation             |     2 |
| assignment, `++`/`--`      |     1 | start a `for..of` (the iterator) |     8 |
| allocation                 |     4 | each `for..of` step              |     4 |
| each 4-byte word allocated |     1 | each `for..in` step              |     6 |
| `await`                    |    20 | `yield`                          |    10 |
| `throw`                    |    30 |                                  |       |

In `score`, the first block is an assignment, a property read (`row.tags`) and the start of a
`for..of`: 1 + 1 + 8 = 10. The loop body is a property read, an addition, an assignment and an
iterator step: 1 + 1 + 1 + 4 = 7. For 20 rows of 3 tags, `score` costs 20 × 10 + 60 × 7 = 620
steps, which is what the report says. In `rank`, `const out: number[] = []` is an allocation (4),
four words of an empty array (16 B, so 4) and an assignment (1): 9 steps on line 15.

Some costs depend on sizes only known at run time. The runtime adds them when the code runs:

| Dynamic cost                     | Steps |
| -------------------------------- | ----: |
| each key of an object spread     |     3 |
| each element of an array spread  |     2 |
| each element of a rest parameter |     1 |
| each element of `arguments`      |     1 |
| each character of a short join   |  0.25 |

A join (`a + b`, `s += x`, a template literal) whose result has 13 characters or more costs no
characters: V8 makes a cons string that points at the two halves and copies neither, so a page
built piece by piece in a loop costs per piece. Below 13 characters V8 copies, and so does the
count.

**Steps** of a function are `sum(block count × block price)` plus these dynamic costs plus the
built-ins it called.

## Built-ins

`sort`, `split`, `JSON.parse` and the like do work that the code does not spell out. While the
measuring window is open, each priced built-in is replaced by a wrapper that calls the original
and charges `base + k × f(n) + Σ kₜ × t`, where `n` is the size that drives the work (the
array's length, the string's length), `f` is one of `1`, `n`, `n log n` or `n²`, and each `t` is
a size term: another size the work follows, measured on the call.

| Size term   | What it counts                                                         | Kept for                                 |
| ----------- | ---------------------------------------------------------------------- | ---------------------------------------- |
| `parts`     | strings a `split` cuts                                                 | `split`                                  |
| `matches`   | matches it replaces or returns                                         | `replace`, `replaceAll`, `match` with /g |
| `callbacks` | calls it makes into the code                                           | `replace`, `replaceAll`, `Array.from`    |
| `values`    | values it builds or visits                                             | `JSON.parse`, `JSON.stringify`           |
| `items`     | elements it turns into text (a number in a `join`; a string is copied) | `join`                                   |

`split` is the reason: cutting 16,384 characters into 5 parts takes 0.4 µs, into 8,193 parts
83 µs, so a price per character was 25x too high on long lines and 2.6x too low on short ones.
Every call keeps its size terms in its units, priced or not, so a price can start using one and
still recount exactly, and the price audit can test one a price leaves out. 57 built-ins have a
price today. A few:

| Built-in                   | Price                             |
| -------------------------- | --------------------------------- |
| `Map.prototype.get`        | 24.5                              |
| `Set.prototype.add`        | 147                               |
| `Array.prototype.sort`     | 66 n log n                        |
| `Array.prototype.map`      | 150 + 53 n                        |
| `String.prototype.split`   | 154 + 125 parts                   |
| `String.prototype.slice`   | 17.75                             |
| `String.prototype.replace` | 242 + 115 matches + 206 callbacks |
| `Array.prototype.join`     | 59.25 + 2.03 n + 223 items        |
| `JSON.parse`               | 400 + 11 n                        |
| `RegExp.prototype.exec`    | 109 + 0.1875 n                    |
| `structuredClone`          | 3120 + 105 n                      |

The transform marks each call site that may reach a built-in by name (`x.slice(a)`,
`structuredClone(v)`, `Array.prototype.map.call(xs, f)`). It wraps the receiver the call runs on
(`R.rcv(k, x).slice(...)`) and announces the site after the last argument
(`R.site_last(k, a)`), right before the call. The wrapper charges the built-in to that site only
when the site names it and it runs on that receiver, so the charge lands on the line of the call.
Where wrapping the receiver would change what the code does (inside an optional chain, after an
`await` in the arguments, on `super`), the site is announced without it and the wrapper checks
that its caller is the module that announced it, from V8's stack.

So a built-in is charged only when counted code calls it directly. Code that is not counted,
Node's own JavaScript or a dependency left out with `--deps`, costs nothing, and neither do the
built-ins it calls: a same-named method of uncounted code (`headers.get(...)`, which calls
`Map.prototype.get` inside) is not a call of the built-in. Before this rule, Node's `URLSearchParams`
parsing (non-primordial `slice` calls) cost ogygia's flag `override` 651 `slice` calls on Node 26.4
and 1,151 on Node 26.13. A built-in called by another built-in is not charged twice. A built-in
with no price (`Array.prototype.push`, for one) costs what any call costs: 4 steps.

Where the prices come from is in [calibration.md](calibration.md).

## The same count every time

A count is only useful if the same code with the same input gives the same number. Inside the
measuring window:

- **Clock.** `Date`, `Date.now`, `performance.now` and `process.hrtime` read a virtual clock. It
  starts at 2024-01-01T00:00:00Z and moves 1 ms per read.
- **Randomness.** `Math.random` and `crypto.getRandomValues`, `randomUUID`, `randomBytes` and
  `randomInt` come from one seeded generator (sfc32, seed `0xabac`).
- **Timers.** `setTimeout`, `setInterval` and `setImmediate` go to a fake loop that runs them in
  order of due time, then creation, moving the virtual clock to each one's due time.
- **IO.** The warm-up run records file reads and `fetch` responses; the measured runs replay them,
  failed reads included (a missing file throws the same error). A read that was not recorded, any
  write, and any socket (`http`, `https`, `net`) throws.
- **Paths.** The counted code lives under `/heisenbench/root`, which stands for the run root, in
  every checkout and at any depth (`src/runtime/paths.ts`). Code that splits, slices, joins or
  matches a path does work per character and per part, so a real path would make the count follow
  the checkout: `heisenbench@0.0.0`'s transform writes its runtime's file URL into every module it
  makes, and counted 1,496 more steps under a 182-character root than under a 46-character one.
  What the code sees:

  | Where                                        | What it says                                                                    |
  | -------------------------------------------- | ------------------------------------------------------------------------------- |
  | `import.meta.url`, `filename`, `dirname`     | `file:///heisenbench/root/src/lib.ts`, without `?heisenbench_gen=N`             |
  | `import.meta.resolve(...)`                   | a virtual URL                                                                   |
  | `__filename`, `__dirname`, `require.resolve` | virtual paths                                                                   |
  | `createRequire(<virtual path or URL>)`       | a require of the real file, answering virtual paths                             |
  | `error.stack`                                | virtual URLs and paths                                                          |
  | `process.cwd()`                              | `/heisenbench/root`, called from a module of the root (and `PWD` in the window) |
  | `fs` on a virtual path                       | the real file; `realpath`, `readdir` entries and errors say it back virtually   |

  The transform rewrites `import.meta` in every counted module, and the loader in every bench
  file, to a call of the module's own virtual meta (`src/transform/meta.ts`); the call is not
  priced. `import()` and `require` of a virtual URL or path load the real file. A real path in
  stays real: code that got one elsewhere gets real answers, and a module outside the root keeps
  its real path (the fresh-copy query dropped). What stays real: `process.argv`, `os.tmpdir()`,
  `module.filename`, `require.cache`'s keys, a `CallSite`'s file name, a stack formatted by a
  `prepareStackTrace` the code sets itself, the `import.meta` of a dependency left out with
  `--deps`, and the working directory for Heisenbench's own code and the compilers it loads, which
  compile real files.
  `test/paths.test.ts` counts a module that reads its own location all these ways, and every
  answer key of `heisenbench verify`, at three roots (short; long and deep; unicode and spaces):
  the reports are the same.

- **Finalizers.** `FinalizationRegistry` callbacks only run between runs. A `WeakRef` made in the
  window keeps its target, so `deref()` never changes during a run.
- **Module state.** Each run imports a fresh copy of the bench file and everything it imports
  (`?heisenbench_gen=N`; CommonJS files are dropped from `require.cache`), so a cache or counter
  in module scope starts empty every time. `--state shared` turns this off. Growth does the same
  for every run of every size, so a case's curve does not depend on the cases grown before it
  (on shared state, 4 of ogygia's 34 grown cases counted less: their own earlier runs had already
  built what they build lazily), and its count at 1x is its `heisenbench run` count. Growth from
  recorded calls gives each module a copy of its own.

Each case runs three times: a warm-up that records IO, then two measured runs. If the two
measured counts differ in any function, the case is reported **unstable**. That is a finding: the
code reads something the window does not control.

The runtime never charges itself. Its own tables are typed arrays and plain objects, not `Map`s
(a priced built-in), and its hot path has no regular expressions.

## Lines and source maps

A report places every block on a line of the original source:

- **TypeScript** is stripped by Node's own type stripping, which replaces types with spaces, so
  offsets and lines stay the same. A module stripping cannot run (`enum`, `namespace`,
  parameter properties) is compiled with the TypeScript compiler (the project's, else Heisenbench's own),
  and the compiler's source map takes its blocks back to their lines. Bench files get the same
  treatment, so an `enum` in one does not stop the run. Either way, a named import that nothing
  in the module reads (a type imported without `type`) is blanked out with spaces, as `tsc`
  elides it, so it keeps offsets too (`src/transform/elide.ts`).
- **`.svelte` and `.svelte.ts`** are compiled with the project's own Svelte compiler (server
  output by default). The compiler's source map is combined with the transform's, so a block in
  compiled output reports the `.svelte` line.
- **In a Vite build** the plugin runs last and maps through the combined map of every plugin
  before it.

## The call stack

The runtime keeps a shadow call stack: an `Int32Array` of function ids. `R.enter` pushes, `R.exit`
pops in a `finally`, so a throw unwinds it correctly.

- **Self steps** of a function are the steps of its own blocks and built-in calls.
- **Inclusive steps** are every step that ran while the function was anywhere on the stack,
  counted once even when it is on the stack several times (recursion).
- **Edges** count caller to callee calls.

An `async` function or a generator gets a frame object. At each `await` or `yield` the transform
saves its part of the stack and restores it on resume:

```js
const text = $a$R.resume($a$r, await $a$R.suspend($a$r, read()));
```

so work done by other code while it waits is not charged to it. `await using` blocks are
rewritten so the disposal awaits are spelled out and handled the same way.

## Allocations and bytes

The transform finds every allocation site in counted code: object and array literals, closures,
classes, `new`, regex literals, built strings, `bind`, rest parameters, `arguments`, object and
array spreads, spread arguments, the promise of an async call, the generator object. Each time a
site runs it adds one allocation and an estimated size.

The size model is V8 on 64 bits with pointer compression, Node's default:

| What                     | Bytes                                                                         |
| ------------------------ | ----------------------------------------------------------------------------- |
| Object                   | 12 header + 4 per field; `{}` reserves 4 fields (28)                          |
| `new C()`                | 12 + 4 per field V8 can predict (class fields, `this.x =` in the constructor) |
| Array                    | 16; a non-empty one adds an 8-byte backing store header + 4 per element       |
| Closure                  | 32 + 4 per captured variable                                                  |
| Bound function           | 24, plus 8 + 4 per bound argument                                             |
| Promise of an async call | 20 + 28 for the suspended function                                            |
| Generator                | 40 + 8 + 4 per local                                                          |
| Regex literal            | 28                                                                            |
| One-byte string          | 12 + 1 per character, rounded up to 4                                         |
| Join of 13+ characters   | 20 (a cons string: it points at its two halves, nothing is copied)            |
| `Map` / `Set` (empty)    | 88 / 72                                                                       |

A priced built-in that returns something new adds it too, charged to the line that called it:
the array or string it returns, the strings `split` cuts, a match's captures, what `JSON.parse`
and `structuredClone` build. A string cut out of a longer one (`slice`, `substring`, `trim`, the
parts of `split`) of 13 characters or more is a 20-byte slice that points into its parent, as in
V8. A result the call already had (`sort` returns its own array) adds nothing. These show in the
report under each built-in, with their own bytes and allocations.

This is what the code asks for. The engine may give less: escape analysis removes objects that
never leave an optimized function. It may also give more: the backing store that `push` grows and
what unpriced built-ins return are not in the estimate. The
[real bytes layer](layers.md#real-bytes) measures what V8 allocates, per function, and the report
shows both.

## Private functions

The transform appends one statement at the end of every module:

```js
export const __heisenbench = { score };
```

listing the top-level bindings the module does not export. A `let` that can be reassigned is
exposed through a getter so the bench sees its current value. The statement is at the end, so it
changes no initialization order. `heisenbench dts` asks the TS checker for each module's declarations
with the same statement appended and writes them into a module augmentation, so the bench file is
type-checked. The plain build used by the time, bytes and leak layers appends the same statement,
so bench files run unchanged on it.

## Identity

A function is `module > path`: `packages/router/src/match.ts > match_one`, or
`router.ts > Router > match` for a method. A block is its function plus an index
(`... > match_one > block 4`).

A function without a name of its own is named by where it is, plus its shape:
`rank.ts > total > reduce:0~3fa9c2` is the arrow passed as argument 0 to `reduce` inside
`total`, and `3fa9c2` is six hex digits of a hash of its syntax tree (node types, names,
operators, literal values). Whitespace, comments, parentheses, quotes and TypeScript types are
not in the tree, so formatting the function or stripping its types does not move its id; adding
another `reduce` callback before it does not either. Only two callbacks alike in place and shape
are told apart by order: `reduce:0~3fa9c2#2`. A function the language names (a declaration, a
method, `const f = () => {}`, `{ f() {} }`) keeps that name, and only a second one of the same
name in the same scope gets its hash.

Before this, the `n`th callback in a slot was `reduce:0#n`, so adding one earlier renamed every
later one: ogygia's gate then reported an untouched comparator as a new, unmeasured function.

An edit to a callback's own code gives it a new hash. Everything that compares two trees pairs it
by its place, the path without hashes:

- `heisenbench diff` pairs a function with a new hash in the same place (under the function its
  parent was matched to) before it pairs by shape. That is a change, not a rename.
- The gate counts it as on the base: in each place, every base function the PR no longer has
  stands for one PR function there the base did not have.
- An exemption may name a place (`rank.ts > total > reduce:0`): it covers every callback there.
- Real-app weights are kept per place, since a PR's edited callback has a hash main never saw.

Dependencies are named by package, version and file: `acorn@8.18.0/dist/acorn.mjs > Parser`.
The version comes from the package's `package.json`, so the name is the same in every checkout
and with any package manager's layout (`node_modules/.pnpm/acorn@8.18.0/node_modules/acorn/...`
and `node_modules/acorn/...` are both `acorn@8.18.0/...`). When a PR upgrades a dependency,
`heisenbench diff` pairs its functions across the two versions.

`heisenbench diff` matches functions by identity, through git renames of the file, and by body shape
when the function itself was renamed (80% similar block prices). A function whose own steps,
allocations and bytes did not change produces nothing, however far its lines moved. When it did
change, unchanged lines are mapped through `git diff` and compared one to one; lines inside a
changed hunk are compared as a whole, so a reformatted line costs nothing, and the hunk's new
lines are reported as "new code".

## Counting only what changed

Counts are deterministic, so a case's report is a function of what it runs and what it reads.
`heisenbench run --cache <dir>` (and `heisenbench growth --cache <dir>`) does not count a case
again when none of that changed. Its counts come from the cache, moved onto the lines its code
sits on now, and the case is marked `reused`. Code: `src/cache/`.

**The key** of a case is a hash of:

| Part    | What                                                                                                                                                                                                                                                                                                                  |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| engine  | Heisenbench's own source, `package.json`, the weights and the versions of its dependencies (oxc-parser decides what the transform sees).                                                                                                                                                                              |
| prices  | The prices file's hash (`HEISENBENCH_PRICES` included).                                                                                                                                                                                                                                                               |
| node    | Node, V8, platform and arch. A report records the Node that counted it, and Node's built-in modules are code counted code calls.                                                                                                                                                                                      |
| options | `--deps`, `--state`, Svelte output; for growth also the sizes, the cap and `--scaled`.                                                                                                                                                                                                                                |
| flags   | Node's flags (`NODE_OPTIONS`, `execArgv`), with the bytes of every preload they name, and `NODE_ENV`.                                                                                                                                                                                                                 |
| modules | Every module the case loaded. A counted module of the project: its text normalized, with the body of every function the case did not run left out. A bench file: its whole text, normalized. Anything else (a dependency, a `.svelte` file, JSON): its bytes. Each with its id, which carries a dependency's version. |
| files   | Every file the case read, statted or listed through `node:fs`, in the window or in `setup`: its bytes, its kind and size, its listing. The real path of every module Node resolved, and the `package.json` nearest to each module (its `exports` and `imports` decide what a specifier resolves to).                  |

"Normalized" drops comments and turns every run of whitespace between two tokens into one space,
or one newline when the run breaks a line (a newline is never a space: automatic semicolon
insertion reads it). Strings, template text, regular expressions and JSX text keep their bytes.
TypeScript is keyed with its types stripped, the way it runs.

**Why a body can be left out.** Which functions a case ran comes from the counters themselves:
every block that ran, while the bench file loaded, in `setup`, in the three runs and in
`teardown`. A function is only entered through code that ran. If all of that code is the same and
reads the same input, the case takes the same path and enters no function it did not enter
before, so the bodies it never entered cannot change its count. A changed function that some case
runs changes that case's key, and only that case's: on ogygia, three lines planted in
`match_one` (the [README example](../README.md#an-example)) count the 2 cases that run it again
and reuse the other 60.

**The manifest.** A key is computed from an earlier run's manifest: the modules it loaded, the
functions it ran in each, the files it read. The cache keeps the newest few runs of each bench
file. When a manifest of every case of a file still matches, the file is not even loaded; its
report comes whole from the cache. A file with one changed case loads, and counts that case alone.
A counted case says why it was not reused: `counting match_path: ...: packages/router/src/match.ts
changed`.

**Lines.** A comment line above a function moves its lines but not its count. The cache keeps
where each line of the report starts in the normalized text, and a reused report is moved onto
the lines that text sits on now. A comment-only change to ogygia's compiler (a three-line header,
a comment line and an end-of-line comment inside `#analyze`) counted nothing again, and every
reused case, moved, equalled a recount of it line for line.

**The check.** `--cache-verify n` counts n reused cases again. A recount that differs from the
cache is a cache bug: the case fails with the first difference (`totals.steps: 4 vs 3`), the run
exits 1, and the recount replaces the entry.

**Where it lives.** A directory, content-addressed (`v1/values/<key>`, `v1/files/<bench file>/`),
so many trees, commits and runs can share one, and two processes can write to it at once. Values
are gzipped report sections: ogygia's 62 cases take 1.7 MB. `pruneCache(dir, days)` drops what
no run used for that long.

What the key does not see, and so assumes:

- **A case does not read what an earlier case left in global state.** Every run starts from fresh
  module state, so module scope cannot carry anything from case to case; `globalThis` can. Each
  case keys the modules and files of its own runs. `test/order.test.ts` checks that a case counts
  the same in either order and alone, for `run` and `growth`.
- **`Function.prototype.toString` and `error.stack`.** Code that reads its own source text or line
  numbers sees comments and lines the key leaves out.
- **Environment variables** other than `NODE_ENV`, and the paths that stay real (above). Counts
  that depend on them already differ between two machines and two checkouts.
- **CommonJS resolution.** `require` finds files by trying extensions in Node's own code, which the
  watch does not see; the files it loads, and their bytes, are keyed.
- **Engine health and the time layers are measurements, not counts.** They are never cached.
