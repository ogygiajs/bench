# Steps to ms, with a range: held-out evaluation

Written by `heisenbench calibrate ranges --md calibration/ranges.md` (docs/calibration.md, "Ranges"). ranges.json v1: training data 1 (`9f6b31fc8689c8ad`), 950 timed sides, seed 1; 120 trees of depth 3 per quantile. A call's 10-90% range is widened by 0.06790063 (log), a change's is its estimate times and over 7.69.

Every number below is held out: a model trained without the group predicts it.

## Held out by change

102 groups in 5 folds, 950 timed sides.

| Estimate | Median abs error | Median log error | Mean log error | Inside 10-90% | Median width |
| --- | ---: | ---: | ---: | ---: | ---: |
| weights.json (today) | 59.8 µs | 0.655 | 0.966 | 58% | 5.50x |
| linear part alone, refitted | 41.3 µs | 0.314 | 0.601 | 74% | 2.91x |
| model, from counts (as reports use it) | 16.3 µs | 0.077 | 0.298 | 85% | 2.15x |
| model, with engine health and input size | 17.1 µs | 0.081 | 0.297 | 87% | 2.16x |

Changes: the 76 pairs whose time moved beyond noise, the estimate of PR minus base against the measured change.

| Estimate | Median error | Right sign | Inside the range | Median width |
| --- | ---: | ---: | ---: | ---: |
| weights.json (today) | 76% | 100% | 36% | 5.50x |
| linear part alone, refitted | 75% | 95% | 28% | 2.86x |
| model, from counts (as reports use it) | 43% | 100% | 80% | 27.39x |
| model, with engine health and input size | 43% | 100% | 80% | 27.39x |

By source:

| Group | Sides | Model inside | With engine inside | Linear inside | Weights inside | Model log error | Linear log error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| history | 528 | 82% | 86% | 59% | 67% | 0.216 | 0.584 |
| planted | 422 | 88% | 89% | 91% | 46% | 0.028 | 0.194 |

By input size:

| Group | Sides | Model inside | With engine inside | Linear inside | Weights inside | Model log error | Linear log error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| under 100 | 194 | 91% | 93% | 88% | 21% | 0.043 | 0.322 |
| 100 to 1K | 130 | 85% | 88% | 85% | 72% | 0.026 | 0.152 |
| 1K to 10K | 260 | 87% | 87% | 88% | 83% | 0.047 | 0.201 |
| 10K to 100K | 204 | 77% | 79% | 52% | 57% | 0.386 | 0.659 |
| 100K or more | 136 | 80% | 87% | 41% | 49% | 0.301 | 0.648 |
| unknown | 26 | 100% | 100% | 100% | 58% | 0.340 | 0.085 |

By unit kind (the group holding most of the steps):

| Group | Sides | Model inside | With engine inside | Linear inside | Weights inside | Model log error | Linear log error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| alloc | 56 | 86% | 86% | 88% | 4% | 0.015 | 0.303 |
| arith | 96 | 100% | 100% | 100% | 0% | 0.045 | 0.071 |
| bi_array | 256 | 85% | 86% | 89% | 95% | 0.027 | 0.190 |
| bi_json | 60 | 95% | 98% | 7% | 27% | 0.147 | 1.872 |
| bi_map | 12 | 67% | 100% | 17% | 8% | 2.673 | 4.247 |
| bi_regexp | 106 | 75% | 75% | 74% | 62% | 0.330 | 0.448 |
| bi_string | 110 | 85% | 89% | 77% | 80% | 0.097 | 0.354 |
| call | 98 | 85% | 90% | 67% | 82% | 0.177 | 0.614 |
| control | 68 | 76% | 76% | 47% | 78% | 0.348 | 0.430 |
| loop | 88 | 82% | 84% | 67% | 0% | 0.151 | 0.364 |

By measured time:

| Group | Sides | Model inside | With engine inside | Linear inside | Weights inside | Model log error | Linear log error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| under 1 µs | 78 | 87% | 87% | 86% | 0% | 0.044 | 0.129 |
| 1 to 10 µs | 46 | 80% | 80% | 83% | 2% | 0.056 | 0.063 |
| 10 to 100 µs | 217 | 86% | 90% | 75% | 68% | 0.063 | 0.365 |
| 100 µs to 1 ms | 456 | 83% | 85% | 65% | 63% | 0.153 | 0.431 |
| 1 ms or more | 153 | 90% | 90% | 88% | 75% | 0.061 | 0.306 |

By load average while timed:

| Group | Sides | Model inside | With engine inside | Linear inside | Weights inside | Model log error | Linear log error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| under 10 | 36 | 86% | 86% | 56% | 61% | 0.082 | 0.656 |
| 10 to 12 | 510 | 87% | 88% | 76% | 53% | 0.061 | 0.303 |
| 12 to 14 | 326 | 80% | 84% | 69% | 72% | 0.146 | 0.357 |
| 14 or more | 78 | 90% | 95% | 87% | 27% | 0.055 | 0.117 |

