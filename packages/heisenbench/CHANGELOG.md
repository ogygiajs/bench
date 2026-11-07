# heisenbench

## 0.1.0

### Minor Changes

- [#23](https://github.com/ogygiajs/bench/pull/23) [`d3f8528`](https://github.com/ogygiajs/bench/commit/d3f85282ea711abcd7c5949c50a042802051d5a9) Thanks [@PuruVJ](https://github.com/PuruVJ)! - A slower PR names the change that made it slower.

- [#30](https://github.com/ogygiajs/bench/pull/30) [`bb8a878`](https://github.com/ogygiajs/bench/commit/bb8a8789d167dd70f961aac34a23e490aa49a6bf) Thanks [@PuruVJ](https://github.com/PuruVJ)! - The nightly report spots slow creep: steps that rise in many small moves across main commits, told apart from a single step.

- [#28](https://github.com/ogygiajs/bench/pull/28) [`c947548`](https://github.com/ogygiajs/bench/commit/c947548dbb7047e4247afe80398b96ba9fd5af99) Thanks [@PuruVJ](https://github.com/PuruVJ)! - Growth shapes come with odds ("quadratic 93%, n log n 7%"), one more size is counted when two shapes are close, and a growth finding needs 90% odds of quadratic or worse (`--superlinear-odds`).

- [#22](https://github.com/ogygiajs/bench/pull/22) [`d653894`](https://github.com/ogygiajs/bench/commit/d65389430e0380b6af9630c7e298588bccd9299f) Thanks [@PuruVJ](https://github.com/PuruVJ)! - Prices audit themselves against measured time.

- [#27](https://github.com/ogygiajs/bench/pull/27) [`9dfdc86`](https://github.com/ogygiajs/bench/commit/9dfdc86b9238ec5f96f07cb5774936570636b0cf) Thanks [@PuruVJ](https://github.com/PuruVJ)! - A faster version of a function is accepted only when it is proven the same and cheaper (`heisenbench prove`).

- [#25](https://github.com/ogygiajs/bench/pull/25) [`d7b33d1`](https://github.com/ogygiajs/bench/commit/d7b33d12265f8dcacdee1d06d67ca44df094f7b3) Thanks [@PuruVJ](https://github.com/PuruVJ)! - Findings are ranked by what they cost on real traffic.

- [#24](https://github.com/ogygiajs/bench/pull/24) [`bbceb8e`](https://github.com/ogygiajs/bench/commit/bbceb8e8f3852ed28145f47fbddc335559919334) Thanks [@PuruVJ](https://github.com/PuruVJ)! - Growth is found from recorded calls, with no hand-written scale needed.

- [#21](https://github.com/ogygiajs/bench/pull/21) [`a733425`](https://github.com/ogygiajs/bench/commit/a733425e008cf4cd56c496a4d03b3188a11e818f) Thanks [@PuruVJ](https://github.com/PuruVJ)! - Anonymous functions keep their id when unrelated code moves, and dependencies are counted by default.

- [#26](https://github.com/ogygiajs/bench/pull/26) [`a977420`](https://github.com/ogygiajs/bench/commit/a977420f019dca09e1bb6b194193336e9429c94f) Thanks [@PuruVJ](https://github.com/PuruVJ)! - The worst-case search builds valid inputs and steers toward the most work.

### Patch Changes

- [#20](https://github.com/ogygiajs/bench/pull/20) [`80ffd77`](https://github.com/ogygiajs/bench/commit/80ffd772e8397d31f6cd3b7381f17b2e4389ad28) Thanks [@PuruVJ](https://github.com/PuruVJ)! - Long joins are cons strings, so building a string in a loop counts as linear, not quadratic.
