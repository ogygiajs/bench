# A sample PR comment

This is the comment a PR gets, from a real run. The PR is ogygia `c983461` plus one commit,
`100b74d`, that plants three lines in `match_one` (`packages/router/src/match.ts`):

```ts
let weight = 0;
for (let i = 0; i < c.pattern.length; i++) weight += c.pattern.charCodeAt(i);
if (weight < 0) return null;
```

It was run with `node suites/ogygia/src/cli.ts --sha 100b74d --base c983461` at Heisenbench `7b3d7a5`, on
an M4 Max with Node 26.4.0, on 2026-11-07, and the section below is that run's `result.json` as the
current code writes it (a recount at `4e20756` gives the same steps). It is what `upsert-comment.ts`
posts for the `heisenbench` section. On a real PR the app benchmark adds its `apps` section under it when
it finishes. The tables are aligned by this repository's formatter; they render the same.

---

<!-- ogygia-benchmarks -->

### ogygia benchmarks

<!-- section:heisenbench -->

#### Heisenbench: steps per function

`100b74d` against `c983461`, where it branched from its base: 2 of 11 bench files reach the files this PR changes. Steps are exact, so one run of each side decides.

<details><summary>Bench files run</summary>

- `packages/router/bench/dispatch.bench.ts`, reaching `packages/router/src/match.ts`
- `packages/router/bench/match.bench.ts`, reaching `packages/router/src/match.ts`

</details>

**2** functions changed in 2 case(s). Steps are exact counts, not timings.

| Case                                                  | Function                                   |                  Self steps |                             Δ | Δ allocs | Δ bytes | Δ inclusive |
| ----------------------------------------------------- | ------------------------------------------ | --------------------------: | ----------------------------: | -------: | ------: | ----------: |
| match_path: every request against a 300-route table   | `packages/router/src/match.ts > match_one` | 4,653,739.13 → 4,710,331.13 | +56,592 (+1.2%) ≈ +4,465.4 ns |        0 |       0 |     +56,592 |
| routes().fetch: forty requests across a 100-route API | `packages/router/src/match.ts > match_one` |     187,368.69 → 197,568.69 |   +10,200 (+5.4%) ≈ +803.9 ns |        0 |       0 |     +10,200 |

<details><summary>Where</summary>

| Case                                                  |          | Line                               | Δ steps | Δ allocs | Δ bytes |
| ----------------------------------------------------- | -------- | ---------------------------------- | ------: | -------: | ------: |
| match_path: every request against a 300-route table   | new code | `packages/router/src/match.ts:139` |    +210 |        0 |       0 |
| match_path: every request against a 300-route table   | new code | `packages/router/src/match.ts:140` | +55,962 |        0 |       0 |
| match_path: every request against a 300-route table   | new code | `packages/router/src/match.ts:141` |    +420 |        0 |       0 |
| routes().fetch: forty requests across a 100-route API | new code | `packages/router/src/match.ts:139` |     +40 |        0 |       0 |
| routes().fetch: forty requests across a 100-route API | new code | `packages/router/src/match.ts:140` | +10,080 |        0 |       0 |
| routes().fetch: forty requests across a 100-route API | new code | `packages/router/src/match.ts:141` |     +80 |        0 |       0 |

</details>

#### Engine

`match_path: every request against a 300-route table`:

- `packages/router/src/match.ts:140` new property read `charCodeAt` is polymorphic
- `packages/router/src/match.ts:140` new property read `length` is polymorphic

#### Growth

No case changed how its steps grow with input size.

<details><summary>Same growth, different steps at the largest size</summary>

- `match_path: every request against a 300-route table`: still linear, 1x the steps

</details>

#### Time (plain build, PR and base taking turns)

No case got slower or faster beyond noise (5 cases, 5 turns each).

<details><summary>Times</summary>

| Case                                                     | p50                                   | p99                                   | ops/s                                       | CPU/op                                |
| -------------------------------------------------------- | ------------------------------------- | ------------------------------------- | ------------------------------------------- | ------------------------------------- |
| `routes().fetch: forty requests across a 100-route API`  | ≈ 243.92–303.37 µs → 249.71–261.02 µs | ≈ 1.56–2.14 ms → 1.61–1.79 ms         | ≈ 3,195/s–3,977/s → 3,698/s–3,865/s         | ≈ 405.26–658.08 µs → 392.44–497.14 µs |
| `compile_all: a 300-route table`                         | ≈ 273.58–277.52 µs → 273.67–275.46 µs | ≈ 1.59–1.74 ms → 1.61–1.69 ms         | ≈ 3,519/s–3,560/s → 3,547/s–3,575/s         | ≈ 396.82–425.59 µs → 392.46–418.20 µs |
| `match_path: every request against a 300-route table`    | ≈ 1.13–1.21 ms → 1.11–1.18 ms         | ≈ 1.77–3.13 ms → 1.81–1.92 ms         | ≈ 791/s–861/s → 826/s–880/s                 | ≈ 1.18–1.42 ms → 1.18–1.28 ms         |
| `fill: the href of every link on a page`                 | ≈ 137.54–138.79 µs → 138.17–141.92 µs | ≈ 145.00–170.56 µs → 164.90–477.37 µs | ≈ 7,106/s–7,252/s → 6,997/s–7,211/s         | ≈ 140.22–142.99 µs → 140.41–146.33 µs |
| `make_ctx: the context of a request with a query string` | ≈ 5.38–5.71 µs → 5.42–5.50 µs         | ≈ 9.37–10.67 µs → 8.21–10.96 µs       | ≈ 173,675/s–182,730/s → 179,024/s–182,933/s | ≈ 9.91–14.16 µs → 9.72–13.27 µs       |

5 turns each, the side going first alternating. Each cell is the range over the turns, base → PR: ⚠️ worse beyond noise, `better` better beyond noise, ≈ within noise.

</details>
<!-- /section:heisenbench -->