## Held out by code

16 groups in 5 folds, 950 timed sides.

| Estimate | Median abs error | Median log error | Mean log error | Inside 10-90% | Median width |
| --- | ---: | ---: | ---: | ---: | ---: |
| weights.json (today) | 59.8 µs | 0.655 | 0.966 | 58% | 5.50x |
| linear part alone, refitted | 88.1 µs | 0.547 | 0.835 | 50% | 2.71x |
| model, from counts (as reports use it) | 82.0 µs | 0.412 | 0.734 | 94% | 86.26x |
| model, with engine health and input size | 82.2 µs | 0.408 | 0.731 | 94% | 86.39x |

Changes: the 76 pairs whose time moved beyond noise, the estimate of PR minus base against the measured change.

| Estimate | Median error | Right sign | Inside the range | Median width |
| --- | ---: | ---: | ---: | ---: |
| weights.json (today) | 76% | 100% | 36% | 5.50x |
| linear part alone, refitted | 67% | 95% | 24% | 2.71x |
| model, from counts (as reports use it) | 37% | 100% | 91% | 210.55x |
| model, with engine health and input size | 37% | 100% | 91% | 210.55x |

By source:

| Group | Sides | Model inside | With engine inside | Linear inside | Weights inside | Model log error | Linear log error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| history | 528 | 89% | 89% | 37% | 67% | 0.661 | 0.699 |
| planted | 422 | 100% | 100% | 65% | 46% | 0.238 | 0.262 |

By input size:

| Group | Sides | Model inside | With engine inside | Linear inside | Weights inside | Model log error | Linear log error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| under 100 | 194 | 98% | 98% | 28% | 21% | 0.373 | 1.018 |
| 100 to 1K | 130 | 94% | 94% | 82% | 72% | 0.261 | 0.058 |
| 1K to 10K | 260 | 100% | 100% | 67% | 83% | 0.253 | 0.237 |
| 10K to 100K | 204 | 99% | 99% | 43% | 57% | 0.610 | 0.724 |
| 100K or more | 136 | 88% | 88% | 38% | 49% | 0.792 | 0.995 |
| unknown | 26 | 0% | 0% | 0% | 58% | 3.976 | 3.211 |

By unit kind (the group holding most of the steps):

| Group | Sides | Model inside | With engine inside | Linear inside | Weights inside | Model log error | Linear log error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| alloc | 56 | 100% | 100% | 75% | 4% | 0.866 | 0.738 |
| arith | 96 | 100% | 100% | 0% | 0% | 0.090 | 1.094 |
| bi_array | 256 | 100% | 100% | 80% | 95% | 0.255 | 0.054 |
| bi_json | 60 | 100% | 100% | 7% | 27% | 1.300 | 1.840 |
| bi_map | 12 | 17% | 17% | 17% | 8% | 3.432 | 4.444 |
| bi_regexp | 106 | 70% | 70% | 37% | 62% | 1.111 | 0.944 |
| bi_string | 110 | 91% | 91% | 42% | 80% | 0.378 | 0.337 |
| call | 98 | 100% | 100% | 43% | 82% | 0.618 | 0.461 |
| control | 68 | 100% | 100% | 53% | 78% | 0.515 | 0.514 |
| loop | 88 | 95% | 95% | 65% | 0% | 0.301 | 0.263 |

By measured time:

| Group | Sides | Model inside | With engine inside | Linear inside | Weights inside | Model log error | Linear log error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| under 1 µs | 78 | 100% | 100% | 51% | 0% | 0.063 | 0.263 |
| 1 to 10 µs | 46 | 91% | 91% | 13% | 2% | 0.087 | 1.021 |
| 10 to 100 µs | 217 | 100% | 100% | 51% | 68% | 0.310 | 0.501 |
| 100 µs to 1 ms | 456 | 89% | 89% | 44% | 63% | 0.579 | 0.676 |
| 1 ms or more | 153 | 100% | 100% | 75% | 75% | 0.522 | 0.386 |

By load average while timed:

| Group | Sides | Model inside | With engine inside | Linear inside | Weights inside | Model log error | Linear log error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| under 10 | 36 | 94% | 94% | 28% | 61% | 0.584 | 0.839 |
| 10 to 12 | 510 | 96% | 96% | 55% | 53% | 0.403 | 0.469 |
| 12 to 14 | 326 | 91% | 91% | 52% | 72% | 0.509 | 0.496 |
| 14 or more | 78 | 92% | 92% | 12% | 27% | 0.147 | 1.096 |
