# How counting works

Heisenbench measures a bench case on a counting build: every module the case loads is rewritten so each
function counts its own work as it runs. This page covers the rewrite, how work is priced, what
keeps the count the same from run to run, and how the count is mapped back to source lines.

## The rewrite

`heisenbench run` registers a module loader (`module.registerHooks`) and imports the bench file. Every
module loaded after that goes through the transform: oxc-parser reads it, magic-string edits it,
and the edits keep a source map. That includes the ES modules of dependencies in `node_modules`
(`--deps none` or `--deps a,b` narrows it); it never includes Heisenbench's own modules, Node's
built-in modules, or CommonJS files, which run as they are. The same transform is also a Vite, Rolldown and Rollup plugin
(`heisenbench/plugin`), used for the counted app builds.

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
and charges `base + k × f(n)`, where `n` is the size that drives the work (the array's length,
the string's length) and `f` is one of `1`, `n`, `n log n` or `n²`. 57 built-ins have a price
today. A few:

| Built-in                 | Price          |
| ------------------------ | -------------- |
| `Map.prototype.get`      | 24.5           |
| `Set.prototype.add`      | 147            |
| `Array.prototype.sort`   | 66 n log n     |
| `Array.prototype.map`    | 150 + 53 n     |
| `String.prototype.split` | 366 + 18.5 n   |
| `String.prototype.slice` | 17.75          |
| `JSON.parse`             | 400 + 11 n     |
| `RegExp.prototype.exec`  | 109 + 0.1875 n |
| `structuredClone`        | 3120 + 105 n   |

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
- **Working directory.** `process.cwd()` (and `PWD`) is `/heisenbench/root`, which stands for the run
  root. Code that slices or compares the working directory (ogygia's profiler path helpers) counts
  the same in every checkout, at any depth. Reads of files under `/heisenbench/root` go to the root.
- **Finalizers.** `FinalizationRegistry` callbacks only run between runs. A `WeakRef` made in the
  window keeps its target, so `deref()` never changes during a run.
- **Module state.** Each run imports a fresh copy of the bench file and everything it imports
  (`?heisenbench_gen=N`), so a cache or counter in module scope starts empty every time. `--state shared`
  turns this off.

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
  treatment, so an `enum` in one does not stop the run.
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
