# Steps to ms, with a range: held-out evaluation

Written by `heisenbench calibrate ranges --md calibration/ranges.md` (docs/calibration.md, "Ranges"). ranges.json v2: training data 2 (`24b42d6bd93c6749`), 950 timed sides, seed 1; 120 trees of depth 3 per quantile. A call's 10-90% range is widened by 0.0307099 (log), a change's is its estimate times and over 6.13.

Every number below is held out: a model trained without the group predicts it.

## Held out by change

102 groups in 5 folds, 950 timed sides.

| Estimate | Median abs error | Median log error | Mean log error | Inside 10-90% | Median width |
| --- | ---: | ---: | ---: | ---: | ---: |
| weights.json (today) | 100.7 µs | 0.828 | 1.136 | 57% | 5.50x |
| linear part alone, refitted | 30.0 µs | 0.216 | 0.489 | 75% | 3.28x |
| model, from counts (as reports use it) | 9.5 µs | 0.046 | 0.233 | 86% | 1.63x |
| model, with engine health and input size | 9.5 µs | 0.046 | 0.232 | 87% | 1.64x |

Changes: the 92 pairs whose time moved beyond noise, the estimate of PR minus base against the measured change.

| Estimate | Median error | Right sign | Inside the range | Median width |
| --- | ---: | ---: | ---: | ---: |
| weights.json (today) | 86% | 100% | 33% | 5.50x |
| linear part alone, refitted | 29% | 96% | 58% | 3.18x |
| model, from counts (as reports use it) | 36% | 100% | 83% | 13.26x |
| model, with engine health and input size | 36% | 100% | 83% | 13.26x |

By source:

| Group | Sides | Model inside | With engine inside | Linear inside | Weights inside | Model log error | Linear log error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| history | 528 | 84% | 86% | 63% | 65% | 0.111 | 0.454 |
| planted | 422 | 89% | 89% | 90% | 47% | 0.023 | 0.131 |

By input size:

| Group | Sides | Model inside | With engine inside | Linear inside | Weights inside | Model log error | Linear log error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| under 100 | 220 | 94% | 94% | 89% | 18% | 0.015 | 0.139 |
| 100 to 1K | 130 | 90% | 90% | 84% | 75% | 0.048 | 0.115 |
| 1K to 10K | 260 | 87% | 88% | 87% | 83% | 0.033 | 0.136 |
| 10K to 100K | 204 | 78% | 80% | 56% | 50% | 0.191 | 0.557 |
| 100K or more | 136 | 80% | 85% | 51% | 65% | 0.203 | 0.616 |

By unit kind (the group holding most of the steps):

| Group | Sides | Model inside | With engine inside | Linear inside | Weights inside | Model log error | Linear log error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| alloc | 56 | 88% | 88% | 80% | 2% | 0.025 | 0.690 |
| arith | 96 | 100% | 100% | 100% | 0% | 0.006 | 0.063 |
| bi_array | 214 | 89% | 89% | 94% | 99% | 0.043 | 0.106 |
| bi_json | 66 | 83% | 83% | 36% | 33% | 0.312 | 1.070 |
| bi_map | 12 | 67% | 67% | 0% | 0% | 1.729 | 3.694 |
| bi_regexp | 154 | 87% | 87% | 78% | 47% | 0.077 | 0.240 |
| bi_string | 62 | 92% | 94% | 65% | 68% | 0.031 | 0.557 |
| call | 98 | 84% | 87% | 69% | 80% | 0.165 | 0.456 |
| control | 104 | 72% | 77% | 62% | 94% | 0.048 | 0.387 |
| loop | 88 | 81% | 85% | 65% | 20% | 0.309 | 0.445 |

By measured time:

| Group | Sides | Model inside | With engine inside | Linear inside | Weights inside | Model log error | Linear log error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| under 1 µs | 78 | 91% | 91% | 86% | 3% | 0.009 | 0.083 |
| 1 to 10 µs | 50 | 86% | 86% | 72% | 8% | 0.010 | 0.074 |
| 10 to 100 µs | 201 | 83% | 85% | 83% | 65% | 0.051 | 0.209 |
| 100 µs to 1 ms | 451 | 86% | 88% | 67% | 62% | 0.082 | 0.330 |
| 1 ms or more | 170 | 88% | 89% | 84% | 75% | 0.033 | 0.195 |

By load average while timed:

