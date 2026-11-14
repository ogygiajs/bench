# heisenbench

## 0.3.0

### Minor Changes

- [#70](https://github.com/ogygiajs/bench/pull/70) [`5698901`](https://github.com/ogygiajs/bench/commit/5698901704c4884bb72516519d17593b04964af0) Thanks [@PuruVJ](https://github.com/PuruVJ)! - A variable a nested function uses costs a property read or write on every use, as V8 keeps it in a context object (a module variable nothing reassigns stays free), and a getter or setter costs a call when it runs, so state moved from a closure to class fields no longer reads as slower.

## 0.2.0

### Minor Changes

- [#63](https://github.com/ogygiajs/bench/pull/63) [`355c922`](https://github.com/ogygiajs/bench/commit/355c9229107b4aa6564d265094743bcd5d67bd2f) Thanks [@PuruVJ](https://github.com/PuruVJ)! - Growth flags a case that keeps its class when the steps a change adds grow quadratically or worse, so a pass added under a case that is quadratic already is a finding in the PR comment and in `mutate`.

- [#60](https://github.com/ogygiajs/bench/pull/60) [`a59cd58`](https://github.com/ogygiajs/bench/commit/a59cd5832ea2db46b816e662611b2f4b945f0877) Thanks [@PuruVJ](https://github.com/PuruVJ)! - Code that reads `import.meta.env` runs in every build, defined as a Vite production build defines it, and a project changes the env with `heisenbench.importMetaEnv` in its package.json.

- [#62](https://github.com/ogygiajs/bench/pull/62) [`0292685`](https://github.com/ogygiajs/bench/commit/0292685f329d4f8f798702b8fce2239f67640e3f) Thanks [@PuruVJ](https://github.com/PuruVJ)! - The diff marks code moved between a caller and a new or removed function as moved, with the net change of the move, and pairs a function moved to another module by its body.

- [#63](https://github.com/ogygiajs/bench/pull/63) [`355c922`](https://github.com/ogygiajs/bench/commit/355c9229107b4aa6564d265094743bcd5d67bd2f) Thanks [@PuruVJ](https://github.com/PuruVJ)! - `mutate` takes `--import`, `--conditions` and `--svelte` like every command that loads bench files, and exits 1 when a bench file did not load or a case threw on the root.

- [#65](https://github.com/ogygiajs/bench/pull/65) [`0e151d3`](https://github.com/ogygiajs/bench/commit/0e151d3cd1ffcdd68ab33dbd8c0cc8f67af6ebbe) Thanks [@PuruVJ](https://github.com/PuruVJ)! - `prove` takes a method of a top-level class (`'Cache > get'`, `'Cache > static of'`), with the recorded `this` rebuilt on each side's own class.

- [#65](https://github.com/ogygiajs/bench/pull/65) [`0e151d3`](https://github.com/ogygiajs/bench/commit/0e151d3cd1ffcdd68ab33dbd8c0cc8f67af6ebbe) Thanks [@PuruVJ](https://github.com/PuruVJ)! - Async functions are recorded, with what their promise settles to, so `prove` and recorded growth take them.

- [#67](https://github.com/ogygiajs/bench/pull/67) [`b5db759`](https://github.com/ogygiajs/bench/commit/b5db75973bedaf1c7d684dea543a2d1939200015) Thanks [@PuruVJ](https://github.com/PuruVJ)! - `heisenbench gc --root <dir> [--drop policy.json] [--dry-run]` collects a results tree: it drops the run files a retention policy names, then every shard no kept run file lists, and deletes nothing when any run file or shard cannot be read.

- [#62](https://github.com/ogygiajs/bench/pull/62) [`0292685`](https://github.com/ogygiajs/bench/commit/0292685f329d4f8f798702b8fce2239f67640e3f) Thanks [@PuruVJ](https://github.com/PuruVJ)! - `Object.keys`, `values`, `entries` and `assign` are priced linear in the keys (prices v4), with the keys of a wide object at V8's dictionary rate, so a wide object no longer reads as quadratic.

### Patch Changes

- [#64](https://github.com/ogygiajs/bench/pull/64) [`66e33a2`](https://github.com/ogygiajs/bench/commit/66e33a272d50b45a40db79865c83c99c7a976a3f) Thanks [@PuruVJ](https://github.com/PuruVJ)! - A contract on a method of a module TypeScript compiles (a class with a parameter property, an enum) is measured, instead of reading "unmeasured".

- [#62](https://github.com/ogygiajs/bench/pull/62) [`0292685`](https://github.com/ogygiajs/bench/commit/0292685f329d4f8f798702b8fce2239f67640e3f) Thanks [@PuruVJ](https://github.com/PuruVJ)! - `--conditions` keeps the engine's loader out of the `NODE_OPTIONS` the code under test reads, so counts no longer depend on where Heisenbench is installed.

- [#65](https://github.com/ogygiajs/bench/pull/65) [`0e151d3`](https://github.com/ogygiajs/bench/commit/0e151d3cd1ffcdd68ab33dbd8c0cc8f67af6ebbe) Thanks [@PuruVJ](https://github.com/PuruVJ)! - A recorded input nested deeper than 1,000 levels is counted and not kept, so `prove` no longer crashes reading back a deep walk's recording.

- [#62](https://github.com/ogygiajs/bench/pull/62) [`0292685`](https://github.com/ogygiajs/bench/commit/0292685f329d4f8f798702b8fce2239f67640e3f) Thanks [@PuruVJ](https://github.com/PuruVJ)! - Reports written under the engine's former name (`abax-report/1`) are read by `diff`, `history` and every command that reads a report.

- [#65](https://github.com/ogygiajs/bench/pull/65) [`0e151d3`](https://github.com/ogygiajs/bench/commit/0e151d3cd1ffcdd68ab33dbd8c0cc8f67af6ebbe) Thanks [@PuruVJ](https://github.com/PuruVJ)! - `prove` grows an argument only up to 4,000,000 units of input, stopping at the largest factor that fits and saying so, instead of running out of memory at 100x.

- [#65](https://github.com/ogygiajs/bench/pull/65) [`0e151d3`](https://github.com/ogygiajs/bench/commit/0e151d3cd1ffcdd68ab33dbd8c0cc8f67af6ebbe) Thanks [@PuruVJ](https://github.com/PuruVJ)! - `prove`'s sandbox reads the `node_modules`, `package.json` and `svelte.config` files above the root, so a package of a workspace can be proven.

- [#65](https://github.com/ogygiajs/bench/pull/65) [`0e151d3`](https://github.com/ogygiajs/bench/commit/0e151d3cd1ffcdd68ab33dbd8c0cc8f67af6ebbe) Thanks [@PuruVJ](https://github.com/PuruVJ)! - `record` and `prove --bench` resolve `./x.js` to `x.ts` and extensionless imports, and `record` and `time` load `.svelte` files from packages.

- [#65](https://github.com/ogygiajs/bench/pull/65) [`0e151d3`](https://github.com/ogygiajs/bench/commit/0e151d3cd1ffcdd68ab33dbd8c0cc8f67af6ebbe) Thanks [@PuruVJ](https://github.com/PuruVJ)! - `prove`'s safety check follows scopes: a local named like a global, `typeof window`, a harmless `globalThis` property, a class's `this.constructor` and a `'__proto__'` string that is no key no longer refuse a candidate.

- [#66](https://github.com/ogygiajs/bench/pull/66) [`7c51d08`](https://github.com/ogygiajs/bench/commit/7c51d085633e9d0bfd514a4e0bb17a6758b8d211) Thanks [@PuruVJ](https://github.com/PuruVJ)! - `heisenbench history --reports` reads run files written as a manifest of content-hashed shards (the results branch's `heisenbench/shards/`), checking each shard's size and hash, and still reads whole run files.

## 0.1.0

### Minor Changes

- [#37](https://github.com/ogygiajs/bench/pull/37) [`36f1872`](https://github.com/ogygiajs/bench/commit/36f187251a017a316f3a8fed91fd62c455b921c4) Thanks [@PuruVJ](https://github.com/PuruVJ)! - The worst-case search learns which edits keep making the input denser and makes more of them (`--schedule fixed` keeps the old schedule); each case says on which try it found its slow input.

- [#23](https://github.com/ogygiajs/bench/pull/23) [`d3f8528`](https://github.com/ogygiajs/bench/commit/d3f85282ea711abcd7c5949c50a042802051d5a9) Thanks [@PuruVJ](https://github.com/PuruVJ)! - A slower PR names the change that made it slower.

- [#33](https://github.com/ogygiajs/bench/pull/33) [`393c2dc`](https://github.com/ogygiajs/bench/commit/393c2dcd21c3bdf6b1b2549e1223bc910a08a6eb) Thanks [@PuruVJ](https://github.com/PuruVJ)! - `split`, `replace`, `replaceAll`, `match`, `join` and `Array.from` are priced by the parts, matches, callbacks and items they make, not only by length, so their counts follow measured time.

- [#51](https://github.com/ogygiajs/bench/pull/51) [`f273ac2`](https://github.com/ogygiajs/bench/commit/f273ac26a7bb2aeea86a9243e1d54407faf39449) Thanks [@PuruVJ](https://github.com/PuruVJ)! - `--conditions svelte` (or `svelte,browser`) resolves packages with the export conditions your bundler uses, for the code under test only, and an import with no extension inside a package (`./helpers`) loads as a bundler would load it.

- [#33](https://github.com/ogygiajs/bench/pull/33) [`393c2dc`](https://github.com/ogygiajs/bench/commit/393c2dcd21c3bdf6b1b2549e1223bc910a08a6eb) Thanks [@PuruVJ](https://github.com/PuruVJ)! - CommonJS dependencies are counted and named `name@version/path`, like ES module ones.

- [#35](https://github.com/ogygiajs/bench/pull/35) [`d1eaf1a`](https://github.com/ogygiajs/bench/commit/d1eaf1a81c0212d1270a47b0a673b33371037aed) Thanks [@PuruVJ](https://github.com/PuruVJ)! - A function can declare how fast it may grow (`/** @heisenbench linear in items */`), and `heisenbench contracts` fails when it grows faster or nothing measures it.

- [#30](https://github.com/ogygiajs/bench/pull/30) [`bb8a878`](https://github.com/ogygiajs/bench/commit/bb8a8789d167dd70f961aac34a23e490aa49a6bf) Thanks [@PuruVJ](https://github.com/PuruVJ)! - The nightly report spots slow creep: steps that rise in many small moves across main commits, told apart from a single step.

- [#33](https://github.com/ogygiajs/bench/pull/33) [`393c2dc`](https://github.com/ogygiajs/bench/commit/393c2dcd21c3bdf6b1b2549e1223bc910a08a6eb) Thanks [@PuruVJ](https://github.com/PuruVJ)! - A cache that grows per call inside a dependency is reported as a leak, with its package and what holds it.

- [#39](https://github.com/ogygiajs/bench/pull/39) [`89ee037`](https://github.com/ogygiajs/bench/commit/89ee037df13a7bd773c27e79db144398492c31e0) Thanks [@PuruVJ](https://github.com/PuruVJ)! - When no function changed, `heisenbench diff` shows the PR's own counts: the heaviest cases, where their work is, and how they grow.

- [#35](https://github.com/ogygiajs/bench/pull/35) [`d1eaf1a`](https://github.com/ogygiajs/bench/commit/d1eaf1a81c0212d1270a47b0a673b33371037aed) Thanks [@PuruVJ](https://github.com/PuruVJ)! - `heisenbench dts` keeps each private function's doc comment, so editors show it where the function is used.

- [#44](https://github.com/ogygiajs/bench/pull/44) [`071d5eb`](https://github.com/ogygiajs/bench/commit/071d5ebcc787b4ead48868ec6fde8a9bee0e8386) Thanks [@PuruVJ](https://github.com/PuruVJ)! - Each changed case in the diff shows the odds its step change shows up on the clock ("+58% steps, 57%"), from a small model fitted on timed changes; pass or fail never uses them, and `heisenbench feel train` refits it.

- [#35](https://github.com/ogygiajs/bench/pull/35) [`d1eaf1a`](https://github.com/ogygiajs/bench/commit/d1eaf1a81c0212d1270a47b0a673b33371037aed) Thanks [@PuruVJ](https://github.com/PuruVJ)! - Growth from recorded calls names a line once, even when a callback on that line has steps of its own.

- [#28](https://github.com/ogygiajs/bench/pull/28) [`c947548`](https://github.com/ogygiajs/bench/commit/c947548dbb7047e4247afe80398b96ba9fd5af99) Thanks [@PuruVJ](https://github.com/PuruVJ)! - Growth shapes come with odds ("quadratic 93%, n log n 7%"), one more size is counted when two shapes are close, and a growth finding needs 90% odds of quadratic or worse (`--superlinear-odds`).

- [#49](https://github.com/ogygiajs/bench/pull/49) [`c1db84a`](https://github.com/ogygiajs/bench/commit/c1db84aeb9304261cecd0de27a769da7b7a10540) Thanks [@PuruVJ](https://github.com/PuruVJ)! - `heisenbench history <file>[:<function>]` is `git blame` for steps: each line's cost today, the commit that last changed it and by how much, followed through moves and edits, with a timeline per function.

- [#36](https://github.com/ogygiajs/bench/pull/36) [`edc8f82`](https://github.com/ogygiajs/bench/commit/edc8f827f67da9e99539b94201badb9542884d98) Thanks [@PuruVJ](https://github.com/PuruVJ)! - `--import <file>` loads a preload (resolve hooks for path aliases, Vite-only modules) before the bench files, in every process a command starts.

- [#43](https://github.com/ogygiajs/bench/pull/43) [`451e36a`](https://github.com/ogygiajs/bench/commit/451e36a20d7009135e02c71b4e2808ba440fb40e) Thanks [@PuruVJ](https://github.com/PuruVJ)! - A case is counted again only when the code it runs or the files it reads changed (`heisenbench run --cache`, `heisenbench growth --cache`).

- [#48](https://github.com/ogygiajs/bench/pull/48) [`456e0d1`](https://github.com/ogygiajs/bench/commit/456e0d1c22a9718c5018dcdf4511e470d053186b) Thanks [@PuruVJ](https://github.com/PuruVJ)! - Estimated times come with a range from a small model trained on measured changes ("model 1.2 ms, likely 0.9 to 1.6"), next to the weights' estimate in the step table, the ranked findings, blame, case estimates and the audit; `heisenbench calibrate ranges` retrains it.

- [#45](https://github.com/ogygiajs/bench/pull/45) [`6a3d973`](https://github.com/ogygiajs/bench/commit/6a3d973f10ec8290de05866313c924c717bd5aaf) Thanks [@PuruVJ](https://github.com/PuruVJ)! - `heisenbench mutate` plants slowdowns that keep each function's output the same and reports which ones no bench case notices, with a suggested case for each.

- [#22](https://github.com/ogygiajs/bench/pull/22) [`d653894`](https://github.com/ogygiajs/bench/commit/d65389430e0380b6af9630c7e298588bccd9299f) Thanks [@PuruVJ](https://github.com/PuruVJ)! - Prices audit themselves against measured time.

- [#27](https://github.com/ogygiajs/bench/pull/27) [`9dfdc86`](https://github.com/ogygiajs/bench/commit/9dfdc86b9238ec5f96f07cb5774936570636b0cf) Thanks [@PuruVJ](https://github.com/PuruVJ)! - A faster version of a function is accepted only when it is proven the same and cheaper (`heisenbench prove`).

- [#25](https://github.com/ogygiajs/bench/pull/25) [`d7b33d1`](https://github.com/ogygiajs/bench/commit/d7b33d12265f8dcacdee1d06d67ca44df094f7b3) Thanks [@PuruVJ](https://github.com/PuruVJ)! - Findings are ranked by what they cost on real traffic.

- [#24](https://github.com/ogygiajs/bench/pull/24) [`bbceb8e`](https://github.com/ogygiajs/bench/commit/bbceb8e8f3852ed28145f47fbddc335559919334) Thanks [@PuruVJ](https://github.com/PuruVJ)! - Growth is found from recorded calls, with no hand-written scale needed.

- [#46](https://github.com/ogygiajs/bench/pull/46) [`09eb1b0`](https://github.com/ogygiajs/bench/commit/09eb1b06902ea316920e06dd191163a4724900b8) Thanks [@PuruVJ](https://github.com/PuruVJ)! - A release can carry a receipt of its counts that anyone checks by counting the published tarball again, and a registry page compares receipts across versions and packages.

- [#39](https://github.com/ogygiajs/bench/pull/39) [`89ee037`](https://github.com/ogygiajs/bench/commit/89ee037df13a7bd773c27e79db144398492c31e0) Thanks [@PuruVJ](https://github.com/PuruVJ)! - `heisenbench run --source-from <sha>` counts these bench files on another commit's code, so a repo's first PR has a baseline to diff against.

- [#21](https://github.com/ogygiajs/bench/pull/21) [`a733425`](https://github.com/ogygiajs/bench/commit/a733425e008cf4cd56c496a4d03b3188a11e818f) Thanks [@PuruVJ](https://github.com/PuruVJ)! - Anonymous functions keep their id when unrelated code moves, and dependencies are counted by default.

- [#52](https://github.com/ogygiajs/bench/pull/52) [`b2ca24f`](https://github.com/ogygiajs/bench/commit/b2ca24fed5f1b65f8f664d30e467133e9e12d5f8) Thanks [@PuruVJ](https://github.com/PuruVJ)! - `--svelte client` counts Svelte components as client output (hydration, mounting, updates on a DOM a preload brings), and `run --append` adds a second run's cases to the same report, so server and client benches diff as one.

- [#42](https://github.com/ogygiajs/bench/pull/42) [`836708f`](https://github.com/ogygiajs/bench/commit/836708fd2e51860bde637d0615b228aceea730ba) Thanks [@PuruVJ](https://github.com/PuruVJ)! - A dependency upgrade is counted on its own and placed on the package's own lines.

- [#42](https://github.com/ogygiajs/bench/pull/42) [`836708f`](https://github.com/ogygiajs/bench/commit/836708fd2e51860bde637d0615b228aceea730ba) Thanks [@PuruVJ](https://github.com/PuruVJ)! - An upgrade's slowdown is drafted as an issue for the package's maintainers, with a repro timed on both versions.

- [#26](https://github.com/ogygiajs/bench/pull/26) [`a977420`](https://github.com/ogygiajs/bench/commit/a977420f019dca09e1bb6b194193336e9429c94f) Thanks [@PuruVJ](https://github.com/PuruVJ)! - The worst-case search builds valid inputs and steers toward the most work.

### Patch Changes

- [#56](https://github.com/ogygiajs/bench/pull/56) [`89225d9`](https://github.com/ogygiajs/bench/commit/89225d96f95bad22fd4670fe33b27e0bbe060956) Thanks [@PuruVJ](https://github.com/PuruVJ)! - The CI recipe says where generated inputs and build output come from on a first PR counted with `--source-from` (disk, the PR's), and where steps before counting (fixtures, a build) go.

- [#20](https://github.com/ogygiajs/bench/pull/20) [`80ffd77`](https://github.com/ogygiajs/bench/commit/80ffd772e8397d31f6cd3b7381f17b2e4389ad28) Thanks [@PuruVJ](https://github.com/PuruVJ)! - Long joins are cons strings, so building a string in a loop counts as linear, not quadratic.

- [#39](https://github.com/ogygiajs/bench/pull/39) [`89ee037`](https://github.com/ogygiajs/bench/commit/89ee037df13a7bd773c27e79db144398492c31e0) Thanks [@PuruVJ](https://github.com/PuruVJ)! - The diff gives each changed case's steps, base to PR, and its percent, above the per-function table.

- [#39](https://github.com/ogygiajs/bench/pull/39) [`89ee037`](https://github.com/ogygiajs/bench/commit/89ee037df13a7bd773c27e79db144398492c31e0) Thanks [@PuruVJ](https://github.com/PuruVJ)! - A bench file that did not load on one side is listed under "Did not run" in the diff, and its cases are no longer called new or removed.

- [#55](https://github.com/ogygiajs/bench/pull/55) [`b46ed73`](https://github.com/ogygiajs/bench/commit/b46ed7304dea771f67c02fcb09bc1287544dbd1f) Thanks [@PuruVJ](https://github.com/PuruVJ)! - Environment variables that name the checkout (`NODE_OPTIONS` with an `--import` preload, `INIT_CWD`) read as `/heisenbench/root` inside the measuring window, so code that reads them counts the same in every checkout.

- [#36](https://github.com/ogygiajs/bench/pull/36) [`edc8f82`](https://github.com/ogygiajs/bench/commit/edc8f827f67da9e99539b94201badb9542884d98) Thanks [@PuruVJ](https://github.com/PuruVJ)! - A failed case says where it threw (`at helper (src/lib.ts:7:34)`), keeps its frames in the report, and `--debug` prints them all.

- [#38](https://github.com/ogygiajs/bench/pull/38) [`b7951a4`](https://github.com/ogygiajs/bench/commit/b7951a4eba4eba5900fe0843a6d2085319d16470) Thanks [@PuruVJ](https://github.com/PuruVJ)! - The generic growth scaler keeps a circular input circular instead of following it until the stack overflows.

- [#54](https://github.com/ogygiajs/bench/pull/54) [`2df3610`](https://github.com/ogygiajs/bench/commit/2df361084ccc4fcd55dde76878aa8b6c1770289c) Thanks [@PuruVJ](https://github.com/PuruVJ)! - A growth line whose odds back another shape than its fitted exponent (90% or more) leads with that shape and says what the exponent alone reads (`n log n by the odds (>99%), linear by the exponent alone`), in the CLI and in the diff's own counts.

- [#38](https://github.com/ogygiajs/bench/pull/38) [`b7951a4`](https://github.com/ogygiajs/bench/commit/b7951a4eba4eba5900fe0843a6d2085319d16470) Thanks [@PuruVJ](https://github.com/PuruVJ)! - A growth case that overflows the call stack at a size keeps the sizes below it, fitted, and says where it overflowed.

- [#38](https://github.com/ogygiajs/bench/pull/38) [`b7951a4`](https://github.com/ogygiajs/bench/commit/b7951a4eba4eba5900fe0843a6d2085319d16470) Thanks [@PuruVJ](https://github.com/PuruVJ)! - Growth says when no step moved as the input grew, and when a fixed part makes the exponent read low.

- [#57](https://github.com/ogygiajs/bench/pull/57) [`d0b9c48`](https://github.com/ogygiajs/bench/commit/d0b9c483a0e99c319dd6dec3a00a70a155caf5b0) Thanks [@PuruVJ](https://github.com/PuruVJ)! - The odds next to a step change and the ms ranges are now trained on a dataset timed on a quiet 4-core runner, so the odds no longer lean low and the ranges are tighter.

- [#38](https://github.com/ogygiajs/bench/pull/38) [`b7951a4`](https://github.com/ogygiajs/bench/commit/b7951a4eba4eba5900fe0843a6d2085319d16470) Thanks [@PuruVJ](https://github.com/PuruVJ)! - `growth`, `health`, `search` and `audit` take an empty `--out` file or `--out /dev/null` as a new report.

- [#53](https://github.com/ogygiajs/bench/pull/53) [`68f59a7`](https://github.com/ogygiajs/bench/commit/68f59a78330d3ad0f041e6aef7bb782daa708a79) Thanks [@PuruVJ](https://github.com/PuruVJ)! - A count no longer depends on where the project lives: every path the counted code reads (`import.meta`, `__filename`, `require.resolve`, stacks, `process.cwd()`) names the root `/heisenbench/root`, and receipts no longer pad their root to a fixed length.

- [#36](https://github.com/ogygiajs/bench/pull/36) [`edc8f82`](https://github.com/ogygiajs/bench/commit/edc8f827f67da9e99539b94201badb9542884d98) Thanks [@PuruVJ](https://github.com/PuruVJ)! - A type imported without `type` no longer stops a module from loading ("does not provide an export named").

- [#36](https://github.com/ogygiajs/bench/pull/36) [`edc8f82`](https://github.com/ogygiajs/bench/commit/edc8f827f67da9e99539b94201badb9542884d98) Thanks [@PuruVJ](https://github.com/PuruVJ)! - `./x.js` imports of `x.ts` files, and imports with no extension (`./core`, `./parser`), load without a preload.
