# Odds it shows on the clock

Steps are exact. Time is not, and a step change does not always show on the clock. In the quick
start, a second loop added 58% to a case's steps and the time layer saw nothing: the case runs in
84 ns, on the timer's grain, and the engine made the loop nearly free. A planted case with 12%
more steps from more `JSON.stringify` calls timed 14% slower at both of its sizes.

So next to each changed case, the PR comment gives the odds that the change shows up on the
clock:

```md
| Case | Steps | Δ | Odds it shows on the clock |
| --- | ---: | ---: | ---: |
| rank: twenty rows | 897 → 1,417 | +520 (+58.0%) | 57% |
```

"57%" means: of changes like this one (this big, in a case this big, in this kind of work), about
57 in 100 made the time layer say slower or faster beyond noise. It is a bet, from a small model
fitted on timed changes. The steps next to it are still the fact.

**Pass or fail never uses the odds.** The gate is the exact counts, as before. A step change at
5% odds is still listed, and one at 95% is not judged any harder.

## The odds come from a busy machine

The changes the model learned from were timed on one machine (Apple M4 Max, 16 cores, Node
26.4.0) while other jobs ran on it the whole time: the 1-minute load average was 7 to 20 (mean
12). A busy machine makes timings spread. The time layer's noise rule is cautious, so spread hides
real changes rather than inventing them: at least two real ogygia changes were plainly visible in
the samples (a 9.6% step cut timed 24% faster, a 158% step rise timed 49% slower) and the rule
still said "same".

What that means for the odds:

- They **lean low**. They answer "would the time layer have seen it on a busy machine". On a quiet
  machine, or with more timing rounds, more changes show, so read 40% as "at least 40%".
- They are about **this time layer's verdict**, not what a user feels in an app. A case that runs
  once per page load matters even if its 3% never clears the noise rule.
- They are from **one machine and one Node**. Another CPU or V8 can make a different kind of work
  cheap.

The model does see through some of the noise: held out, the two changes above got 58% and 99%,
though their labels say "same".

A quieter dataset (version 2) can replace this one. Retraining is one command, and the model file
names the dataset it was fitted on.

## What goes in

A case whose steps did not change gets no odds. For one whose steps did, seven numbers from the
two reports' counts:

| Feature         | What                                                                   |
| --------------- | ---------------------------------------------------------------------- |
| `steps_moved`   | how far the case's steps moved, either way: abs(ln(PR / base))         |
| `steps_size`    | the size of the case: log10 of the smaller side's steps                |
| `steps_delta`   | how many steps moved: log10 of abs(PR − base)                          |
| `faster`        | 1 when the PR does fewer steps                                         |
| `builtin_share` | the share of the change in priced built-ins (`JSON.stringify`, `sort`) |
| `call_share`    | the share in calls (a call is priced 4 steps and costs less time)      |
| `alloc_share`   | the share in allocations (`{}`, `[]`, `new`)                           |

The shares come from the units each report keeps, priced with the current prices (dataset v1 was
counted with prices v2; the model file names them). A report from before units were kept gets no
odds.

Tried and left out, because the held-out scores got worse with them: how far allocations, bytes
and calls moved, the engine health findings (worse and better), a share for string work, and the
input size (which a report does not have). 186 changed pairs are few for thirteen inputs. A
bigger dataset can bring them back. The function's real-cost weight is not in the dataset yet.

## The model

Logistic regression with an L2 penalty of 1, on the seven features standardized, fitted by
Newton's method (`src/models/logistic.ts`, no dependency). It is fitted on the 186 pairs of
dataset v1 whose steps changed; 76 of them were beyond noise.

**Held out.** The pairs are split into 5 folds by group: a group is one ogygia commit, or one
planted change at all its sizes, so no change is on both sides of a split. Each fold is predicted
by a model fitted on the other four. The baseline is "every step change shows": odds 1 for every
changed pair.

| Pairs                  | Odds                    |   AUC | Brier |
| ---------------------- | ----------------------- | ----: | ----: |
| 186 with a step change | this model              | 0.905 | 0.127 |
| 186 with a step change | every step change shows | 0.500 | 0.591 |
| all 475                | this model              | 0.974 | 0.050 |
| all 475                | every step change shows | 0.862 | 0.232 |

On "all 475", the 289 pairs with no step change get 0 from both; none of them was beyond noise.
AUC is the chance a change that showed gets higher odds than one that did not (0.5 is a coin).
Brier is the mean squared gap between the odds and what happened (0 is perfect). Over fold seeds
1 to 20, AUC is 0.878 to 0.936 and Brier 0.102 to 0.140.

**Reliability**: held-out odds against what the clock said.

| Odds        | Pairs | Mean odds | Showed on the clock |
| ----------- | ----: | --------: | ------------------: |
| 0% to 20%   |    80 |        8% |                  6% |
| 20% to 40%  |    24 |       29% |                 33% |
| 40% to 60%  |    33 |       50% |                 64% |
| 60% to 80%  |    15 |       72% |                 73% |
| 80% to 100% |    34 |       94% |                 91% |

The features and the penalty were picked on these same folds (mean over seeds 1 to 20), so the
scores above are a little better than a fresh dataset would give.

**Range.** The dataset's cases run from about 900 to 29 million steps. Odds for a case far
outside that are a stretch of the fit, not something it saw.

## Retraining

```bash
cd packages/heisenbench
node src/cli.ts feel train --data-version 1   # writes feel.json, prints the tables above
node src/cli.ts feel check                    # fits again: exit 1 unless the bytes are the same
```

`--seed` picks the folds of the held-out check (the fit itself uses every pair and no seed),
`--md file` writes the tables, `--data dir` reads the dataset from elsewhere. The same dataset and
seed give the same `feel.json`, byte for byte: Newton's method has no random start, and the file
keeps six significant digits. `feel.json` (about 2 KB) is committed and ships with the package; it
names its dataset version and the hash of both dataset files.
[calibration/data/training.md](../calibration/data/training.md) has the dataset and how to
regenerate it.