| Group | Sides | Model inside | With engine inside | Linear inside | Weights inside | Model log error | Linear log error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| under 3 | 618 | 85% | 87% | 68% | 54% | 0.051 | 0.330 |
| 3 to 10 | 332 | 88% | 89% | 89% | 63% | 0.038 | 0.128 |

## Held out by code

16 groups in 5 folds, 950 timed sides.

| Estimate | Median abs error | Median log error | Mean log error | Inside 10-90% | Median width |
| --- | ---: | ---: | ---: | ---: | ---: |
| weights.json (today) | 100.7 µs | 0.828 | 1.136 | 57% | 5.50x |
| linear part alone, refitted | 90.8 µs | 0.528 | 0.951 | 31% | 2.54x |
| model, from counts (as reports use it) | 129.9 µs | 0.639 | 0.900 | 87% | 28.58x |
| model, with engine health and input size | 127.7 µs | 0.658 | 0.902 | 87% | 28.60x |

Changes: the 92 pairs whose time moved beyond noise, the estimate of PR minus base against the measured change.

| Estimate | Median error | Right sign | Inside the range | Median width |
| --- | ---: | ---: | ---: | ---: |
| weights.json (today) | 86% | 100% | 33% | 5.50x |
| linear part alone, refitted | 86% | 100% | 17% | 2.52x |
| model, from counts (as reports use it) | 80% | 100% | 87% | 94.61x |
| model, with engine health and input size | 80% | 100% | 87% | 94.61x |

By source:

| Group | Sides | Model inside | With engine inside | Linear inside | Weights inside | Model log error | Linear log error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| history | 528 | 88% | 88% | 46% | 65% | 0.466 | 0.587 |
| planted | 422 | 86% | 86% | 14% | 47% | 0.956 | 0.421 |

By input size:

| Group | Sides | Model inside | With engine inside | Linear inside | Weights inside | Model log error | Linear log error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| under 100 | 220 | 62% | 62% | 8% | 18% | 1.604 | 1.965 |
| 100 to 1K | 130 | 92% | 92% | 15% | 75% | 0.946 | 0.368 |
| 1K to 10K | 260 | 99% | 99% | 33% | 83% | 0.483 | 0.335 |
| 10K to 100K | 204 | 99% | 99% | 53% | 50% | 0.357 | 0.588 |
| 100K or more | 136 | 79% | 79% | 50% | 65% | 0.438 | 0.697 |

By unit kind (the group holding most of the steps):

| Group | Sides | Model inside | With engine inside | Linear inside | Weights inside | Model log error | Linear log error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| alloc | 56 | 5% | 5% | 0% | 2% | 2.325 | 2.306 |
| arith | 96 | 100% | 100% | 0% | 0% | 1.408 | 1.964 |
| bi_array | 214 | 99% | 99% | 11% | 99% | 0.677 | 0.348 |
| bi_json | 66 | 100% | 100% | 33% | 33% | 0.557 | 0.996 |
| bi_map | 12 | 33% | 33% | 0% | 0% | 2.815 | 3.707 |
| bi_regexp | 154 | 83% | 83% | 47% | 47% | 0.356 | 0.597 |
| bi_string | 62 | 84% | 84% | 35% | 68% | 0.315 | 0.552 |
| call | 98 | 100% | 100% | 43% | 80% | 0.494 | 0.528 |
| control | 104 | 94% | 94% | 63% | 94% | 0.270 | 0.468 |
| loop | 88 | 75% | 75% | 57% | 20% | 0.233 | 0.432 |

By measured time:

| Group | Sides | Model inside | With engine inside | Linear inside | Weights inside | Model log error | Linear log error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| under 1 µs | 78 | 97% | 97% | 46% | 3% | 0.230 | 0.558 |
| 1 to 10 µs | 50 | 92% | 92% | 4% | 8% | 1.401 | 1.957 |
| 10 to 100 µs | 201 | 99% | 99% | 17% | 65% | 0.932 | 0.433 |
| 100 µs to 1 ms | 451 | 80% | 80% | 31% | 62% | 0.613 | 0.629 |
| 1 ms or more | 170 | 82% | 82% | 51% | 75% | 0.434 | 0.468 |

By load average while timed:

| Group | Sides | Model inside | With engine inside | Linear inside | Weights inside | Model log error | Linear log error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| under 3 | 618 | 88% | 88% | 37% | 54% | 0.551 | 0.713 |
| 3 to 10 | 332 | 84% | 84% | 21% | 63% | 0.799 | 0.377 |
